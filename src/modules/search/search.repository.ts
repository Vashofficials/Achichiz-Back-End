/**
 * Search queries. Matching is `tsvector`, fuzziness is `pg_trgm`, and both are
 * index-backed — see `db/migrations/0002_search.sql`.
 *
 * This repository deliberately returns product IDs and scores rather than
 * product rows: hydrating a product summary is the catalogue's job and is
 * already written once, in `catalogue.repository.ts`. Duplicating that
 * projection here would give search its own quietly-diverging idea of what a
 * price or a stock level is.
 */

import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { collections, productCollections, products } from '../../db/schema/index.js';
import {
  BEST_SELLER_BOOST,
  FUZZY_WEIGHT,
  MATCH_BODY,
  MATCH_EXACT,
  MATCH_PREFIX,
  buildTsQuery,
  likeContains,
  likePrefix,
  trigramTarget,
} from './search.query.js';

export type SearchFilters = {
  q: string;
  types?: string[] | undefined;
  minPricePaise?: number | undefined;
  maxPricePaise?: number | undefined;
};

export type SortSpec = { field: string; direction: 'asc' | 'desc' };
export type Page = { limit: number; offset: number };

/* ---------------------------------------------------- shared expressions */

const productIsLive: SQL = sql`${products.status} = 'active'
  AND ${products.deletedAt} IS NULL
  AND ${products.publishedAt} IS NOT NULL
  AND ${products.publishedAt} <= now()`;

const minPricePaise = sql<number>`coalesce((
  SELECT min(v.price_paise) FROM product_variants v
  WHERE v.product_id = ${products.id} AND v.status = 'active' AND v.deleted_at IS NULL
), 0)`;

/**
 * Must stay expression-identical to `idx_products_fts_wide` in 0002_search.sql,
 * or Postgres will not use the index.
 */
const searchDocument: SQL = sql`to_tsvector('english',
  coalesce(${products.title}, '') || ' ' ||
  coalesce(${products.subtitle}, '') || ' ' ||
  coalesce(${products.description}, '') || ' ' ||
  array_to_string(${products.tags}, ' '))`;

/** Matches `idx_products_search_trgm` in 0001_initial.sql. */
const trigramSubject: SQL = sql`(${products.title} || ' ' || coalesce(${products.subtitle}, ''))`;

const isBestSeller: SQL = sql`EXISTS (
  SELECT 1 FROM product_collections pc
  JOIN collections c ON c.id = pc.collection_id
  WHERE pc.product_id = ${products.id} AND c.handle = 'best-sellers' AND c.deleted_at IS NULL
)`;

/**
 * Matched when the full-text query hits OR the title is within trigram distance.
 *
 * The `%` operator is what buys typo tolerance ("chcoolate" → "chocolate") and
 * it is GIN-accelerated. Its cut-off is `pg_trgm.similarity_threshold`,
 * PostgreSQL's default 0.3 — deliberately not overridden here, because that is
 * session state and this pool is shared.
 */
function matchPredicate(filters: SearchFilters): SQL {
  const tsq = buildTsQuery(filters.q);
  const subject = trigramTarget(filters.q);

  return tsq
    ? sql`(${searchDocument} @@ to_tsquery('english', ${tsq}) OR ${trigramSubject} % ${subject})`
    : sql`(${trigramSubject} % ${subject})`;
}

/** Relevance, carrying over the storefront's exact/prefix/body weighting. */
function relevanceScore(filters: SearchFilters): SQL<number> {
  const tsq = buildTsQuery(filters.q);
  const subject = trigramTarget(filters.q);

  const textRank = tsq
    ? sql`ts_rank(${searchDocument}, to_tsquery('english', ${tsq})) * ${MATCH_EXACT}`
    : sql`0`;

  return sql<number>`(
    ${textRank}
    + CASE WHEN lower(${products.title}) LIKE ${likePrefix(filters.q)} THEN ${MATCH_PREFIX} ELSE 0 END
    + CASE WHEN lower(${products.title}) LIKE ${likeContains(filters.q)} THEN ${MATCH_BODY} ELSE 0 END
    + similarity(${trigramSubject}, ${subject}) * ${FUZZY_WEIGHT}
    + CASE WHEN ${isBestSeller} THEN ${BEST_SELLER_BOOST} ELSE 0 END
  )::float8`;
}

function whereFor(filters: SearchFilters, priceWindow?: { min: number; max: number | null }): SQL {
  const parts: SQL[] = [productIsLive, matchPredicate(filters)];

  if (filters.types && filters.types.length > 0) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM product_collections pc
      JOIN collections c ON c.id = pc.collection_id
      WHERE pc.product_id = ${products.id} AND c.kind = 'category'
        AND c.handle = ANY(${filters.types})
        AND c.status = 'live' AND c.deleted_at IS NULL
    )`);
  }
  if (filters.minPricePaise !== undefined) {
    parts.push(sql`${minPricePaise} >= ${filters.minPricePaise}`);
  }
  if (filters.maxPricePaise !== undefined) {
    parts.push(sql`${minPricePaise} <= ${filters.maxPricePaise}`);
  }
  if (priceWindow) {
    parts.push(sql`${minPricePaise} >= ${priceWindow.min}`);
    if (priceWindow.max !== null) parts.push(sql`${minPricePaise} < ${priceWindow.max}`);
  }

  return sql.join(parts, sql` AND `);
}

/* ------------------------------------------------------------- searching */

export async function searchProductIds(
  filters: SearchFilters,
  sort: SortSpec,
  page: Page,
): Promise<{ ids: string[]; total: number }> {
  const where = whereFor(filters);
  const score = relevanceScore(filters);

  // `relevance` is always best-first — an ascending relevance sort is worst-first,
  // which no shopper has ever wanted.
  const ordering =
    sort.field === 'price'
      ? [sort.direction === 'asc' ? asc(minPricePaise) : desc(minPricePaise)]
      : sort.field === 'publishedAt'
        ? [sort.direction === 'asc' ? asc(products.publishedAt) : desc(products.publishedAt)]
        : [desc(score)];

  const [rows, totals] = await Promise.all([
    db
      .select({ id: products.id })
      .from(products)
      .where(where)
      .orderBy(...ordering, asc(products.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(products)
      .where(where),
  ]);

  return { ids: rows.map((r) => r.id), total: totals[0]?.total ?? 0 };
}

/** Autocomplete: title-prefix hits first, then fuzzy, then popularity. */
export async function autocompleteProductIds(q: string, limit: number): Promise<string[]> {
  const filters: SearchFilters = { q };
  const subject = trigramTarget(q);

  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(whereFor(filters))
    .orderBy(
      desc(sql`CASE WHEN lower(${products.title}) LIKE ${likePrefix(q)} THEN 1 ELSE 0 END`),
      desc(sql`similarity(${trigramSubject}, ${subject})`),
      desc(sql`coalesce((
        SELECT ps.units_sold_30d FROM product_stats ps WHERE ps.product_id = ${products.id}
      ), 0)`),
      asc(products.title),
    )
    .limit(limit);

  return rows.map((r) => r.id);
}

export async function countMatches(
  filters: SearchFilters,
  priceWindow?: { min: number; max: number | null },
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(products)
    .where(whereFor(filters, priceWindow));

  return rows[0]?.total ?? 0;
}

/** Category facets over the match set — "you'd find results if you looked in X". */
export async function typeFacets(
  filters: SearchFilters,
  limit: number,
): Promise<{ handle: string; title: string; count: number }[]> {
  return db
    .select({
      handle: collections.handle,
      title: collections.title,
      count: sql<number>`count(DISTINCT ${products.id})::int`,
    })
    .from(products)
    .innerJoin(productCollections, eq(productCollections.productId, products.id))
    .innerJoin(
      collections,
      and(
        eq(collections.id, productCollections.collectionId),
        eq(collections.kind, 'category'),
        eq(collections.status, 'live'),
        isNull(collections.deletedAt),
      ),
    )
    .where(whereFor({ q: filters.q }))
    .groupBy(collections.handle, collections.title)
    .orderBy(desc(sql`count(DISTINCT ${products.id})`), asc(collections.title))
    .limit(limit);
}

/** Popular gifts, for when the query matches nothing at all. */
export async function fallbackProductIds(limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(productIsLive)
    .orderBy(
      desc(isBestSeller),
      desc(sql`coalesce((
        SELECT ps.units_sold_30d FROM product_stats ps WHERE ps.product_id = ${products.id}
      ), 0)`),
      desc(products.publishedAt),
    )
    .limit(limit);

  return rows.map((r) => r.id);
}

/* ---------------------------------------------------------- did you mean */

export type TermCorrection = { term: string; known: boolean; suggestion: string | null };

/**
 * Per-term spelling check against `search_vocabulary` (0002_search.sql), the
 * materialised distinct-lexeme list of the live catalogue. A term already in the
 * vocabulary is left alone; anything else gets its nearest trigram neighbour,
 * ties broken by how many products contain it.
 */
export async function correctTerms(terms: string[]): Promise<TermCorrection[]> {
  if (terms.length === 0) return [];

  const result = await db.execute<TermCorrection>(sql`
    SELECT
      t.term AS term,
      EXISTS (SELECT 1 FROM search_vocabulary v WHERE v.word = t.term) AS known,
      (
        SELECT v.word FROM search_vocabulary v
        WHERE v.word % t.term AND v.word <> t.term
        ORDER BY similarity(v.word, t.term) DESC, v.ndoc DESC, v.word ASC
        LIMIT 1
      ) AS suggestion
    FROM unnest(${terms}::text[]) AS t(term)
  `);

  return [...result.rows];
}
