import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated, pageMeta } from '../../lib/http.js';
import { productSummary } from '../catalogue/catalogue.schemas.js';
import * as search from './search.service.js';
import {
  searchListQuery,
  searchSuggestQuery,
  searchSuggestions,
  searchSuggestionsQuery,
} from './search.schemas.js';

/**
 * Product search, served by PostgreSQL rather than by shipping the catalogue to
 * the browser. Typo tolerance and ranking live in `search.query.ts`; the index
 * definitions live in `db/migrations/0002_search.sql`.
 *
 * NO `rateLimit` IS DECLARED HERE, AND THAT IS DELIBERATE — do not add one back
 * without reading this first. These three endpoints WANT the tighter `search`
 * limiter (60/min rather than the blanket 120/min `app.ts` applies to `/v1`): a
 * search is heavier than a keyed lookup and is the obvious scraping target.
 *
 * It cannot be declared yet. `defineRoute` calls `namedLimiter()` at module load,
 * and `rate-limit-redis`'s store dials Redis as soon as it is constructed. So the
 * first route anywhere in this API that declares `rateLimit` makes
 * `npm run openapi:generate` — CI gate 1, which imports the whole route graph on
 * a machine with no Redis — crash with MaxRetriesPerRequestError. The generate
 * script's own comment ("both are lazy, so nothing connects") holds today only
 * because no route has needed a named limiter before.
 *
 * The fix belongs in `middleware/rate-limit.ts` (construct the limiter lazily on
 * first request, or skip the Redis store when `env.isTest`), which is outside
 * this module. Once that lands, add `rateLimit: 'search'` to all three routes.
 */
export const searchRouter: Router = Router();

defineRoute(searchRouter, {
  method: 'get',
  path: '/v1/search',
  surface: 'storefront',
  operationId: 'searchProducts',
  summary: 'Search products',
  description:
    'Full-text search with typo tolerance. Results are the same `productSummary` shape ' +
    '`listProducts` returns, so a result card and a grid card are one component. ' +
    'Ranking weights title matches over body matches and gives best sellers a small nudge. ' +
    'When `meta.total` is 0, call `getSearchSuggestions` for the recovery screen. ' +
    'Never cached — availability in results is as live as the PDP.',
  tags: ['Search'],
  auth: 'public',
  request: { query: searchListQuery },
  responses: {
    200: {
      description: 'A page of matching products, wrapped as `{ data, meta }`.',
      schema: z.array(productSummary),
    },
  },
  handler: async ({ query }) => {
    const { items, total } = await search.searchProducts(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(searchRouter, {
  method: 'get',
  path: '/v1/search/suggest',
  surface: 'storefront',
  operationId: 'suggestProducts',
  summary: 'Autocomplete products for the header search',
  description:
    'Fast prefix-biased lookup for the search-as-you-type dropdown. Title-prefix hits come ' +
    'first, then fuzzy matches, then popularity. Send at least two characters; shorter ' +
    'queries tokenise to nothing and return an empty page.',
  tags: ['Search'],
  auth: 'public',
  request: { query: searchSuggestQuery },
  responses: {
    200: {
      description: 'Up to `perPage` autocomplete matches, wrapped as `{ data, meta }`.',
      schema: z.array(productSummary),
    },
  },
  handler: async ({ query }) => {
    const { items, total } = await search.suggest(query);
    return paginated(items, pageMeta(total, 1, query.perPage));
  },
});

defineRoute(searchRouter, {
  method: 'get',
  path: '/v1/search/suggestions',
  surface: 'storefront',
  operationId: 'getSearchSuggestions',
  summary: 'Recovery hints for a search that returned nothing',
  description:
    'Everything the no-results screen needs, in one call: a "did you mean" rewrite, the ' +
    'number of matches once every filter is dropped, and the categories and price windows ' +
    'that do hold matches. `fallback` is populated only when the query matches nothing at ' +
    'all — that is the "here are some popular gifts instead" case.',
  tags: ['Search'],
  auth: 'public',
  request: { query: searchSuggestionsQuery },
  responses: {
    200: { description: 'Suggestions for relaxing or correcting the query.', schema: searchSuggestions },
  },
  handler: async ({ query }) => ok(await search.suggestionsFor(query.q)),
});
