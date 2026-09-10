/**
 * Public product reviews.
 *
 * The PDP has had a reviews tab since launch with nothing behind it. It used to render two
 * hardcoded reviews — the same invented pair on every product, driving the star average and the
 * count — which was removed as India CCPA dark-patterns exposure. That left the component with
 * no data source at all: `reviews` had full admin CRUD and no storefront read.
 *
 * Only `status = 'published'` is ever returned. Moderation is the whole point of the column, and
 * a public endpoint that leaked `pending` would make the moderation queue decorative.
 * `authorName` is the only identifying field exposed — never the customer id or email.
 */

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok } from '../../lib/http.js';
import * as service from './reviews.service.js';

export const reviewsRouter: Router = Router();

const handleParam = z.object({
  handle: z.string().min(1).describe('`products.handle`, as used by `GET /v1/products/{handle}`.'),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(10),
  sort: z
    .enum(['recent', 'rating_desc', 'rating_asc', 'featured'])
    .default('recent')
    .describe('`featured` floats editor-picked reviews to the top, then falls back to recent.'),
});

const reviewItem = z.object({
  id: z.uuid(),
  authorName: z.string().describe('Display name only. The customer id is never exposed.'),
  rating: z.number().int().min(1).max(5),
  title: z.string().nullable(),
  body: z.string().nullable(),
  isFeatured: z.boolean(),
  /** The date the customer wrote it, not the date a moderator approved it. */
  submittedAt: z.string(),
});

const summary = z.object({
  /** Recomputed from published reviews only, so it agrees with the list below it. */
  ratingAvg: z.number().nullable().describe('Mean rating across published reviews, or null.'),
  reviewCount: z.number().int().describe('Number of published reviews.'),
  /** Index 0 is the count of 1-star reviews, index 4 of 5-star. Drives the histogram. */
  distribution: z.array(z.number().int()).length(5),
});

defineRoute(reviewsRouter, {
  method: 'get',
  path: '/v1/products/:handle/reviews',
  surface: 'storefront',
  operationId: 'listProductReviews',
  summary: 'Published reviews for a product',
  description:
    'Paginated list of moderated reviews, plus a summary carrying the average, the count and a ' +
    'five-bucket distribution for the histogram.\n\n' +
    'Only `published` reviews are returned — `pending` and `rejected` are never public. The ' +
    'summary is computed from the same published set, so it can never disagree with the list. ' +
    'A product with no reviews yet returns an empty array and a null average; render an empty ' +
    'state rather than inventing anything.',
  tags: ['Catalogue'],
  auth: 'public',
  request: { params: handleParam, query: listQuery },
  responses: {
    200: {
      description: 'Published reviews and their summary.',
      schema: z.object({ summary, items: z.array(reviewItem) }),
    },
    404: { description: 'No such product.' },
  },
  handler: async ({ params, query }) => ok(await service.listForProduct(params.handle, query)),
});
