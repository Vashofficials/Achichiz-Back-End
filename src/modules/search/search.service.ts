/**
 * Search orchestration.
 *
 * Nothing here is cached, by design. A cached search is a stale search: the
 * query space is unbounded, the hit rate is poor, and the one thing a shopper
 * notices is a product that is out of stock in the results and gone by the time
 * they click it. The catalogue's own reads are cached; this path is not.
 */

import { logger } from '../../config/logger.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import * as catalogue from '../catalogue/catalogue.service.js';
import type { ProductSummary } from '../catalogue/catalogue.schemas.js';
import * as repo from './search.repository.js';
import {
  PRICE_BUCKETS_PAISE,
  SEARCH_SORT_FALLBACK,
  SEARCH_SORT_FIELDS,
  assembleDidYouMean,
  tokenise,
} from './search.query.js';
import type { SearchListQuery, SearchSuggestQuery, SearchSuggestions } from './search.schemas.js';

/** Categories offered on the no-result screen. More than this is a wall, not a hint. */
const MAX_TYPE_SUGGESTIONS = 5;
/** Popular gifts shown when the query matches nothing at all. */
const FALLBACK_COUNT = 4;

function filtersOf(query: SearchListQuery): repo.SearchFilters {
  return {
    q: query.q,
    types: catalogue.toHandleList(query.type),
    minPricePaise: query.minPricePaise,
    maxPricePaise: query.maxPricePaise,
  };
}

export async function searchProducts(
  query: SearchListQuery,
): Promise<{ items: ProductSummary[]; total: number }> {
  const sort = parseSort(query.sort, SEARCH_SORT_FIELDS, SEARCH_SORT_FALLBACK);
  const { ids, total } = await repo.searchProductIds(filtersOf(query), sort, {
    limit: query.perPage,
    offset: offsetOf(query.page, query.perPage),
  });

  return { items: await catalogue.getProductsByIds(ids), total };
}

/** Header autocomplete. Same ranking bias as full search, capped and unpaginated. */
export async function suggest(
  query: SearchSuggestQuery,
): Promise<{ items: ProductSummary[]; total: number }> {
  const ids = await repo.autocompleteProductIds(query.q, query.perPage);
  const items = await catalogue.getProductsByIds(ids);
  return { items, total: items.length };
}

/**
 * "Did you mean X?" — each unknown term replaced by its nearest catalogue word.
 *
 * Depends on the `search_vocabulary` materialised view from
 * `0002_search.sql`. If that view is missing or mid-refresh the prompt is simply
 * not offered: a spelling hint is decoration, and taking down the no-result
 * screen over it would be a worse failure than not showing it.
 */
export async function didYouMean(q: string): Promise<string | null> {
  const terms = tokenise(q);
  if (terms.length === 0) return null;

  try {
    const corrections = await repo.correctTerms(terms);
    const map = new Map<string, string>();
    for (const row of corrections) {
      if (!row.known && row.suggestion) map.set(row.term, row.suggestion);
    }
    return assembleDidYouMean(terms, map);
  } catch (err) {
    logger.error({ err, q }, 'did-you-mean lookup failed; has 0002_search.sql been applied?');
    return null;
  }
}

/**
 * What a shopper could relax to see results: the categories and price windows
 * that do hold matches for their query, plus popular gifts if nothing does.
 *
 * Counts are computed with the category and price filters DROPPED — the whole
 * point is to describe what lies outside the filters currently applied.
 */
export async function suggestionsFor(q: string): Promise<SearchSuggestions> {
  const filters: repo.SearchFilters = { q };

  const [unfilteredCount, types, bucketCounts, correction] = await Promise.all([
    repo.countMatches(filters),
    repo.typeFacets(filters, MAX_TYPE_SUGGESTIONS),
    Promise.all(
      PRICE_BUCKETS_PAISE.map((bucket) =>
        repo.countMatches(filters, { min: bucket.minPaise, max: bucket.maxPaise }),
      ),
    ),
    didYouMean(q),
  ]);

  const priceRanges = PRICE_BUCKETS_PAISE.map((bucket, i) => ({
    minPaise: bucket.minPaise,
    maxPaise: bucket.maxPaise,
    count: bucketCounts[i] ?? 0,
  })).filter((b) => b.count > 0);

  const fallback =
    unfilteredCount > 0
      ? []
      : await catalogue.getProductsByIds(await repo.fallbackProductIds(FALLBACK_COUNT));

  return { didYouMean: correction, unfilteredCount, types, priceRanges, fallback };
}
