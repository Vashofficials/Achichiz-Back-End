/**
 * catalogue.ts — §2.3
 *
 * Products, variants, the single `collections` taxonomy (discriminated by
 * `kind`), designers, hamper components + BOM, add-ons, personalisation and the
 * hamper builder.
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - DOMAIN handle / hsn / nonneg_paise / percent_bp
 *  - §7 correction 2 — PARTIAL unique indexes WHERE deleted_at IS NULL on:
 *    products.handle, collections.handle, designers.handle, designers.name,
 *    product_variants.sku, product_variants.barcode,
 *    product_variants(product_id, option_value), hamper_items.sku,
 *    add_ons.code, personalisation_templates.name, builder_templates.handle.
 *  - §7 correction 5 — legacy_ref TEXT on products and collections.
 *  - TRIGGER trg_<table>_updated (set_updated_at)
 *  - Availability of a hamper is MIN(FLOOR(component.available_qty / bom.qty))
 *    computed at read time (§4.1); it is deliberately not a column.
 */

import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  boolean,
  integer,
  smallint,
  numeric,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { hsnCodes } from './tax.js';
import { staffUsers } from './identity.js';
import { mediaAssets } from './content.js';
import { suppliers } from './inventory.js';
import { packagingMaterials } from './delivery.js';
import { customers } from './customers.js';
import { orderLines } from './orders.js';

/* -------------------------------------------------------------- designers */

export const DESIGNER_KINDS = ['designer', 'brand', 'celebrity', 'artisan_cluster'] as const;
export type DesignerKind = (typeof DESIGNER_KINDS)[number];

export const DESIGNER_STATUSES = ['active', 'paused', 'archived'] as const;
export type DesignerStatus = (typeof DESIGNER_STATUSES)[number];

export const designers = pgTable(
  'designers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: DOMAIN handle. Partial-unique. */
    handle: text('handle').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('brand').$type<DesignerKind>(),
    bio: text('bio'),
    logoMediaId: uuid('logo_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    /** Basis points. The admin stores whole percent (8..28); bp is safer. */
    commissionBp: integer('commission_bp'),
    /** DB type: CITEXT. */
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    status: text('status').notNull().default('active').$type<DesignerStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_designers_handle').on(t.handle).where(sql`deleted_at IS NULL`),
    uniqueIndex('uq_designers_name').on(t.name).where(sql`deleted_at IS NULL`),
    index('idx_designers_status').on(t.status).where(sql`deleted_at IS NULL`),
    check(
      'designers_kind_check',
      sql`kind IN ('designer','brand','celebrity','artisan_cluster')`,
    ),
    check('designers_status_check', sql`status IN ('active','paused','archived')`),
  ],
);

/* ------------------------------------------------------------ collections */
/** §1.2 — one taxonomy table, discriminated by `kind`. */

export const COLLECTION_KINDS = [
  'category',
  'recipient',
  'occasion',
  'festival',
  'designer',
  'edit',
] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];

export const COLLECTION_STATUSES = ['live', 'scheduled', 'draft', 'archived'] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: DOMAIN handle. Public route key. Partial-unique. */
    handle: text('handle').notNull(),
    kind: text('kind').notNull().$type<CollectionKind>(),
    parentId: uuid('parent_id').references((): AnyPgColumn => collections.id, {
      onDelete: 'set null',
    }),
    /** Nav label: 'Drinkware'. */
    title: text('title').notNull(),
    /** Page H1: 'Bamboo Drinkware'. */
    heading: text('heading'),
    subtext: text('subtext'),
    seoDescription: text('seo_description'),
    heroMediaId: uuid('hero_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    /** kind='designer' only. */
    designerId: uuid('designer_id').references((): AnyPgColumn => designers.id, {
      onDelete: 'set null',
    }),
    /** kind='edit' only. */
    curator: text('curator'),
    sortOrder: integer('sort_order').notNull().default(0),
    isFeatured: boolean('is_featured').notNull().default(false),
    status: text('status').notNull().default('draft').$type<CollectionStatus>(),
    startsOn: timestamp('starts_on', { withTimezone: true }),
    endsOn: timestamp('ends_on', { withTimezone: true }),
    /** §7 correction 5. */
    legacyRef: text('legacy_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    updatedBy: uuid('updated_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_collections_handle').on(t.handle).where(sql`deleted_at IS NULL`),
    index('idx_collections_kind').on(t.kind, t.sortOrder).where(sql`deleted_at IS NULL`),
    index('idx_collections_parent').on(t.parentId).where(sql`deleted_at IS NULL`),
    index('idx_collections_live')
      .on(t.status)
      .where(sql`status = 'live' AND deleted_at IS NULL`),
    index('idx_collections_legacy_ref').on(t.legacyRef).where(sql`legacy_ref IS NOT NULL`),
    check(
      'collections_kind_check',
      sql`kind IN ('category','recipient','occasion','festival','designer','edit')`,
    ),
    check(
      'collections_status_check',
      sql`status IN ('live','scheduled','draft','archived')`,
    ),
    check('collection_no_self_parent', sql`parent_id IS DISTINCT FROM id`),
    check(
      'collection_window',
      sql`ends_on IS NULL OR starts_on IS NULL OR ends_on > starts_on`,
    ),
    check('collection_designer_kind', sql`kind = 'designer' OR designer_id IS NULL`),
    check(
      'collection_scheduled_needs_start',
      sql`status <> 'scheduled' OR starts_on IS NOT NULL`,
    ),
  ],
);

/* --------------------------------------------------------------- products */

export const PRODUCT_KINDS = [
  'hamper',
  'single_gift',
  'personalised',
  'gourmet',
  'add_on',
  'builder',
] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/** 'Out of stock' is deliberately NOT here — that is stock state, not lifecycle. */
export const PRODUCT_STATUSES = ['active', 'draft', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PRODUCT_BADGES = ['best_seller', 'new', 'limited', 'none'] as const;
export type ProductBadge = (typeof PRODUCT_BADGES)[number];

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: DOMAIN handle. Storefront route key. Partial-unique. */
    handle: text('handle').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description'),
    /** Fulfilment class — NOT the storefront's merchandising category (§1.1). */
    kind: text('kind').notNull().default('single_gift').$type<ProductKind>(),
    designerId: uuid('designer_id').references((): AnyPgColumn => designers.id, {
      onDelete: 'set null',
    }),
    /** Breadcrumb only; real taxonomy is product_collections. */
    primaryCollectionId: uuid('primary_collection_id').references(
      (): AnyPgColumn => collections.id,
      { onDelete: 'set null' },
    ),
    /** DB type: DOMAIN hsn. */
    hsnCode: text('hsn_code').references((): AnyPgColumn => hsnCodes.code, {
      onDelete: 'restrict',
    }),
    isPersonalisable: boolean('is_personalisable').notNull().default(false),
    isPerishable: boolean('is_perishable').notNull().default(false),
    isFragile: boolean('is_fragile').notNull().default(false),
    requiresShipping: boolean('requires_shipping').notNull().default(true),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(10),
    /** Editorial force-override for the computed badge. */
    badgeOverride: text('badge_override').$type<ProductBadge>(),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    status: text('status').notNull().default('draft').$type<ProductStatus>(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** §7 correction 5. */
    legacyRef: text('legacy_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    updatedBy: uuid('updated_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_products_handle').on(t.handle).where(sql`deleted_at IS NULL`),
    index('idx_products_status')
      .on(t.status, t.publishedAt.desc())
      .where(sql`deleted_at IS NULL`),
    index('idx_products_designer').on(t.designerId).where(sql`deleted_at IS NULL`),
    index('idx_products_kind').on(t.kind).where(sql`deleted_at IS NULL`),
    index('idx_products_tags').using('gin', t.tags),
    index('idx_products_new')
      .on(t.publishedAt.desc())
      .where(sql`status = 'active' AND deleted_at IS NULL`),
    index('idx_products_search_trgm').using(
      'gin',
      sql`(title || ' ' || coalesce(subtitle,'')) gin_trgm_ops`,
    ),
    index('idx_products_fts').using(
      'gin',
      sql`to_tsvector('english', title || ' ' || coalesce(description,''))`,
    ),
    index('idx_products_legacy_ref').on(t.legacyRef).where(sql`legacy_ref IS NOT NULL`),
    check(
      'products_kind_check',
      sql`kind IN ('hamper','single_gift','personalised','gourmet','add_on','builder')`,
    ),
    check('products_status_check', sql`status IN ('active','draft','archived')`),
    check(
      'products_badge_override_check',
      sql`badge_override IN ('best_seller','new','limited','none')`,
    ),
    check('products_low_stock_threshold_check', sql`low_stock_threshold >= 0`),
    check(
      'product_active_needs_publish',
      sql`status <> 'active' OR published_at IS NOT NULL`,
    ),
    // No invoice without an HSN.
    check('product_active_needs_hsn', sql`status <> 'active' OR hsn_code IS NOT NULL`),
  ],
);

/* ------------------------------------------------------- product_variants */

export const VARIANT_STATUSES = ['active', 'inactive'] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references((): AnyPgColumn => products.id, { onDelete: 'cascade' }),
    /** Partial-unique (§7 correction 2). */
    sku: text('sku').notNull(),
    /** 'Signature' | 'Rose' | 'A5' */
    optionLabel: text('option_label').notNull().default('Standard'),
    /** DB type: DOMAIN handle. */
    optionValue: text('option_value').notNull().default('standard'),
    /** GST-INCLUSIVE (assumption A4, §3.2). */
    pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
    compareAtPaise: bigint('compare_at_paise', { mode: 'number' }),
    /** Never exposed on the storefront API. */
    costPaise: bigint('cost_paise', { mode: 'number' }),
    weightGrams: integer('weight_grams'),
    lengthMm: integer('length_mm'),
    widthMm: integer('width_mm'),
    heightMm: integer('height_mm'),
    /** Partial-unique. */
    barcode: text('barcode'),
    isDefault: boolean('is_default').notNull().default(false),
    position: integer('position').notNull().default(0),
    status: text('status').notNull().default('active').$type<VariantStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_variants_sku').on(t.sku).where(sql`deleted_at IS NULL`),
    uniqueIndex('uq_variants_barcode')
      .on(t.barcode)
      .where(sql`barcode IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex('uq_variant_option_per_product')
      .on(t.productId, t.optionValue)
      .where(sql`deleted_at IS NULL`),
    uniqueIndex('uq_one_default_variant_per_product')
      .on(t.productId)
      .where(sql`is_default AND deleted_at IS NULL`),
    index('idx_variants_product')
      .on(t.productId, t.position)
      .where(sql`deleted_at IS NULL`),
    index('idx_variants_sku_trgm').using('gin', sql`${t.sku} gin_trgm_ops`),
    check('product_variants_status_check', sql`status IN ('active','inactive')`),
    check(
      'product_variants_weight_grams_check',
      sql`weight_grams IS NULL OR weight_grams > 0`,
    ),
    check(
      'variant_compare_at_sane',
      sql`compare_at_paise IS NULL OR compare_at_paise >= price_paise`,
    ),
  ],
);

/* ---------------------------------------------------- product_collections */
/** M:N. Products are attached to BOTH parent and child collections (§1.2). */
export const productCollections = pgTable(
  'product_collections',
  {
    productId: uuid('product_id')
      .notNull()
      .references((): AnyPgColumn => products.id, { onDelete: 'cascade' }),
    collectionId: uuid('collection_id')
      .notNull()
      .references((): AnyPgColumn => collections.id, { onDelete: 'cascade' }),
    /** Manual merchandising order. */
    position: integer('position').notNull().default(0),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.collectionId] }),
    // The storefront's hottest query: products in a collection, ordered.
    index('idx_product_collections_listing').on(t.collectionId, t.position, t.productId),
  ],
);

/* ----------------------------------------------------------- product_media */

export const productMedia = pgTable(
  'product_media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references((): AnyPgColumn => products.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'cascade',
    }),
    mediaId: uuid('media_id')
      .notNull()
      .references((): AnyPgColumn => mediaAssets.id, { onDelete: 'restrict' }),
    altText: text('alt_text'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_product_media_product').on(t.productId, t.position),
    // SQL-only predicate: coalesce(variant_id, '000...0'::uuid) in the index key.
    uniqueIndex('uq_product_media_once').on(
      t.productId,
      t.mediaId,
      sql`coalesce(variant_id,'00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
  ],
);

/* --------------------------------------------------- product_content_items */
/** The "what's inside" bullets, authored per product. */
export const productContentItems = pgTable(
  'product_content_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references((): AnyPgColumn => products.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('idx_product_content_product').on(t.productId, t.position)],
);

/* ---------------------------------------------------------- product_stats */
/** Denormalised read-model. Refreshed by job; safe to TRUNCATE and rebuild. */
export const productStats = pgTable(
  'product_stats',
  {
    productId: uuid('product_id')
      .primaryKey()
      .references((): AnyPgColumn => products.id, { onDelete: 'cascade' }),
    ratingAvg: numeric('rating_avg', { precision: 2, scale: 1 }),
    reviewCount: integer('review_count').notNull().default(0),
    unitsSold: integer('units_sold').notNull().default(0),
    unitsSold30d: integer('units_sold_30d').notNull().default(0),
    returnRateBp: integer('return_rate_bp').notNull().default(0),
    revenuePaise: bigint('revenue_paise', { mode: 'number' }).notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_product_stats_bestsellers').on(t.unitsSold30d.desc()),
    check(
      'product_stats_rating_avg_check',
      sql`rating_avg IS NULL OR rating_avg BETWEEN 1.0 AND 5.0`,
    ),
  ],
);

/* ----------------------------------------------------------- hamper_items */
/** Raw components that go INTO hampers. Stock items, not sellable products. */

export const HAMPER_ITEM_UNITS = ['pcs', 'box', 'pack', 'kg', 'g', 'ml', 'l'] as const;
export type HamperItemUnit = (typeof HAMPER_ITEM_UNITS)[number];

export const hamperItems = pgTable(
  'hamper_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Partial-unique. */
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    supplierId: uuid('supplier_id').references((): AnyPgColumn => suppliers.id, {
      onDelete: 'set null',
    }),
    /** Gourmet | Décor | Packaging | Beverage | Wellness */
    category: text('category'),
    costPaise: bigint('cost_paise', { mode: 'number' }).notNull().default(0),
    unit: text('unit').notNull().default('pcs').$type<HamperItemUnit>(),
    weightGrams: integer('weight_grams'),
    hsnCode: text('hsn_code').references((): AnyPgColumn => hsnCodes.code, {
      onDelete: 'restrict',
    }),
    isPerishable: boolean('is_perishable').notNull().default(false),
    shelfLifeDays: integer('shelf_life_days'),
    status: text('status').notNull().default('active').$type<VariantStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_hamper_items_sku').on(t.sku).where(sql`deleted_at IS NULL`),
    index('idx_hamper_items_supplier').on(t.supplierId).where(sql`deleted_at IS NULL`),
    check('hamper_items_unit_check', sql`unit IN ('pcs','box','pack','kg','g','ml','l')`),
    check('hamper_items_status_check', sql`status IN ('active','inactive')`),
  ],
);

/* ------------------------------------------------------ product_bom_lines */
/** Bill of materials: what a hamper variant is made of. */
export const productBomLines = pgTable(
  'product_bom_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    variantId: uuid('variant_id')
      .notNull()
      .references((): AnyPgColumn => productVariants.id, { onDelete: 'cascade' }),
    hamperItemId: uuid('hamper_item_id').references((): AnyPgColumn => hamperItems.id, {
      onDelete: 'restrict',
    }),
    componentVariantId: uuid('component_variant_id').references(
      (): AnyPgColumn => productVariants.id,
      { onDelete: 'restrict' },
    ),
    quantity: numeric('quantity', { precision: 10, scale: 3 }).notNull(),
    isSubstitutable: boolean('is_substitutable').notNull().default(false),
  },
  (t) => [
    index('idx_bom_variant').on(t.variantId),
    index('idx_bom_item').on(t.hamperItemId),
    check('product_bom_lines_quantity_check', sql`quantity > 0`),
    check(
      'bom_exactly_one_component',
      sql`(hamper_item_id IS NOT NULL)::int + (component_variant_id IS NOT NULL)::int = 1`,
    ),
    check('bom_no_self_reference', sql`component_variant_id IS DISTINCT FROM variant_id`),
  ],
);

/* ---------------------------------------------------------------- add_ons */

export const ADD_ON_KINDS = [
  'packaging',
  'message',
  'fresh',
  'bakery',
  'digital',
  'engraving',
  'other',
] as const;
export type AddOnKind = (typeof ADD_ON_KINDS)[number];

export const addOns = pgTable(
  'add_ons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: DOMAIN handle. 'card' | 'engraving' | 'premium'. Partial-unique. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('other').$type<AddOnKind>(),
    /** GST-inclusive. */
    pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
    hsnCode: text('hsn_code').references((): AnyPgColumn => hsnCodes.code, {
      onDelete: 'restrict',
    }),
    /** Engraving text, card message. */
    requiresInput: boolean('requires_input').notNull().default(false),
    inputCharLimit: integer('input_char_limit'),
    leadTimeHours: integer('lead_time_hours').notNull().default(0),
    status: text('status').notNull().default('active').$type<VariantStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_add_ons_code').on(t.code).where(sql`deleted_at IS NULL`),
    check(
      'add_ons_kind_check',
      sql`kind IN ('packaging','message','fresh','bakery','digital','engraving','other')`,
    ),
    check('add_ons_status_check', sql`status IN ('active','inactive')`),
  ],
);

/** Which add-ons are offered on which product. Empty = the global default set. */
export const productAddOns = pgTable(
  'product_add_ons',
  {
    productId: uuid('product_id')
      .notNull()
      .references((): AnyPgColumn => products.id, { onDelete: 'cascade' }),
    addOnId: uuid('add_on_id')
      .notNull()
      .references((): AnyPgColumn => addOns.id, { onDelete: 'cascade' }),
    priceOverridePaise: bigint('price_override_paise', { mode: 'number' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productId, t.addOnId] })],
);

/* ---------------------------------------------- personalisation_templates */

export const PERSONALISATION_METHODS = [
  'engraving',
  'embroidery',
  'print',
  'digital',
  'laser',
] as const;
export type PersonalisationMethod = (typeof PERSONALISATION_METHODS)[number];

export const PERSONALISATION_STATUSES = ['active', 'draft', 'archived'] as const;
export type PersonalisationStatus = (typeof PERSONALISATION_STATUSES)[number];

export const personalisationTemplates = pgTable(
  'personalisation_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Partial-unique. */
    name: text('name').notNull(),
    method: text('method').notNull().$type<PersonalisationMethod>(),
    turnaroundHours: integer('turnaround_hours').notNull().default(24),
    charLimit: integer('char_limit'),
    allowsImage: boolean('allows_image').notNull().default(false),
    proofRequired: boolean('proof_required').notNull().default(false),
    surchargePaise: bigint('surcharge_paise', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('draft').$type<PersonalisationStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_personalisation_templates_name')
      .on(t.name)
      .where(sql`deleted_at IS NULL`),
    check(
      'personalisation_templates_method_check',
      sql`method IN ('engraving','embroidery','print','digital','laser')`,
    ),
    check(
      'personalisation_templates_status_check',
      sql`status IN ('active','draft','archived')`,
    ),
    check('personalisation_templates_turnaround_check', sql`turnaround_hours > 0`),
    check(
      'personalisation_templates_char_limit_check',
      sql`char_limit IS NULL OR char_limit > 0`,
    ),
  ],
);

export const productPersonalisationTemplates = pgTable(
  'product_personalisation_templates',
  {
    productId: uuid('product_id')
      .notNull()
      .references((): AnyPgColumn => products.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id')
      .notNull()
      .references((): AnyPgColumn => personalisationTemplates.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.productId, t.templateId] })],
);

/* ------------------------------------------------------- builder_templates */
/** §1.4 — per-STEP min/max, which the admin's single `slots:int` cannot express. */

export const BUILDER_TEMPLATE_STATUSES = ['live', 'draft', 'archived'] as const;
export type BuilderTemplateStatus = (typeof BUILDER_TEMPLATE_STATUSES)[number];

export const builderTemplates = pgTable(
  'builder_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: DOMAIN handle. Partial-unique. */
    handle: text('handle').notNull(),
    name: text('name').notNull(),
    basePricePaise: bigint('base_price_paise', { mode: 'number' }).notNull().default(0),
    maxWeightGrams: integer('max_weight_grams'),
    status: text('status').notNull().default('draft').$type<BuilderTemplateStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_builder_templates_handle').on(t.handle).where(sql`deleted_at IS NULL`),
    check('builder_templates_status_check', sql`status IN ('live','draft','archived')`),
  ],
);

export const BUILDER_STEP_KINDS = [
  'packaging',
  'items',
  'personalisation',
  'review',
] as const;
export type BuilderStepKind = (typeof BUILDER_STEP_KINDS)[number];

export const builderTemplateSteps = pgTable(
  'builder_template_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references((): AnyPgColumn => builderTemplates.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** 'Snacks & chocolates' */
    title: text('title').notNull(),
    /** 'Choose 2 to 4' */
    note: text('note'),
    minChoices: integer('min_choices').notNull().default(0),
    maxChoices: integer('max_choices').notNull().default(1),
    stepKind: text('step_kind').notNull().default('items').$type<BuilderStepKind>(),
  },
  (t) => [
    uniqueIndex('builder_template_steps_template_id_position_key').on(
      t.templateId,
      t.position,
    ),
    check(
      'builder_template_steps_step_kind_check',
      sql`step_kind IN ('packaging','items','personalisation','review')`,
    ),
    check('builder_template_steps_min_choices_check', sql`min_choices >= 0`),
    check('builder_template_steps_max_choices_check', sql`max_choices >= 1`),
    check('builder_step_range', sql`max_choices >= min_choices`),
  ],
);

export const builderStepOptions = pgTable(
  'builder_step_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stepId: uuid('step_id')
      .notNull()
      .references((): AnyPgColumn => builderTemplateSteps.id, { onDelete: 'cascade' }),
    hamperItemId: uuid('hamper_item_id').references((): AnyPgColumn => hamperItems.id, {
      onDelete: 'cascade',
    }),
    variantId: uuid('variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'cascade',
    }),
    packagingId: uuid('packaging_id').references(
      (): AnyPgColumn => packagingMaterials.id,
      { onDelete: 'cascade' },
    ),
    label: text('label').notNull(),
    pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
    weightGrams: integer('weight_grams'),
    position: integer('position').notNull().default(0),
    isAvailable: boolean('is_available').notNull().default(true),
  },
  (t) => [
    index('idx_builder_options_step').on(t.stepId, t.position),
    check(
      'builder_option_exactly_one_source',
      sql`(hamper_item_id IS NOT NULL)::int + (variant_id IS NOT NULL)::int + (packaging_id IS NOT NULL)::int = 1`,
    ),
  ],
);

/* ---------------------------------------------------------------- reviews */

export const REVIEW_STATUSES = ['pending', 'published', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references((): AnyPgColumn => products.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, {
      onDelete: 'set null',
    }),
    /** Verified-purchase link. */
    orderLineId: uuid('order_line_id').references((): AnyPgColumn => orderLines.id, {
      onDelete: 'set null',
    }),
    authorName: text('author_name').notNull(),
    rating: smallint('rating').notNull(),
    title: text('title'),
    body: text('body'),
    isFeatured: boolean('is_featured').notNull().default(false),
    status: text('status').notNull().default('pending').$type<ReviewStatus>(),
    moderatedBy: uuid('moderated_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_reviews_product').on(t.productId, t.status, t.submittedAt.desc()),
    index('idx_reviews_queue').on(t.submittedAt.desc()).where(sql`status = 'pending'`),
    uniqueIndex('uq_review_one_per_line')
      .on(t.orderLineId)
      .where(sql`order_line_id IS NOT NULL AND deleted_at IS NULL`),
    check('reviews_rating_check', sql`rating BETWEEN 1 AND 5`),
    check('reviews_status_check', sql`status IN ('pending','published','rejected')`),
  ],
);

/* -------------------------------------------------------------- relations */

export const productsRelations = relations(products, ({ one, many }) => ({
  designer: one(designers, {
    fields: [products.designerId],
    references: [designers.id],
  }),
  primaryCollection: one(collections, {
    fields: [products.primaryCollectionId],
    references: [collections.id],
  }),
  hsn: one(hsnCodes, { fields: [products.hsnCode], references: [hsnCodes.code] }),
  stats: one(productStats, {
    fields: [products.id],
    references: [productStats.productId],
  }),
  variants: many(productVariants),
  collections: many(productCollections),
  media: many(productMedia),
  contentItems: many(productContentItems),
  addOns: many(productAddOns),
  personalisationTemplates: many(productPersonalisationTemplates),
  reviews: many(reviews),
}));

export const productVariantsRelations = relations(productVariants, ({ one, many }) => ({
  product: one(products, {
    fields: [productVariants.productId],
    references: [products.id],
  }),
  bomLines: many(productBomLines),
}));

export const collectionsRelations = relations(collections, ({ one, many }) => ({
  parent: one(collections, {
    fields: [collections.parentId],
    references: [collections.id],
    relationName: 'collection_parent',
  }),
  children: many(collections, { relationName: 'collection_parent' }),
  designer: one(designers, {
    fields: [collections.designerId],
    references: [designers.id],
  }),
  products: many(productCollections),
}));

export const productCollectionsRelations = relations(productCollections, ({ one }) => ({
  product: one(products, {
    fields: [productCollections.productId],
    references: [products.id],
  }),
  collection: one(collections, {
    fields: [productCollections.collectionId],
    references: [collections.id],
  }),
}));

export const productMediaRelations = relations(productMedia, ({ one }) => ({
  product: one(products, {
    fields: [productMedia.productId],
    references: [products.id],
  }),
  variant: one(productVariants, {
    fields: [productMedia.variantId],
    references: [productVariants.id],
  }),
  media: one(mediaAssets, {
    fields: [productMedia.mediaId],
    references: [mediaAssets.id],
  }),
}));

export const productContentItemsRelations = relations(productContentItems, ({ one }) => ({
  product: one(products, {
    fields: [productContentItems.productId],
    references: [products.id],
  }),
}));

export const productStatsRelations = relations(productStats, ({ one }) => ({
  product: one(products, {
    fields: [productStats.productId],
    references: [products.id],
  }),
}));

export const designersRelations = relations(designers, ({ many }) => ({
  products: many(products),
  collections: many(collections),
}));

export const productBomLinesRelations = relations(productBomLines, ({ one }) => ({
  variant: one(productVariants, {
    fields: [productBomLines.variantId],
    references: [productVariants.id],
  }),
  hamperItem: one(hamperItems, {
    fields: [productBomLines.hamperItemId],
    references: [hamperItems.id],
  }),
}));

export const productAddOnsRelations = relations(productAddOns, ({ one }) => ({
  product: one(products, {
    fields: [productAddOns.productId],
    references: [products.id],
  }),
  addOn: one(addOns, { fields: [productAddOns.addOnId], references: [addOns.id] }),
}));

export const productPersonalisationTemplatesRelations = relations(
  productPersonalisationTemplates,
  ({ one }) => ({
    product: one(products, {
      fields: [productPersonalisationTemplates.productId],
      references: [products.id],
    }),
    template: one(personalisationTemplates, {
      fields: [productPersonalisationTemplates.templateId],
      references: [personalisationTemplates.id],
    }),
  }),
);

export const builderTemplatesRelations = relations(builderTemplates, ({ many }) => ({
  steps: many(builderTemplateSteps),
}));

export const builderTemplateStepsRelations = relations(
  builderTemplateSteps,
  ({ one, many }) => ({
    template: one(builderTemplates, {
      fields: [builderTemplateSteps.templateId],
      references: [builderTemplates.id],
    }),
    options: many(builderStepOptions),
  }),
);

export const builderStepOptionsRelations = relations(builderStepOptions, ({ one }) => ({
  step: one(builderTemplateSteps, {
    fields: [builderStepOptions.stepId],
    references: [builderTemplateSteps.id],
  }),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  product: one(products, { fields: [reviews.productId], references: [products.id] }),
  customer: one(customers, { fields: [reviews.customerId], references: [customers.id] }),
}));

/* ------------------------------------------------------------------ types */

export type Designer = typeof designers.$inferSelect;
export type NewDesigner = typeof designers.$inferInsert;
export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ProductVariant = typeof productVariants.$inferSelect;
export type NewProductVariant = typeof productVariants.$inferInsert;
export type ProductCollection = typeof productCollections.$inferSelect;
export type NewProductCollection = typeof productCollections.$inferInsert;
export type ProductMedia = typeof productMedia.$inferSelect;
export type NewProductMedia = typeof productMedia.$inferInsert;
export type ProductContentItem = typeof productContentItems.$inferSelect;
export type NewProductContentItem = typeof productContentItems.$inferInsert;
export type ProductStat = typeof productStats.$inferSelect;
export type NewProductStat = typeof productStats.$inferInsert;
export type HamperItem = typeof hamperItems.$inferSelect;
export type NewHamperItem = typeof hamperItems.$inferInsert;
export type ProductBomLine = typeof productBomLines.$inferSelect;
export type NewProductBomLine = typeof productBomLines.$inferInsert;
export type AddOn = typeof addOns.$inferSelect;
export type NewAddOn = typeof addOns.$inferInsert;
export type ProductAddOn = typeof productAddOns.$inferSelect;
export type NewProductAddOn = typeof productAddOns.$inferInsert;
export type PersonalisationTemplate = typeof personalisationTemplates.$inferSelect;
export type NewPersonalisationTemplate = typeof personalisationTemplates.$inferInsert;
export type ProductPersonalisationTemplate =
  typeof productPersonalisationTemplates.$inferSelect;
export type NewProductPersonalisationTemplate =
  typeof productPersonalisationTemplates.$inferInsert;
export type BuilderTemplate = typeof builderTemplates.$inferSelect;
export type NewBuilderTemplate = typeof builderTemplates.$inferInsert;
export type BuilderTemplateStep = typeof builderTemplateSteps.$inferSelect;
export type NewBuilderTemplateStep = typeof builderTemplateSteps.$inferInsert;
export type BuilderStepOption = typeof builderStepOptions.$inferSelect;
export type NewBuilderStepOption = typeof builderStepOptions.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
