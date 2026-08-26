/**
 * Drizzle queries for the storefront catalogue. No business rules, no HTTP.
 *
 * Everything a shopper sees about availability is DERIVED here, never stored:
 *   - `pricePaise`  = MIN(price) over the product's active variants
 *   - `stockQty`    = SUM(inventory_levels.available_qty) over those variants,
 *                     where `available_qty` is the generated column
 *                     (on_hand_qty - reserved_qty) — see db/schema/README.md
 *   - `sameDay`     = that stock exists in at least one same-day warehouse
 *
 * The correlated sub-selects below are deliberate: a single flat join over
 * variants × inventory × collections multiplies rows and makes every aggregate
 * wrong, and fixing it with DISTINCT costs more than the sub-selects do. Each
 * one is backed by an index declared in migrations/0001_initial.sql.
 */

import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../config/db.js';
import {
  addOns,
  builderStepOptions,
  builderTemplateSteps,
  builderTemplates,
  collections,
  deliveryZonePincodes,
  deliveryZones,
  designers,
  mediaAssets,
  personalisationTemplates,
  productAddOns,
  productCollections,
  productContentItems,
  productMedia,
  productPersonalisationTemplates,
  products,
  productVariants,
  seoEntries,
} from '../../db/schema/index.js';

/* ------------------------------------------------------------------ types */

export type MediaRow = {
  id: string;
  url: string;
  altText: string | null;
  position: number;
};

export type SeoRow = {
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  focusKeyword: string | null;
  robotsIndex: boolean;
  robotsFollow: boolean;
  ogImageUrl: string | null;
  structuredData: unknown;
};

export type ProductRow = {
  id: string;
  handle: string;
  sku: string | null;
  title: string;
  subtitle: string | null;
  description: string | null;
  kind: string;
  designerId: string | null;
  designerHandle: string | null;
  designerName: string | null;
  type: string | null;
  typeLabel: string | null;
  pricePaise: number;
  compareAtPaise: number | null;
  image: MediaRow | null;
  collectionHandles: string[];
  occasionHandles: string[];
  recipientHandles: string[];
  stockQty: number;
  lowStockThreshold: number;
  sameDay: boolean;
  bestSeller: boolean;
  isNew: boolean;
  personalisable: boolean;
  isPerishable: boolean;
  isFragile: boolean;
  tags: string[];
  ratingAvg: number | null;
  reviewCount: number;
  publishedAt: Date | null;
};

export type VariantRow = {
  id: string;
  sku: string;
  optionLabel: string;
  optionValue: string;
  pricePaise: number;
  compareAtPaise: number | null;
  weightGrams: number | null;
  isDefault: boolean;
  position: number;
  stockQty: number;
  lowStockThreshold: number;
};

export type AddOnRow = {
  id: string;
  code: string;
  name: string;
  kind: string;
  pricePaise: number;
  requiresInput: boolean;
  inputCharLimit: number | null;
  leadTimeHours: number;
};

export type PersonalisationTemplateRow = {
  id: string;
  name: string;
  method: string;
  turnaroundHours: number;
  charLimit: number | null;
  allowsImage: boolean;
  proofRequired: boolean;
  surchargePaise: number;
};

export type CollectionRow = {
  id: string;
  handle: string;
  kind: string;
  parentHandle: string | null;
  title: string;
  heading: string | null;
  subtext: string | null;
  seoDescription: string | null;
  image: MediaRow | null;
  curator: string | null;
  designerId: string | null;
  designerHandle: string | null;
  designerName: string | null;
  isFeatured: boolean;
  sortOrder: number;
  productCount: number;
};

export type DesignerRow = {
  id: string;
  handle: string;
  name: string;
  kind: string;
  bio: string | null;
  logo: MediaRow | null;
  productCount: number;
};

export type BuilderTemplateRow = {
  id: string;
  handle: string;
  name: string;
  basePricePaise: number;
  maxWeightGrams: number | null;
  stepCount: number;
};

export type BuilderStepRow = {
  id: string;
  position: number;
  title: string;
  note: string | null;
  stepKind: string;
  minChoices: number;
  maxChoices: number;
};

export type BuilderOptionRow = {
  id: string;
  stepId: string;
  label: string;
  pricePaise: number;
  weightGrams: number | null;
  position: number;
  inStock: boolean;
};

export type ServiceabilityRow = {
  pincode: string;
  isServiceable: boolean;
  codAllowed: boolean;
  city: string | null;
  stateCode: string | null;
  zoneName: string;
  tier: string | null;
  standardTatDays: number | null;
  supportsSameDay: boolean;
  supportsMidnight: boolean;
  supportsCod: boolean;
  sameDayCutoff: string | null;
  zoneStatus: string;
};

export type ProductFilters = {
  q?: string | undefined;
  collection?: string | undefined;
  types?: string[] | undefined;
  designer?: string | undefined;
  minPricePaise?: number | undefined;
  maxPricePaise?: number | undefined;
  inStock?: boolean | undefined;
  sameDay?: boolean | undefined;
  personalisable?: boolean | undefined;
};

export type SortSpec = { field: string; direction: 'asc' | 'desc' };
export type Page = { limit: number; offset: number };

/* ------------------------------------------------- shared SQL expressions */

/** Live to a shopper: active, not soft-deleted, and actually published by now. */
const productIsLive: SQL = sql`${products.status} = 'active'
  AND ${products.deletedAt} IS NULL
  AND ${products.publishedAt} IS NOT NULL
  AND ${products.publishedAt} <= now()`;

const minPricePaise = sql<number>`coalesce((
  SELECT min(v.price_paise) FROM product_variants v
  WHERE v.product_id = ${products.id} AND v.status = 'active' AND v.deleted_at IS NULL
), 0)`;

const stockQty = sql<number>`coalesce((
  SELECT sum(il.available_qty)::int
  FROM inventory_levels il
  JOIN product_variants v ON v.id = il.variant_id
  WHERE v.product_id = ${products.id} AND v.status = 'active' AND v.deleted_at IS NULL
), 0)`;

const sameDayCapable = sql<boolean>`EXISTS (
  SELECT 1 FROM inventory_levels il
  JOIN product_variants v ON v.id = il.variant_id
  JOIN warehouses w ON w.id = il.warehouse_id
  WHERE v.product_id = ${products.id} AND v.status = 'active' AND v.deleted_at IS NULL
    AND il.available_qty > 0 AND w.supports_same_day AND w.status = 'active' AND w.deleted_at IS NULL
)`;

const handlesOfKind = (kinds: string[] | null): SQL<string[]> => {
  // `sql.param` + an explicit cast, NOT a bare `${kinds}`. Drizzle expands a JS
  // array inside a template as a comma-separated tuple, so `ANY(${kinds})`
  // compiles to `ANY(($1, $2))` — a ROW constructor, which Postgres refuses to
  // compare against text. `sql.param` binds the whole array as one parameter.
  const filter = kinds ? sql`AND c.kind = ANY(${sql.param(kinds)}::text[])` : sql``;
  return sql<string[]>`coalesce((
    SELECT array_agg(DISTINCT c.handle)
    FROM product_collections pc
    JOIN collections c ON c.id = pc.collection_id
    WHERE pc.product_id = ${products.id}
      AND c.status = 'live' AND c.deleted_at IS NULL ${filter}
  ), '{}'::text[])`;
};

/**
 * The storefront `type` facet: the product's leading `kind='category'`
 * collection. `primary_collection_id` wins when it is itself a category,
 * otherwise the lowest merchandising position does. This is NOT `products.kind`,
 * which is the fulfilment class.
 */
const categoryFacet = (column: 'handle' | 'title'): SQL<string | null> =>
  sql<string | null>`(
    SELECT ${sql.raw(`c.${column}`)}
    FROM product_collections pc
    JOIN collections c ON c.id = pc.collection_id
    WHERE pc.product_id = ${products.id}
      AND c.kind = 'category' AND c.status = 'live' AND c.deleted_at IS NULL
    ORDER BY (c.id = ${products.primaryCollectionId}) DESC, pc.position, c.sort_order, c.handle
    LIMIT 1
  )`;

const primaryImage = sql<MediaRow | null>`(
  SELECT json_build_object(
    'id', m.id,
    'url', coalesce(m.cdn_url, m.url),
    'altText', coalesce(pm.alt_text, m.alt_text),
    'position', pm.position
  )
  FROM product_media pm
  JOIN media_assets m ON m.id = pm.media_id
  WHERE pm.product_id = ${products.id} AND m.deleted_at IS NULL
  ORDER BY pm.position, pm.id
  LIMIT 1
)`;

const defaultSku = sql<string | null>`(
  SELECT v.sku FROM product_variants v
  WHERE v.product_id = ${products.id} AND v.status = 'active' AND v.deleted_at IS NULL
  ORDER BY v.is_default DESC, v.position, v.sku
  LIMIT 1
)`;

const compareAtOfCheapest = sql<number | null>`(
  SELECT v.compare_at_paise FROM product_variants v
  WHERE v.product_id = ${products.id} AND v.status = 'active' AND v.deleted_at IS NULL
  ORDER BY v.price_paise, v.position
  LIMIT 1
)`;

/** Editorial override wins in both directions; otherwise collection membership. */
const bestSeller = sql<boolean>`(
  CASE WHEN ${products.badgeOverride} IS NOT NULL THEN ${products.badgeOverride} = 'best_seller'
  ELSE EXISTS (
    SELECT 1 FROM product_collections pc
    JOIN collections c ON c.id = pc.collection_id
    WHERE pc.product_id = ${products.id} AND c.handle = 'best-sellers' AND c.deleted_at IS NULL
  ) END
)`;

const isNew = sql<boolean>`(
  CASE WHEN ${products.badgeOverride} IS NOT NULL THEN ${products.badgeOverride} = 'new'
  ELSE ${products.publishedAt} >= now() - interval '30 days' END
)`;

const ratingAvg = sql<number | null>`(
  SELECT ps.rating_avg::float8 FROM product_stats ps WHERE ps.product_id = ${products.id}
)`;

const reviewCount = sql<number>`coalesce((
  SELECT ps.review_count FROM product_stats ps WHERE ps.product_id = ${products.id}
), 0)`;

const unitsSold30d = sql<number>`coalesce((
  SELECT ps.units_sold_30d FROM product_stats ps WHERE ps.product_id = ${products.id}
), 0)`;

const productSelection = {
  id: products.id,
  handle: products.handle,
  sku: defaultSku,
  title: products.title,
  subtitle: products.subtitle,
  description: products.description,
  kind: products.kind,
  designerId: products.designerId,
  designerHandle: designers.handle,
  designerName: designers.name,
  type: categoryFacet('handle'),
  typeLabel: categoryFacet('title'),
  pricePaise: minPricePaise,
  compareAtPaise: compareAtOfCheapest,
  image: primaryImage,
  collectionHandles: handlesOfKind(null),
  occasionHandles: handlesOfKind(['occasion', 'festival']),
  recipientHandles: handlesOfKind(['recipient']),
  stockQty,
  lowStockThreshold: products.lowStockThreshold,
  sameDay: sameDayCapable,
  bestSeller,
  isNew,
  personalisable: products.isPersonalisable,
  isPerishable: products.isPerishable,
  isFragile: products.isFragile,
  tags: products.tags,
  ratingAvg,
  reviewCount,
  publishedAt: products.publishedAt,
};

/** Every sortable product field, resolved to SQL. Keys mirror `PRODUCT_SORT_FIELDS`. */
const PRODUCT_ORDER: Record<string, SQL> = {
  price: minPricePaise,
  publishedAt: sql`${products.publishedAt}`,
  title: sql`${products.title}`,
  unitsSold: unitsSold30d,
  rating: sql`coalesce(${ratingAvg}, 0)`,
};

const orderBy = (map: Record<string, SQL>, sort: SortSpec, fallbackField: string): SQL[] => {
  const expr = map[sort.field] ?? map[fallbackField];
  const primary = expr ? [sort.direction === 'asc' ? asc(expr) : desc(expr)] : [];
  return primary;
};

/* ------------------------------------------------------------- predicates */

function productWhere(filters: ProductFilters): SQL {
  const parts: SQL[] = [productIsLive];

  if (filters.q) {
    const pattern = `%${filters.q}%`;
    parts.push(
      sql`(${products.title} ILIKE ${pattern}
        OR coalesce(${products.subtitle}, '') ILIKE ${pattern}
        OR coalesce(${products.description}, '') ILIKE ${pattern})`,
    );
  }

  if (filters.collection) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM product_collections pc
      JOIN collections c ON c.id = pc.collection_id
      WHERE pc.product_id = ${products.id} AND c.handle = ${filters.collection}
        AND c.status = 'live' AND c.deleted_at IS NULL
    )`);
  }

  if (filters.types && filters.types.length > 0) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM product_collections pc
      JOIN collections c ON c.id = pc.collection_id
      WHERE pc.product_id = ${products.id} AND c.kind = 'category'
        AND c.handle = ANY(${sql.param(filters.types)}::text[])
        AND c.status = 'live' AND c.deleted_at IS NULL
    )`);
  }

  if (filters.designer) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM designers d
      WHERE d.id = ${products.designerId} AND d.handle = ${filters.designer}
        AND d.status = 'active' AND d.deleted_at IS NULL
    )`);
  }

  if (filters.minPricePaise !== undefined) parts.push(sql`${minPricePaise} >= ${filters.minPricePaise}`);
  if (filters.maxPricePaise !== undefined) parts.push(sql`${minPricePaise} <= ${filters.maxPricePaise}`);
  if (filters.inStock) parts.push(sql`${stockQty} > 0`);
  if (filters.sameDay) parts.push(sameDayCapable);
  if (filters.personalisable) parts.push(sql`${products.isPersonalisable}`);

  return sql.join(parts, sql` AND `);
}

/* --------------------------------------------------------------- products */

export async function listProducts(
  filters: ProductFilters,
  sort: SortSpec,
  page: Page,
): Promise<{ rows: ProductRow[]; total: number }> {
  const where = productWhere(filters);

  const [rows, totals] = await Promise.all([
    db
      .select(productSelection)
      .from(products)
      .leftJoin(designers, eq(designers.id, products.designerId))
      .where(where)
      .orderBy(...orderBy(PRODUCT_ORDER, sort, 'publishedAt'), asc(products.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(products)
      .where(where),
  ]);

  return { rows: rows, total: totals[0]?.total ?? 0 };
}

export async function findProductByHandle(handle: string): Promise<ProductRow | null> {
  const rows = await db
    .select(productSelection)
    .from(products)
    .leftJoin(designers, eq(designers.id, products.designerId))
    .where(and(sql`${products.handle} = ${handle}`, productIsLive))
    .limit(1);

  return (rows[0] as ProductRow | undefined) ?? null;
}

/**
 * Hydrates a set of ids into full product summaries.
 *
 * Search ranks and paginates ids; this turns them back into products so there is
 * exactly one definition of what a product looks like on the storefront. Order
 * is NOT preserved here — the caller re-imposes its ranking.
 */
export async function listProductsByIds(ids: string[]): Promise<ProductRow[]> {
  if (ids.length === 0) return [];

  const rows = await db
    .select(productSelection)
    .from(products)
    .leftJoin(designers, eq(designers.id, products.designerId))
    .where(and(inArray(products.id, ids), productIsLive));

  return rows;
}

/** Price bounds across a filtered set — feeds the collection page's price slider. */
export async function priceBounds(filters: ProductFilters): Promise<{ minPaise: number; maxPaise: number }> {
  const rows = await db
    .select({
      minPaise: sql<number>`coalesce(min(${minPricePaise}), 0)::int`,
      maxPaise: sql<number>`coalesce(max(${minPricePaise}), 0)::int`,
    })
    .from(products)
    .where(productWhere(filters));

  return { minPaise: rows[0]?.minPaise ?? 0, maxPaise: rows[0]?.maxPaise ?? 0 };
}

/** Category facets present in a filtered set, with counts. */
export async function typeFacets(
  filters: ProductFilters,
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
    .where(productWhere(filters))
    .groupBy(collections.handle, collections.title, collections.sortOrder)
    .orderBy(asc(collections.sortOrder), asc(collections.title));
}

export async function listVariants(productId: string): Promise<VariantRow[]> {
  return db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      optionLabel: productVariants.optionLabel,
      optionValue: productVariants.optionValue,
      pricePaise: productVariants.pricePaise,
      compareAtPaise: productVariants.compareAtPaise,
      weightGrams: productVariants.weightGrams,
      isDefault: productVariants.isDefault,
      position: productVariants.position,
      stockQty: sql<number>`coalesce((
        SELECT sum(il.available_qty)::int FROM inventory_levels il
        WHERE il.variant_id = ${productVariants.id}
      ), 0)`,
      lowStockThreshold: products.lowStockThreshold,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(productVariants.productId, productId),
        eq(productVariants.status, 'active'),
        isNull(productVariants.deletedAt),
      ),
    )
    .orderBy(asc(productVariants.position), asc(productVariants.sku));
}

export async function listProductMedia(productId: string): Promise<MediaRow[]> {
  return db
    .select({
      id: mediaAssets.id,
      url: sql<string>`coalesce(${mediaAssets.cdnUrl}, ${mediaAssets.url})`,
      altText: sql<string | null>`coalesce(${productMedia.altText}, ${mediaAssets.altText})`,
      position: productMedia.position,
    })
    .from(productMedia)
    .innerJoin(mediaAssets, and(eq(mediaAssets.id, productMedia.mediaId), isNull(mediaAssets.deletedAt)))
    .where(eq(productMedia.productId, productId))
    .orderBy(asc(productMedia.position), asc(productMedia.id));
}

export async function listContentItems(productId: string): Promise<string[]> {
  const rows = await db
    .select({ body: productContentItems.body })
    .from(productContentItems)
    .where(eq(productContentItems.productId, productId))
    .orderBy(asc(productContentItems.position), asc(productContentItems.id));

  return rows.map((r) => r.body);
}

export async function listRelatedHandles(productId: string, limit: number): Promise<string[]> {
  const pcOther = alias(productCollections, 'pc_other');
  const other = alias(products, 'p_other');

  const rows = await db
    .select({ handle: other.handle, shared: sql<number>`count(*)::int` })
    .from(productCollections)
    .innerJoin(
      pcOther,
      and(
        eq(pcOther.collectionId, productCollections.collectionId),
        ne(pcOther.productId, productCollections.productId),
      ),
    )
    .innerJoin(other, eq(other.id, pcOther.productId))
    .where(
      and(
        eq(productCollections.productId, productId),
        eq(other.status, 'active'),
        isNull(other.deletedAt),
        sql`${other.publishedAt} IS NOT NULL AND ${other.publishedAt} <= now()`,
      ),
    )
    .groupBy(other.handle)
    .orderBy(desc(sql`count(*)`), asc(other.handle))
    .limit(limit);

  return rows.map((r) => r.handle);
}

/* ---------------------------------------------------------------- add-ons */

const addOnSelection = {
  id: addOns.id,
  code: addOns.code,
  name: addOns.name,
  kind: addOns.kind,
  requiresInput: addOns.requiresInput,
  inputCharLimit: addOns.inputCharLimit,
  leadTimeHours: addOns.leadTimeHours,
};

const ADD_ON_ORDER: Record<string, SQL> = {
  name: sql`${addOns.name}`,
  pricePaise: sql`${addOns.pricePaise}`,
  code: sql`${addOns.code}`,
};

const addOnIsLive = and(eq(addOns.status, 'active'), isNull(addOns.deletedAt)) as SQL;

export async function listAddOns(
  opts: { q?: string | undefined; kind?: string | undefined },
  sort: SortSpec,
  page: Page,
): Promise<{ rows: AddOnRow[]; total: number }> {
  const parts: SQL[] = [addOnIsLive];
  if (opts.q) parts.push(sql`${addOns.name} ILIKE ${`%${opts.q}%`}`);
  if (opts.kind) parts.push(sql`${addOns.kind} = ${opts.kind}`);
  const where = sql.join(parts, sql` AND `);

  const [rows, totals] = await Promise.all([
    db
      .select({ ...addOnSelection, pricePaise: addOns.pricePaise })
      .from(addOns)
      .where(where)
      .orderBy(...orderBy(ADD_ON_ORDER, sort, 'name'), asc(addOns.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(addOns)
      .where(where),
  ]);

  return { rows, total: totals[0]?.total ?? 0 };
}

/** Add-ons a product offers, with the per-product price override resolved. */
export async function listAddOnsForProduct(productId: string): Promise<AddOnRow[]> {
  return db
    .select({
      ...addOnSelection,
      pricePaise: sql<number>`coalesce(${productAddOns.priceOverridePaise}, ${addOns.pricePaise})`,
    })
    .from(productAddOns)
    .innerJoin(addOns, eq(addOns.id, productAddOns.addOnId))
    .where(and(eq(productAddOns.productId, productId), addOnIsLive))
    .orderBy(asc(productAddOns.position), asc(addOns.name));
}

export async function listDefaultAddOns(): Promise<AddOnRow[]> {
  return db
    .select({ ...addOnSelection, pricePaise: addOns.pricePaise })
    .from(addOns)
    .where(addOnIsLive)
    .orderBy(asc(addOns.name));
}

/* ------------------------------------------------------- personalisation */

const templateSelection = {
  id: personalisationTemplates.id,
  name: personalisationTemplates.name,
  method: personalisationTemplates.method,
  turnaroundHours: personalisationTemplates.turnaroundHours,
  charLimit: personalisationTemplates.charLimit,
  allowsImage: personalisationTemplates.allowsImage,
  proofRequired: personalisationTemplates.proofRequired,
  surchargePaise: personalisationTemplates.surchargePaise,
};

const TEMPLATE_ORDER: Record<string, SQL> = {
  name: sql`${personalisationTemplates.name}`,
  turnaroundHours: sql`${personalisationTemplates.turnaroundHours}`,
  surchargePaise: sql`${personalisationTemplates.surchargePaise}`,
};

const templateIsLive = and(
  eq(personalisationTemplates.status, 'active'),
  isNull(personalisationTemplates.deletedAt),
) as SQL;

export async function listPersonalisationTemplates(
  opts: { q?: string | undefined; method?: string | undefined; productId?: string | undefined },
  sort: SortSpec,
  page: Page,
): Promise<{ rows: PersonalisationTemplateRow[]; total: number }> {
  const parts: SQL[] = [templateIsLive];
  if (opts.q) parts.push(sql`${personalisationTemplates.name} ILIKE ${`%${opts.q}%`}`);
  if (opts.method) parts.push(sql`${personalisationTemplates.method} = ${opts.method}`);
  if (opts.productId) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM product_personalisation_templates ppt
      WHERE ppt.template_id = ${personalisationTemplates.id} AND ppt.product_id = ${opts.productId}
    )`);
  }
  const where = sql.join(parts, sql` AND `);

  const [rows, totals] = await Promise.all([
    db
      .select(templateSelection)
      .from(personalisationTemplates)
      .where(where)
      .orderBy(...orderBy(TEMPLATE_ORDER, sort, 'name'), asc(personalisationTemplates.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(personalisationTemplates)
      .where(where),
  ]);

  return { rows, total: totals[0]?.total ?? 0 };
}

export async function listTemplatesForProduct(productId: string): Promise<PersonalisationTemplateRow[]> {
  return db
    .select(templateSelection)
    .from(productPersonalisationTemplates)
    .innerJoin(
      personalisationTemplates,
      eq(personalisationTemplates.id, productPersonalisationTemplates.templateId),
    )
    .where(and(eq(productPersonalisationTemplates.productId, productId), templateIsLive))
    .orderBy(asc(personalisationTemplates.name));
}

/* ------------------------------------------------------------ collections */

const parentCollections = alias(collections, 'parent_collection');

const collectionProductCount = sql<number>`(
  SELECT count(*)::int
  FROM product_collections pc
  JOIN products p ON p.id = pc.product_id
  WHERE pc.collection_id = ${collections.id}
    AND p.status = 'active' AND p.deleted_at IS NULL
    AND p.published_at IS NOT NULL AND p.published_at <= now()
)`;

const collectionHeroImage = sql<MediaRow | null>`(
  SELECT json_build_object(
    'id', m.id, 'url', coalesce(m.cdn_url, m.url), 'altText', m.alt_text, 'position', 0
  )
  FROM media_assets m
  WHERE m.id = ${collections.heroMediaId} AND m.deleted_at IS NULL
)`;

const collectionSelection = {
  id: collections.id,
  handle: collections.handle,
  kind: collections.kind,
  parentHandle: parentCollections.handle,
  title: collections.title,
  heading: collections.heading,
  subtext: collections.subtext,
  seoDescription: collections.seoDescription,
  image: collectionHeroImage,
  curator: collections.curator,
  designerId: designers.id,
  designerHandle: designers.handle,
  designerName: designers.name,
  isFeatured: collections.isFeatured,
  sortOrder: collections.sortOrder,
  productCount: collectionProductCount,
};

const COLLECTION_ORDER: Record<string, SQL> = {
  sortOrder: sql`${collections.sortOrder}`,
  title: sql`${collections.title}`,
  createdAt: sql`${collections.createdAt}`,
};

/**
 * A `live` collection is visible; a `scheduled` one only once its window opens
 * and before it closes. `draft` and `archived` are never exposed.
 */
const collectionIsLive: SQL = sql`${collections.deletedAt} IS NULL
  AND (
    ${collections.status} = 'live'
    OR (${collections.status} = 'scheduled' AND ${collections.startsOn} <= now())
  )
  AND (${collections.endsOn} IS NULL OR ${collections.endsOn} > now())`;

export async function listCollections(
  opts: {
    q?: string | undefined;
    kind?: string | undefined;
    parent?: string | undefined;
    featured?: boolean | undefined;
  },
  sort: SortSpec,
  page: Page,
): Promise<{ rows: CollectionRow[]; total: number }> {
  const parts: SQL[] = [collectionIsLive];
  if (opts.q) parts.push(sql`${collections.title} ILIKE ${`%${opts.q}%`}`);
  if (opts.kind) parts.push(sql`${collections.kind} = ${opts.kind}`);
  if (opts.parent) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM collections pc WHERE pc.id = ${collections.parentId} AND pc.handle = ${opts.parent}
    )`);
  }
  if (opts.featured) parts.push(sql`${collections.isFeatured}`);
  const where = sql.join(parts, sql` AND `);

  const [rows, totals] = await Promise.all([
    db
      .select(collectionSelection)
      .from(collections)
      .leftJoin(parentCollections, eq(parentCollections.id, collections.parentId))
      .leftJoin(designers, eq(designers.id, collections.designerId))
      .where(where)
      .orderBy(...orderBy(COLLECTION_ORDER, sort, 'sortOrder'), asc(collections.title))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(collections)
      .where(where),
  ]);

  return { rows: rows, total: totals[0]?.total ?? 0 };
}

export async function findCollectionByHandle(handle: string): Promise<CollectionRow | null> {
  const rows = await db
    .select(collectionSelection)
    .from(collections)
    .leftJoin(parentCollections, eq(parentCollections.id, collections.parentId))
    .leftJoin(designers, eq(designers.id, collections.designerId))
    .where(and(eq(collections.handle, handle), collectionIsLive))
    .limit(1);

  return (rows[0] as CollectionRow | undefined) ?? null;
}

/* -------------------------------------------------------------- designers */

const designerProductCount = sql<number>`(
  SELECT count(*)::int FROM products p
  WHERE p.designer_id = ${designers.id}
    AND p.status = 'active' AND p.deleted_at IS NULL
    AND p.published_at IS NOT NULL AND p.published_at <= now()
)`;

const designerSelection = {
  id: designers.id,
  handle: designers.handle,
  name: designers.name,
  kind: designers.kind,
  bio: designers.bio,
  logo: sql<MediaRow | null>`(
    SELECT json_build_object(
      'id', m.id, 'url', coalesce(m.cdn_url, m.url), 'altText', m.alt_text, 'position', 0
    )
    FROM media_assets m WHERE m.id = ${designers.logoMediaId} AND m.deleted_at IS NULL
  )`,
  productCount: designerProductCount,
};

const DESIGNER_ORDER: Record<string, SQL> = {
  name: sql`${designers.name}`,
  createdAt: sql`${designers.createdAt}`,
  productCount: designerProductCount,
};

const designerIsLive = and(eq(designers.status, 'active'), isNull(designers.deletedAt)) as SQL;

export async function listDesigners(
  opts: { q?: string | undefined; kind?: string | undefined },
  sort: SortSpec,
  page: Page,
): Promise<{ rows: DesignerRow[]; total: number }> {
  const parts: SQL[] = [designerIsLive];
  if (opts.q) parts.push(sql`${designers.name} ILIKE ${`%${opts.q}%`}`);
  if (opts.kind) parts.push(sql`${designers.kind} = ${opts.kind}`);
  const where = sql.join(parts, sql` AND `);

  const [rows, totals] = await Promise.all([
    db
      .select(designerSelection)
      .from(designers)
      .where(where)
      .orderBy(...orderBy(DESIGNER_ORDER, sort, 'name'), asc(designers.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(designers)
      .where(where),
  ]);

  return { rows: rows, total: totals[0]?.total ?? 0 };
}

export async function findDesignerByHandle(handle: string): Promise<DesignerRow | null> {
  const rows = await db
    .select(designerSelection)
    .from(designers)
    .where(and(eq(designers.handle, handle), designerIsLive))
    .limit(1);

  return (rows[0] as DesignerRow | undefined) ?? null;
}

/* --------------------------------------------------------- hamper builder */

const builderIsLive = and(eq(builderTemplates.status, 'live'), isNull(builderTemplates.deletedAt)) as SQL;

const builderStepCount = sql<number>`(
  SELECT count(*)::int FROM builder_template_steps s WHERE s.template_id = ${builderTemplates.id}
)`;

const BUILDER_ORDER: Record<string, SQL> = {
  name: sql`${builderTemplates.name}`,
  basePricePaise: sql`${builderTemplates.basePricePaise}`,
  createdAt: sql`${builderTemplates.createdAt}`,
};

export async function listBuilderTemplates(
  opts: { q?: string | undefined },
  sort: SortSpec,
  page: Page,
): Promise<{ rows: BuilderTemplateRow[]; total: number }> {
  const parts: SQL[] = [builderIsLive];
  if (opts.q) parts.push(sql`${builderTemplates.name} ILIKE ${`%${opts.q}%`}`);
  const where = sql.join(parts, sql` AND `);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: builderTemplates.id,
        handle: builderTemplates.handle,
        name: builderTemplates.name,
        basePricePaise: builderTemplates.basePricePaise,
        maxWeightGrams: builderTemplates.maxWeightGrams,
        stepCount: builderStepCount,
      })
      .from(builderTemplates)
      .where(where)
      .orderBy(...orderBy(BUILDER_ORDER, sort, 'name'), asc(builderTemplates.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(builderTemplates)
      .where(where),
  ]);

  return { rows, total: totals[0]?.total ?? 0 };
}

export async function findBuilderTemplateByHandle(handle: string): Promise<BuilderTemplateRow | null> {
  const rows = await db
    .select({
      id: builderTemplates.id,
      handle: builderTemplates.handle,
      name: builderTemplates.name,
      basePricePaise: builderTemplates.basePricePaise,
      maxWeightGrams: builderTemplates.maxWeightGrams,
      stepCount: builderStepCount,
    })
    .from(builderTemplates)
    .where(and(eq(builderTemplates.handle, handle), builderIsLive))
    .limit(1);

  return rows[0] ?? null;
}

export async function listBuilderSteps(templateId: string): Promise<BuilderStepRow[]> {
  return db
    .select({
      id: builderTemplateSteps.id,
      position: builderTemplateSteps.position,
      title: builderTemplateSteps.title,
      note: builderTemplateSteps.note,
      stepKind: builderTemplateSteps.stepKind,
      minChoices: builderTemplateSteps.minChoices,
      maxChoices: builderTemplateSteps.maxChoices,
    })
    .from(builderTemplateSteps)
    .where(eq(builderTemplateSteps.templateId, templateId))
    .orderBy(asc(builderTemplateSteps.position));
}

/**
 * An option is out of stock when it is switched off OR its backing stockable
 * (hamper item, variant or packaging material) has no available units anywhere.
 * Availability is a read-time computation — §4.1, never a stored column.
 */
export async function listBuilderOptions(stepIds: string[]): Promise<BuilderOptionRow[]> {
  if (stepIds.length === 0) return [];

  return db
    .select({
      id: builderStepOptions.id,
      stepId: builderStepOptions.stepId,
      label: builderStepOptions.label,
      pricePaise: builderStepOptions.pricePaise,
      weightGrams: builderStepOptions.weightGrams,
      position: builderStepOptions.position,
      inStock: sql<boolean>`(${builderStepOptions.isAvailable} AND EXISTS (
        SELECT 1 FROM inventory_levels il
        WHERE il.available_qty > 0 AND (
          (${builderStepOptions.hamperItemId} IS NOT NULL AND il.hamper_item_id = ${builderStepOptions.hamperItemId})
          OR (${builderStepOptions.variantId} IS NOT NULL AND il.variant_id = ${builderStepOptions.variantId})
          OR (${builderStepOptions.packagingId} IS NOT NULL AND il.packaging_id = ${builderStepOptions.packagingId})
        )
      ))`,
    })
    .from(builderStepOptions)
    .where(inArray(builderStepOptions.stepId, stepIds))
    .orderBy(asc(builderStepOptions.position), asc(builderStepOptions.label));
}

/* -------------------------------------------------------- serviceability */

export async function findPincode(pincode: string): Promise<ServiceabilityRow | null> {
  const rows = await db
    .select({
      pincode: deliveryZonePincodes.pincode,
      isServiceable: deliveryZonePincodes.isServiceable,
      codAllowed: deliveryZonePincodes.codAllowed,
      city: sql<string | null>`coalesce(${deliveryZonePincodes.city}, ${deliveryZones.city})`,
      stateCode: sql<string | null>`coalesce(${deliveryZonePincodes.stateCode}, ${deliveryZones.stateCode})`,
      zoneName: deliveryZones.name,
      tier: deliveryZones.tier,
      standardTatDays: deliveryZones.standardTatDays,
      supportsSameDay: deliveryZones.supportsSameDay,
      supportsMidnight: deliveryZones.supportsMidnight,
      supportsCod: deliveryZones.supportsCod,
      sameDayCutoff: deliveryZones.sameDayCutoff,
      zoneStatus: deliveryZones.status,
    })
    .from(deliveryZonePincodes)
    .innerJoin(deliveryZones, eq(deliveryZones.id, deliveryZonePincodes.zoneId))
    .where(eq(deliveryZonePincodes.pincode, pincode))
    .limit(1);

  return (rows[0] as ServiceabilityRow | undefined) ?? null;
}

/* -------------------------------------------------------------------- seo */

export async function findSeo(
  entityType: 'product' | 'collection' | 'content_page' | 'blog_post',
  entityId: string,
): Promise<SeoRow | null> {
  const rows = await db
    .select({
      metaTitle: seoEntries.metaTitle,
      metaDescription: seoEntries.metaDescription,
      canonicalUrl: seoEntries.canonicalUrl,
      focusKeyword: seoEntries.focusKeyword,
      robotsIndex: seoEntries.robotsIndex,
      robotsFollow: seoEntries.robotsFollow,
      ogImageUrl: sql<string | null>`(
        SELECT coalesce(m.cdn_url, m.url) FROM media_assets m
        WHERE m.id = ${seoEntries.ogMediaId} AND m.deleted_at IS NULL
      )`,
      structuredData: seoEntries.structuredData,
    })
    .from(seoEntries)
    .where(and(eq(seoEntries.entityType, entityType), eq(seoEntries.entityId, entityId)))
    .limit(1);

  return rows[0] ?? null;
}
