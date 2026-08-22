/**
 * Catalogue business rules: derived badges, stock presentation, add-on
 * fallbacks, the same-day cutoff, and the Redis read-through cache.
 *
 * No HTTP here — 404s are thrown as `NotFoundError` and turned into a response
 * by `middleware/error-handler.ts` alone.
 */

import { cache } from '../../config/redis.js';
import { logger } from '../../config/logger.js';
import { NotFoundError } from '../../lib/errors.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import * as repo from './catalogue.repository.js';
import {
  ADD_ON_SORT_FALLBACK,
  ADD_ON_SORT_FIELDS,
  BUILDER_TEMPLATE_SORT_FALLBACK,
  BUILDER_TEMPLATE_SORT_FIELDS,
  COLLECTION_SORT_FALLBACK,
  COLLECTION_SORT_FIELDS,
  DESIGNER_SORT_FALLBACK,
  DESIGNER_SORT_FIELDS,
  PERSONALISATION_SORT_FALLBACK,
  PERSONALISATION_SORT_FIELDS,
  PRODUCT_SORT_FALLBACK,
  PRODUCT_SORT_FIELDS,
  type AddOnListQuery,
  type AddOnResponse,
  type CollectionDetail,
  type CollectionListQuery,
  type CollectionSummary,
  type DesignerListQuery,
  type DesignerSummary,
  type HamperComponents,
  type HamperTemplateSummary,
  type PersonalisationTemplateListQuery,
  type PersonalisationTemplateResponse,
  type ProductDetail,
  type ProductListQuery,
  type ProductSummary,
  type ProductVariantResponse,
  type Serviceability,
  type StockState,
} from './catalogue.schemas.js';
import type { ListQuery } from '../../lib/pagination.js';

/* ----------------------------------------------------------------- cache */

const CACHE_PREFIX = 'cat:v1';
/** Short on purpose: a merchandiser editing a collection should see it inside a minute. */
const LIST_TTL_SECONDS = 60;
const DETAIL_TTL_SECONDS = 120;

/** Deterministic key — same filters must produce the same string every time. */
function cacheKey(resource: string, params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : String(v)}`);
  return `${CACHE_PREFIX}:${resource}:${parts.join('&')}`;
}

/**
 * Read-through cache. A Redis failure degrades to a database read — the
 * catalogue must not 500 because the cache is unreachable.
 */
async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  try {
    const hit = await cache.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (err) {
    logger.warn({ err, key }, 'catalogue cache read failed; falling through to postgres');
  }

  const value = await load();

  try {
    await cache.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, 'catalogue cache write failed');
  }

  return value;
}

/* --------------------------------------------------------------- helpers */

export function stockStateOf(qty: number, lowStockThreshold: number): StockState {
  if (qty <= 0) return 'out';
  if (qty <= lowStockThreshold) return 'low';
  return 'in';
}

const HANDLE_CHARSET = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * `?type=a&type=b` and `?type=a,b` both mean the same thing. `hpp` collapses
 * repeated query parameters, so the comma form is the one that survives a proxy.
 * Anything that is not a well-formed handle is dropped rather than reaching the
 * WHERE clause.
 */
export function toHandleList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value])
    .flatMap((s) => s.split(','))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && HANDLE_CHARSET.test(s));
  return list.length > 0 ? [...new Set(list)] : undefined;
}

const pageOf = (q: { page: number; perPage: number }): repo.Page => ({
  limit: q.perPage,
  offset: offsetOf(q.page, q.perPage),
});

/* -------------------------------------------------------------- mappers */

const toMedia = (m: repo.MediaRow | null): repo.MediaRow | null => m;

function toProductSummary(row: repo.ProductRow): ProductSummary {
  return {
    id: row.id,
    handle: row.handle,
    sku: row.sku,
    title: row.title,
    subtitle: row.subtitle,
    kind: row.kind as ProductSummary['kind'],
    designer:
      row.designerId && row.designerHandle && row.designerName
        ? { id: row.designerId, handle: row.designerHandle, name: row.designerName }
        : null,
    type: row.type,
    typeLabel: row.typeLabel,
    pricePaise: row.pricePaise,
    compareAtPaise: row.compareAtPaise,
    image: toMedia(row.image),
    collectionHandles: row.collectionHandles,
    occasionHandles: row.occasionHandles,
    recipientHandles: row.recipientHandles,
    stock: stockStateOf(row.stockQty, row.lowStockThreshold),
    stockQty: row.stockQty,
    sameDay: row.sameDay,
    bestSeller: row.bestSeller,
    isNew: row.isNew,
    personalisable: row.personalisable,
    tags: row.tags,
    ratingAvg: row.ratingAvg,
    reviewCount: row.reviewCount,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

function toVariant(row: repo.VariantRow): ProductVariantResponse {
  return {
    id: row.id,
    sku: row.sku,
    optionLabel: row.optionLabel,
    optionValue: row.optionValue,
    pricePaise: row.pricePaise,
    compareAtPaise: row.compareAtPaise,
    weightGrams: row.weightGrams,
    isDefault: row.isDefault,
    position: row.position,
    stock: stockStateOf(row.stockQty, row.lowStockThreshold),
    stockQty: row.stockQty,
  };
}

function toAddOn(row: repo.AddOnRow): AddOnResponse {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind as AddOnResponse['kind'],
    pricePaise: row.pricePaise,
    requiresInput: row.requiresInput,
    inputCharLimit: row.inputCharLimit,
    leadTimeHours: row.leadTimeHours,
  };
}

function toTemplate(row: repo.PersonalisationTemplateRow): PersonalisationTemplateResponse {
  return {
    id: row.id,
    name: row.name,
    method: row.method as PersonalisationTemplateResponse['method'],
    turnaroundHours: row.turnaroundHours,
    charLimit: row.charLimit,
    allowsImage: row.allowsImage,
    proofRequired: row.proofRequired,
    surchargePaise: row.surchargePaise,
  };
}

function toCollectionSummary(row: repo.CollectionRow): CollectionSummary {
  return {
    id: row.id,
    handle: row.handle,
    kind: row.kind as CollectionSummary['kind'],
    parentHandle: row.parentHandle,
    title: row.title,
    heading: row.heading,
    subtext: row.subtext,
    seoDescription: row.seoDescription,
    image: toMedia(row.image),
    curator: row.curator,
    designer:
      row.designerId && row.designerHandle && row.designerName
        ? { id: row.designerId, handle: row.designerHandle, name: row.designerName }
        : null,
    isFeatured: row.isFeatured,
    sortOrder: row.sortOrder,
    productCount: row.productCount,
  };
}

function toDesigner(row: repo.DesignerRow): DesignerSummary {
  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    kind: row.kind as DesignerSummary['kind'],
    bio: row.bio,
    logo: toMedia(row.logo),
    productCount: row.productCount,
  };
}

/* -------------------------------------------------------------- products */

function productFilters(query: ProductListQuery): repo.ProductFilters {
  return {
    q: query.q,
    collection: query.collection,
    types: toHandleList(query.type),
    designer: query.designer,
    minPricePaise: query.minPricePaise,
    maxPricePaise: query.maxPricePaise,
    inStock: query.inStock,
    sameDay: query.sameDay,
    personalisable: query.personalisable,
  };
}

export async function listProducts(
  query: ProductListQuery,
): Promise<{ items: ProductSummary[]; total: number }> {
  const filters = productFilters(query);
  const sort = parseSort(query.sort, PRODUCT_SORT_FIELDS, PRODUCT_SORT_FALLBACK);

  return cached(
    cacheKey('products', {
      ...filters,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listProducts(filters, sort, pageOf(query));
      return { items: rows.map(toProductSummary), total };
    },
  );
}

export async function getProductByHandle(handle: string): Promise<ProductDetail> {
  return cached(cacheKey('product', { handle }), DETAIL_TTL_SECONDS, async () => {
    const row = await repo.findProductByHandle(handle);
    if (!row) throw new NotFoundError('Product', handle);

    const [images, contents, variants, pinnedAddOns, templates, relatedHandles, seo] = await Promise.all([
      repo.listProductMedia(row.id),
      repo.listContentItems(row.id),
      repo.listVariants(row.id),
      repo.listAddOnsForProduct(row.id),
      repo.listTemplatesForProduct(row.id),
      repo.listRelatedHandles(row.id, 8),
      repo.findSeo('product', row.id),
    ]);

    // A product with no pinned add-ons offers the global set, not none at all.
    const addOnRows = pinnedAddOns.length > 0 ? pinnedAddOns : await repo.listDefaultAddOns();

    return {
      ...toProductSummary(row),
      description: row.description,
      isPerishable: row.isPerishable,
      isFragile: row.isFragile,
      images,
      contents,
      variants: variants.map(toVariant),
      addOns: addOnRows.map(toAddOn),
      personalisationTemplates: row.personalisable ? templates.map(toTemplate) : [],
      relatedHandles,
      seo,
    } satisfies ProductDetail;
  });
}

/**
 * Hydrates ranked ids into product summaries, preserving the caller's order.
 *
 * Deliberately uncached: this is the tail of a search request, and a cached
 * search is a stale search. The catalogue's own list/detail reads are cached;
 * this one is not.
 */
export async function getProductsByIds(ids: string[]): Promise<ProductSummary[]> {
  if (ids.length === 0) return [];

  const rows = await repo.listProductsByIds(ids);
  const byId = new Map(rows.map((row) => [row.id, toProductSummary(row)]));

  // A row can vanish between ranking and hydration (unpublished mid-request);
  // dropping it is correct, and keeps the response honest about what is live.
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

export async function listProductVariants(handle: string): Promise<ProductVariantResponse[]> {
  return cached(cacheKey('variants', { handle }), DETAIL_TTL_SECONDS, async () => {
    const row = await repo.findProductByHandle(handle);
    if (!row) throw new NotFoundError('Product', handle);
    const variants = await repo.listVariants(row.id);
    return variants.map(toVariant);
  });
}

/* ----------------------------------------------------------- collections */

export async function listCollections(
  query: CollectionListQuery,
): Promise<{ items: CollectionSummary[]; total: number }> {
  const sort = parseSort(query.sort, COLLECTION_SORT_FIELDS, COLLECTION_SORT_FALLBACK);
  const opts = { q: query.q, kind: query.kind, parent: query.parent, featured: query.featured };

  return cached(
    cacheKey('collections', {
      ...opts,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listCollections(opts, sort, pageOf(query));
      return { items: rows.map(toCollectionSummary), total };
    },
  );
}

export async function getCollectionByHandle(handle: string): Promise<CollectionDetail> {
  return cached(cacheKey('collection', { handle }), DETAIL_TTL_SECONDS, async () => {
    const row = await repo.findCollectionByHandle(handle);
    if (!row) throw new NotFoundError('Collection', handle);

    const filters: repo.ProductFilters = { collection: handle };
    const [availableTypes, bounds, seo] = await Promise.all([
      repo.typeFacets(filters),
      repo.priceBounds(filters),
      repo.findSeo('collection', row.id),
    ]);

    return {
      collection: toCollectionSummary(row),
      availableTypes,
      priceBounds: bounds,
      seo,
    } satisfies CollectionDetail;
  });
}

export async function listCollectionProducts(
  handle: string,
  query: ProductListQuery,
): Promise<{ items: ProductSummary[]; total: number }> {
  const collection = await repo.findCollectionByHandle(handle);
  if (!collection) throw new NotFoundError('Collection', handle);

  // The path segment is authoritative — a `collection` query param cannot widen it.
  return listProducts({ ...query, collection: handle });
}

/* ------------------------------------------------------------- designers */

export async function listDesigners(
  query: DesignerListQuery,
): Promise<{ items: DesignerSummary[]; total: number }> {
  const sort = parseSort(query.sort, DESIGNER_SORT_FIELDS, DESIGNER_SORT_FALLBACK);
  const opts = { q: query.q, kind: query.kind };

  return cached(
    cacheKey('designers', {
      ...opts,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listDesigners(opts, sort, pageOf(query));
      return { items: rows.map(toDesigner), total };
    },
  );
}

export async function getDesignerByHandle(handle: string): Promise<DesignerSummary> {
  return cached(cacheKey('designer', { handle }), DETAIL_TTL_SECONDS, async () => {
    const row = await repo.findDesignerByHandle(handle);
    if (!row) throw new NotFoundError('Designer', handle);
    return toDesigner(row);
  });
}

/* --------------------------------------------------- add-ons & templates */

export async function listAddOns(query: AddOnListQuery): Promise<{ items: AddOnResponse[]; total: number }> {
  if (query.product) {
    const product = await repo.findProductByHandle(query.product);
    if (!product) throw new NotFoundError('Product', query.product);
    const pinned = await repo.listAddOnsForProduct(product.id);
    const rows = pinned.length > 0 ? pinned : await repo.listDefaultAddOns();
    return { items: rows.map(toAddOn), total: rows.length };
  }

  const sort = parseSort(query.sort, ADD_ON_SORT_FIELDS, ADD_ON_SORT_FALLBACK);
  const opts = { q: query.q, kind: query.kind };

  return cached(
    cacheKey('addons', {
      ...opts,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listAddOns(opts, sort, pageOf(query));
      return { items: rows.map(toAddOn), total };
    },
  );
}

export async function listPersonalisationTemplates(
  query: PersonalisationTemplateListQuery,
): Promise<{ items: PersonalisationTemplateResponse[]; total: number }> {
  let productId: string | undefined;
  if (query.product) {
    const product = await repo.findProductByHandle(query.product);
    if (!product) throw new NotFoundError('Product', query.product);
    productId = product.id;
  }

  const sort = parseSort(query.sort, PERSONALISATION_SORT_FIELDS, PERSONALISATION_SORT_FALLBACK);
  const opts = { q: query.q, method: query.method, productId };

  return cached(
    cacheKey('templates', {
      ...opts,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listPersonalisationTemplates(opts, sort, pageOf(query));
      return { items: rows.map(toTemplate), total };
    },
  );
}

/* -------------------------------------------------------- hamper builder */

export async function listHamperTemplates(
  query: ListQuery,
): Promise<{ items: HamperTemplateSummary[]; total: number }> {
  const sort = parseSort(query.sort, BUILDER_TEMPLATE_SORT_FIELDS, BUILDER_TEMPLATE_SORT_FALLBACK);

  return cached(
    cacheKey('builders', {
      q: query.q,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listBuilderTemplates({ q: query.q }, sort, pageOf(query));
      return { items: rows, total };
    },
  );
}

export async function getHamperTemplate(handle: string): Promise<HamperComponents> {
  return cached(cacheKey('builder', { handle }), LIST_TTL_SECONDS, async () => {
    const template = await repo.findBuilderTemplateByHandle(handle);
    if (!template) throw new NotFoundError('Hamper builder template', handle);

    const steps = await repo.listBuilderSteps(template.id);
    const options = await repo.listBuilderOptions(steps.map((s) => s.id));

    return {
      id: template.id,
      handle: template.handle,
      name: template.name,
      basePricePaise: template.basePricePaise,
      maxWeightGrams: template.maxWeightGrams,
      steps: steps.map((step) => ({
        id: step.id,
        position: step.position,
        title: step.title,
        note: step.note,
        stepKind: step.stepKind as HamperComponents['steps'][number]['stepKind'],
        minChoices: step.minChoices,
        maxChoices: step.maxChoices,
        options: options
          .filter((o) => o.stepId === step.id)
          .map((o) => ({
            id: o.id,
            label: o.label,
            pricePaise: o.pricePaise,
            weightGrams: o.weightGrams,
            position: o.position,
            stock: o.inStock ? ('in' as const) : ('out' as const),
          })),
      })),
    } satisfies HamperComponents;
  });
}

/* -------------------------------------------------------- serviceability */

const IST = 'Asia/Kolkata';

/** `YYYY-MM-DD` in Asia/Kolkata. Delivery promises are made in Indian local time. */
export function istDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** `HH:MM:SS` in Asia/Kolkata, 24-hour, so it compares lexicographically with a PG `time`. */
export function istTime(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(now);
}

/**
 * Adds working days, treating Sunday as the only non-working day — Indian
 * couriers run Monday to Saturday. Public holidays are not modelled; when a
 * holiday calendar lands this is the one function that changes.
 */
export function addWorkingDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  for (let remaining = Math.max(0, days); remaining > 0;) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() !== 0) remaining--;
  }
  return date.toISOString().slice(0, 10);
}

/** `'13:00:00' > '15:00:00'` is a correct comparison for zero-padded 24h strings. */
export function isBeforeCutoff(nowHms: string, cutoff: string | null): boolean {
  if (!cutoff) return true;
  return nowHms < cutoff.slice(0, 8);
}

export async function checkServiceability(pincode: string, now = new Date()): Promise<Serviceability> {
  const row = await repo.findPincode(pincode);

  // An unknown PIN code and a suspended one are the same answer to a shopper.
  if (!row || !row.isServiceable || row.zoneStatus !== 'active') {
    return {
      pincode,
      serviceable: false,
      city: row?.city ?? null,
      stateCode: row?.stateCode ?? null,
      zoneName: row?.zoneName ?? null,
      tier: (row?.tier ?? null) as Serviceability['tier'],
      standardTatDays: row?.standardTatDays ?? null,
      estimatedDeliveryDate: null,
      sameDayEligible: false,
      sameDayCutoff: row?.sameDayCutoff ?? null,
      midnightEligible: false,
      codEligible: false,
    };
  }

  const today = istDate(now);
  const tat = row.standardTatDays;

  return {
    pincode,
    serviceable: true,
    city: row.city,
    stateCode: row.stateCode,
    zoneName: row.zoneName,
    tier: row.tier as Serviceability['tier'],
    standardTatDays: tat,
    estimatedDeliveryDate: tat === null ? null : addWorkingDays(today, tat),
    sameDayEligible: row.supportsSameDay && isBeforeCutoff(istTime(now), row.sameDayCutoff),
    sameDayCutoff: row.sameDayCutoff,
    midnightEligible: row.supportsMidnight,
    // Zone policy AND PIN-code policy must both allow it.
    codEligible: row.supportsCod && row.codAllowed,
  };
}
