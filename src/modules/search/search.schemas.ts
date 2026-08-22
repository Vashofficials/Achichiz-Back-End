import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';
import { productSummary } from '../catalogue/catalogue.schemas.js';
import { MAX_QUERY_LENGTH } from './search.query.js';

/**
 * Search contracts.
 *
 * Search results are `productSummary` — the exact shape `listProducts` returns —
 * so a result card and a grid card are the same component on the frontend.
 */

const queryTerm = z
  .string()
  .trim()
  .min(1)
  .max(MAX_QUERY_LENGTH)
  .describe('The shopper’s raw query. Typos are tolerated; punctuation is ignored.');

export const searchListQuery = listQuery.extend({
  q: queryTerm,
  type: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Category handle(s) to restrict to. Repeat the parameter or comma-separate, ' +
        'e.g. `type=drinkware,candles`.',
    ),
  minPricePaise: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Inclusive lower price bound, integer paise.'),
  maxPricePaise: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Inclusive upper price bound, integer paise.'),
  sort: z
    .enum(['relevance', 'price', '-price', 'publishedAt', '-publishedAt'])
    .optional()
    .describe(
      'Ordering. `relevance` (the default) is always best-first. Prefix with `-` for ' +
        'descending, e.g. `-price` for dearest first.',
    ),
});

export const searchSuggestQuery = listQuery.extend({
  q: queryTerm,
  perPage: z.coerce
    .number()
    .int()
    .positive()
    .max(20)
    .default(6)
    .describe('Autocomplete rows to return. Maximum 20, default 6.'),
});

export const searchSuggestionsQuery = z.object({ q: queryTerm });

export const searchSuggestions = z.object({
  didYouMean: z
    .string()
    .nullable()
    .describe(
      'The query rewritten against catalogue vocabulary, or null when nothing was corrected. ' +
        'Render it as "Did you mean X?" — never search it silently.',
    ),
  unfilteredCount: z
    .number()
    .int()
    .describe('Matches for the query with every category and price filter dropped.'),
  types: z
    .array(
      z.object({
        handle: z.string().describe('Category collection handle.'),
        title: z.string().describe('Human label, e.g. `Drinkware`.'),
        count: z.number().int().describe('Matching products in this category.'),
      }),
    )
    .describe('Categories that do contain matches for the query, busiest first.'),
  priceRanges: z
    .array(
      z.object({
        minPaise: z.number().int().describe('Inclusive lower bound, integer paise.'),
        maxPaise: z
          .number()
          .int()
          .nullable()
          .describe('Exclusive upper bound, integer paise. Null means open-ended.'),
        count: z.number().int().describe('Matching products in this window.'),
      }),
    )
    .describe('Price windows that do contain matches, empty ones removed.'),
  fallback: z.array(productSummary).describe('Popular gifts to show when the query matches nothing at all.'),
});

export type SearchListQuery = z.infer<typeof searchListQuery>;
export type SearchSuggestQuery = z.infer<typeof searchSuggestQuery>;
export type SearchSuggestions = z.infer<typeof searchSuggestions>;
