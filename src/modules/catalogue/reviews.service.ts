/**
 * Public review reads.
 *
 * The summary is derived from the same `status = 'published'` set as the list, deliberately:
 * `products.rating_avg` is a denormalised column that can lag moderation, and a star average
 * that disagrees with the reviews printed under it is the kind of detail customers notice and
 * stop trusting the rest of the page over.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { products, reviews } from '../../db/schema/index.js';
import { NotFoundError } from '../../lib/errors.js';

export type ReviewSort = 'recent' | 'rating_desc' | 'rating_asc' | 'featured';

export type ListReviewsQuery = {
  page: number;
  perPage: number;
  sort: ReviewSort;
};

const publishedOnly = (productId: string) =>
  and(eq(reviews.productId, productId), eq(reviews.status, 'published'), isNull(reviews.deletedAt));

export async function listForProduct(handle: string, query: ListReviewsQuery) {
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.handle, handle), isNull(products.deletedAt)))
    .limit(1);

  if (!product) throw new NotFoundError('Product', handle);

  // One pass for the summary: count, mean, and the five histogram buckets. Doing this in SQL
  // rather than over the page keeps it correct regardless of pagination.
  const [stats] = await db
    .select({
      count: sql<number>`count(*)::int`,
      avg: sql<number | null>`avg(${reviews.rating})::float`,
      r1: sql<number>`count(*) filter (where ${reviews.rating} = 1)::int`,
      r2: sql<number>`count(*) filter (where ${reviews.rating} = 2)::int`,
      r3: sql<number>`count(*) filter (where ${reviews.rating} = 3)::int`,
      r4: sql<number>`count(*) filter (where ${reviews.rating} = 4)::int`,
      r5: sql<number>`count(*) filter (where ${reviews.rating} = 5)::int`,
    })
    .from(reviews)
    .where(publishedOnly(product.id));

  const orderBy = {
    recent: [desc(reviews.submittedAt)],
    rating_desc: [desc(reviews.rating), desc(reviews.submittedAt)],
    rating_asc: [asc(reviews.rating), desc(reviews.submittedAt)],
    featured: [desc(reviews.isFeatured), desc(reviews.submittedAt)],
  }[query.sort];

  const rows = await db
    .select({
      id: reviews.id,
      authorName: reviews.authorName,
      rating: reviews.rating,
      title: reviews.title,
      body: reviews.body,
      isFeatured: reviews.isFeatured,
      submittedAt: reviews.submittedAt,
    })
    .from(reviews)
    .where(publishedOnly(product.id))
    .orderBy(...orderBy)
    .limit(query.perPage)
    .offset((query.page - 1) * query.perPage);

  return {
    summary: {
      // Round to one decimal — the UI shows "4.3", and an unrounded float renders as 4.333….
      ratingAvg: stats?.avg == null ? null : Math.round(stats.avg * 10) / 10,
      reviewCount: stats?.count ?? 0,
      distribution: [stats?.r1 ?? 0, stats?.r2 ?? 0, stats?.r3 ?? 0, stats?.r4 ?? 0, stats?.r5 ?? 0],
    },
    items: rows.map((r) => ({
      id: r.id,
      authorName: r.authorName,
      rating: r.rating,
      title: r.title,
      body: r.body,
      isFeatured: r.isFeatured,
      submittedAt: r.submittedAt.toISOString(),
    })),
  };
}
