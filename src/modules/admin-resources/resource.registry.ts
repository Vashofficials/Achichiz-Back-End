/**
 * THE REGISTRY. One entry per admin list screen; one set of handlers for all of them.
 *
 * ## Adding a resource
 *
 * 1. Add a `defineResource({...})` block below. It needs, at minimum: `slug`,
 *    `module` (which RBAC module gates it — this is what wires up the permission
 *    checks for all seven of its routes), `table`, `primaryKey`, `columns`,
 *    `listColumns`, `fields`, `sortable`, `defaultSort`.
 * 2. List it in `RESOURCES` at the bottom.
 * 3. That is the whole change. `admin-resources.routes.ts` loops over the
 *    registry and calls `defineRoute` seven times per entry, so the endpoints,
 *    the OpenAPI operations, the zod bodies and the permission gates all appear
 *    together. There is no per-resource handler to write.
 *
 * ## What each part controls
 *
 * | Field | Reaches |
 * |---|---|
 * | `columns` | the `?fields=` projection allowlist — nothing outside it is selectable |
 * | `searchable` | the OR-ed `ILIKE` for `?q=` |
 * | `filterable` | `WHERE`; each entry pins its own operators and value type |
 * | `sortable` | `ORDER BY`; unknown fields are a 400, never a silent fallback |
 * | `fields` | the create/update zod bodies AND the console's form spec (§2.6) |
 * | `bulkActions` | `POST /{slug}/bulk`; each declares the extra RBAC action it needs |
 *
 * ## The twelve registered here
 *
 * products, productVariants, collections, designers · customers · coupons,
 * giftCards · banners, faqs, testimonials · suppliers, warehouses.
 *
 * They were chosen to cover every mechanism the engine has: soft delete
 * (`products`) versus status-archive (`banners`), money columns, enums, text
 * arrays, foreign-key references, per-resource page sizes, and all four RBAC
 * modules the generic screens use (`catalogue`, `customers`, `promotions`,
 * `content`, `inventory`). The remaining ~46 slugs in 02_admin_api.md §1 are the
 * same shape.
 */

import {
  addOns,
  banners,
  collections,
  coupons,
  customers,
  designers,
  faqs,
  giftCards,
  hamperItems,
  personalisationTemplates,
  productVariants,
  products,
  suppliers,
  testimonials,
  warehouses,
} from '../../db/schema/index.js';
import type { FilterSpec, ResourceDescriptor } from './resource.types.js';

/** Identity, so an entry is checked against `ResourceDescriptor` where it is written. */
const defineResource = (descriptor: ResourceDescriptor): ResourceDescriptor => descriptor;

/** The operator sets almost every filter wants. Spelled out so nothing is implicit. */
const EXACT = ['eq', 'ne', 'in'] as const;
const EXACT_NULLABLE = ['eq', 'ne', 'in', 'isNull', 'notNull'] as const;
const RANGE = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
const TEXTUAL = ['eq', 'contains'] as const;

const enumFilter = (
  key: string,
  label: string,
  column: FilterSpec['column'],
  options: readonly string[],
): FilterSpec => ({ key, label, column, valueKind: 'string', operators: [...EXACT], options });

const refFilter = (key: string, label: string, column: FilterSpec['column']): FilterSpec => ({
  key,
  label,
  column,
  valueKind: 'uuid',
  operators: [...EXACT_NULLABLE],
});

const boolFilter = (key: string, label: string, column: FilterSpec['column']): FilterSpec => ({
  key,
  label,
  column,
  valueKind: 'boolean',
  operators: ['eq'],
});

const dateFilter = (key: string, label: string, column: FilterSpec['column']): FilterSpec => ({
  key,
  label,
  column,
  valueKind: 'date',
  operators: [...RANGE],
});

const moneyFilter = (key: string, label: string, column: FilterSpec['column']): FilterSpec => ({
  key,
  label,
  column,
  valueKind: 'number',
  operators: [...RANGE],
});

/* ================================================================ catalogue */

const productsResource = defineResource({
  slug: 'products',
  title: 'Products',
  description: 'The sellable catalogue. `kind` is a fulfilment class, not the storefront category.',
  group: 'Catalogue',
  module: 'catalogue',
  name: { singular: 'Product', plural: 'Products' },
  tag: 'Admin catalogue',
  table: products,
  primaryKey: products.id,
  columns: {
    id: products.id,
    handle: products.handle,
    title: products.title,
    subtitle: products.subtitle,
    description: products.description,
    kind: products.kind,
    designerId: products.designerId,
    primaryCollectionId: products.primaryCollectionId,
    hsnCode: products.hsnCode,
    isPersonalisable: products.isPersonalisable,
    isPerishable: products.isPerishable,
    isFragile: products.isFragile,
    requiresShipping: products.requiresShipping,
    lowStockThreshold: products.lowStockThreshold,
    badgeOverride: products.badgeOverride,
    tags: products.tags,
    status: products.status,
    publishedAt: products.publishedAt,
    createdAt: products.createdAt,
    updatedAt: products.updatedAt,
  },
  listColumns: ['id', 'title', 'handle', 'kind', 'designerId', 'status', 'isPersonalisable', 'publishedAt', 'updatedAt'],
  fields: [
    { key: 'handle', label: 'Handle', kind: 'text', required: true, max: 120, help: 'URL slug. Lower case, hyphenated. Unique among live products.' },
    { key: 'title', label: 'Title', kind: 'text', required: true, max: 200 },
    { key: 'subtitle', label: 'Subtitle', kind: 'text', required: false, max: 200 },
    { key: 'description', label: 'Description', kind: 'long', required: false },
    { key: 'kind', label: 'Fulfilment kind', kind: 'enum', required: true, options: ['hamper', 'single_gift', 'personalised', 'gourmet', 'add_on', 'builder'] },
    { key: 'designerId', label: 'Brand / designer', kind: 'reference', required: false, reference: { resource: 'designers', labelField: 'name' } },
    { key: 'primaryCollectionId', label: 'Primary collection', kind: 'reference', required: false, reference: { resource: 'collections', labelField: 'title' }, help: 'Breadcrumb only — the real taxonomy is the product↔collection join.' },
    { key: 'hsnCode', label: 'HSN code', kind: 'text', required: false, max: 8, help: 'Required before the product can go active — there is no invoice without one.' },
    { key: 'isPersonalisable', label: 'Personalisable', kind: 'boolean', required: false },
    { key: 'isPerishable', label: 'Perishable', kind: 'boolean', required: false },
    { key: 'isFragile', label: 'Fragile', kind: 'boolean', required: false },
    { key: 'requiresShipping', label: 'Requires shipping', kind: 'boolean', required: false },
    { key: 'lowStockThreshold', label: 'Low-stock threshold', kind: 'number', required: false, min: 0, max: 100_000 },
    { key: 'badgeOverride', label: 'Badge override', kind: 'enum', required: false, options: ['best_seller', 'new', 'limited', 'none'] },
    { key: 'tags', label: 'Tags', kind: 'array', required: false, of: { key: 'tag', label: 'Tag', kind: 'text', required: true, max: 40 } },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['active', 'draft', 'archived'] },
    { key: 'publishedAt', label: 'Published at', kind: 'datetime', required: false, help: 'Must be set before status can be `active`.' },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['title', 'handle', 'subtitle'],
  filterable: [
    enumFilter('status', 'Status', products.status, ['active', 'draft', 'archived']),
    enumFilter('kind', 'Kind', products.kind, ['hamper', 'single_gift', 'personalised', 'gourmet', 'add_on', 'builder']),
    refFilter('designerId', 'Brand / designer', products.designerId),
    refFilter('primaryCollectionId', 'Collection', products.primaryCollectionId),
    boolFilter('isPersonalisable', 'Personalisable', products.isPersonalisable),
    dateFilter('publishedAt', 'Published', products.publishedAt),
  ],
  sortable: ['title', 'handle', 'status', 'kind', 'publishedAt', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'updatedAt', direction: 'desc' },
  defaultPerPage: 12,
  softDeleteColumn: products.deletedAt,
  bulkActions: [
    { action: 'publish', label: 'Publish', requires: 'edit', set: { status: 'active' }, description: 'Fails for any product with no HSN code or no publish date — the database enforces both.' },
    { action: 'unpublish', label: 'Move to draft', requires: 'edit', set: { status: 'draft' } },
    { action: 'archive', label: 'Archive', requires: 'delete', set: { status: 'archived' }, destructive: true },
  ],
});

const productVariantsResource = defineResource({
  slug: 'product-variants',
  title: 'Product variants',
  description: 'SKU-level rows. Prices are GST-INCLUSIVE integer paise.',
  group: 'Catalogue',
  module: 'catalogue',
  name: { singular: 'ProductVariant', plural: 'ProductVariants' },
  tag: 'Admin catalogue',
  table: productVariants,
  primaryKey: productVariants.id,
  columns: {
    id: productVariants.id,
    productId: productVariants.productId,
    sku: productVariants.sku,
    optionLabel: productVariants.optionLabel,
    optionValue: productVariants.optionValue,
    pricePaise: productVariants.pricePaise,
    compareAtPaise: productVariants.compareAtPaise,
    costPaise: productVariants.costPaise,
    weightGrams: productVariants.weightGrams,
    lengthMm: productVariants.lengthMm,
    widthMm: productVariants.widthMm,
    heightMm: productVariants.heightMm,
    barcode: productVariants.barcode,
    isDefault: productVariants.isDefault,
    position: productVariants.position,
    status: productVariants.status,
    createdAt: productVariants.createdAt,
    updatedAt: productVariants.updatedAt,
  },
  listColumns: ['id', 'sku', 'productId', 'optionLabel', 'pricePaise', 'weightGrams', 'status', 'updatedAt'],
  fields: [
    { key: 'productId', label: 'Product', kind: 'reference', required: true, reference: { resource: 'products', labelField: 'title' } },
    { key: 'sku', label: 'SKU', kind: 'text', required: true, max: 64 },
    { key: 'optionLabel', label: 'Option label', kind: 'text', required: true, max: 80, help: '`Signature`, `Rose`, `A5`.' },
    { key: 'optionValue', label: 'Option value', kind: 'text', required: true, max: 80, help: 'Slug form. Unique per product.' },
    { key: 'pricePaise', label: 'Price', kind: 'money', required: true, unit: 'paise', help: 'GST-inclusive.' },
    { key: 'compareAtPaise', label: 'Compare-at price', kind: 'money', required: false, unit: 'paise', help: 'Must be ≥ price. The struck-through number.' },
    { key: 'costPaise', label: 'Cost', kind: 'money', required: false, unit: 'paise', help: 'Never exposed on the storefront API.' },
    { key: 'weightGrams', label: 'Weight', kind: 'number', required: false, unit: 'grams', min: 1, max: 1_000_000 },
    { key: 'lengthMm', label: 'Length', kind: 'number', required: false, unit: 'millimetres', min: 0, max: 100_000 },
    { key: 'widthMm', label: 'Width', kind: 'number', required: false, unit: 'millimetres', min: 0, max: 100_000 },
    { key: 'heightMm', label: 'Height', kind: 'number', required: false, unit: 'millimetres', min: 0, max: 100_000 },
    { key: 'barcode', label: 'Barcode', kind: 'text', required: false, max: 64 },
    { key: 'isDefault', label: 'Default variant', kind: 'boolean', required: false, help: 'At most one per product.' },
    { key: 'position', label: 'Position', kind: 'number', required: false, min: 0, max: 10_000 },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['active', 'inactive'] },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['sku', 'optionLabel', 'barcode'],
  filterable: [
    enumFilter('status', 'Status', productVariants.status, ['active', 'inactive']),
    refFilter('productId', 'Product', productVariants.productId),
    boolFilter('isDefault', 'Default', productVariants.isDefault),
    moneyFilter('pricePaise', 'Price (paise)', productVariants.pricePaise),
  ],
  sortable: ['sku', 'pricePaise', 'position', 'status', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'sku', direction: 'asc' },
  softDeleteColumn: productVariants.deletedAt,
  bulkActions: [
    { action: 'activate', label: 'Activate', requires: 'edit', set: { status: 'active' } },
    { action: 'deactivate', label: 'Deactivate', requires: 'edit', set: { status: 'inactive' }, destructive: true },
  ],
});

const collectionsResource = defineResource({
  slug: 'collections',
  title: 'Collections',
  description: 'One taxonomy table for categories, occasions, festivals, recipients, designer pages and edits.',
  group: 'Catalogue',
  module: 'catalogue',
  name: { singular: 'Collection', plural: 'Collections' },
  tag: 'Admin catalogue',
  table: collections,
  primaryKey: collections.id,
  columns: {
    id: collections.id,
    handle: collections.handle,
    kind: collections.kind,
    parentId: collections.parentId,
    title: collections.title,
    heading: collections.heading,
    subtext: collections.subtext,
    seoDescription: collections.seoDescription,
    designerId: collections.designerId,
    curator: collections.curator,
    sortOrder: collections.sortOrder,
    isFeatured: collections.isFeatured,
    status: collections.status,
    startsOn: collections.startsOn,
    endsOn: collections.endsOn,
    createdAt: collections.createdAt,
    updatedAt: collections.updatedAt,
  },
  listColumns: ['id', 'title', 'handle', 'kind', 'curator', 'status', 'startsOn', 'updatedAt'],
  fields: [
    { key: 'handle', label: 'Handle', kind: 'text', required: true, max: 120, help: 'Public route key. Unique among live collections.' },
    { key: 'kind', label: 'Kind', kind: 'enum', required: true, options: ['category', 'recipient', 'occasion', 'festival', 'designer', 'edit'] },
    { key: 'title', label: 'Nav title', kind: 'text', required: true, max: 160 },
    { key: 'heading', label: 'Page heading', kind: 'text', required: false, max: 200 },
    { key: 'subtext', label: 'Subtext', kind: 'long', required: false },
    { key: 'seoDescription', label: 'SEO description', kind: 'long', required: false, max: 500 },
    { key: 'parentId', label: 'Parent collection', kind: 'reference', required: false, reference: { resource: 'collections', labelField: 'title' } },
    { key: 'designerId', label: 'Designer', kind: 'reference', required: false, reference: { resource: 'designers', labelField: 'name' }, help: 'Only for `kind: designer`.' },
    { key: 'curator', label: 'Curator', kind: 'text', required: false, max: 120, help: 'Only for `kind: edit`.' },
    { key: 'sortOrder', label: 'Sort order', kind: 'number', required: false, min: 0, max: 10_000 },
    { key: 'isFeatured', label: 'Featured', kind: 'boolean', required: false },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['live', 'scheduled', 'draft', 'archived'] },
    { key: 'startsOn', label: 'Starts', kind: 'datetime', required: false, help: 'Required when status is `scheduled`.' },
    { key: 'endsOn', label: 'Ends', kind: 'datetime', required: false },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['title', 'handle', 'curator'],
  filterable: [
    enumFilter('status', 'Status', collections.status, ['live', 'scheduled', 'draft', 'archived']),
    enumFilter('kind', 'Kind', collections.kind, ['category', 'recipient', 'occasion', 'festival', 'designer', 'edit']),
    refFilter('parentId', 'Parent', collections.parentId),
    boolFilter('isFeatured', 'Featured', collections.isFeatured),
  ],
  sortable: ['title', 'handle', 'kind', 'sortOrder', 'status', 'startsOn', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'sortOrder', direction: 'asc' },
  softDeleteColumn: collections.deletedAt,
  bulkActions: [
    { action: 'publish', label: 'Make live', requires: 'edit', set: { status: 'live' } },
    { action: 'feature', label: 'Feature', requires: 'edit', set: { isFeatured: true } },
    { action: 'archive', label: 'Archive', requires: 'delete', set: { status: 'archived' }, destructive: true },
  ],
});

const designersResource = defineResource({
  slug: 'designers',
  title: 'Brands & designers',
  description: 'Partners. Commission is stored in basis points, not whole percent.',
  group: 'Catalogue',
  module: 'catalogue',
  name: { singular: 'Designer', plural: 'Designers' },
  tag: 'Admin catalogue',
  table: designers,
  primaryKey: designers.id,
  columns: {
    id: designers.id,
    handle: designers.handle,
    name: designers.name,
    kind: designers.kind,
    bio: designers.bio,
    commissionBp: designers.commissionBp,
    contactEmail: designers.contactEmail,
    contactPhone: designers.contactPhone,
    status: designers.status,
    createdAt: designers.createdAt,
    updatedAt: designers.updatedAt,
  },
  listColumns: ['id', 'name', 'handle', 'kind', 'commissionBp', 'contactEmail', 'status', 'updatedAt'],
  fields: [
    { key: 'handle', label: 'Handle', kind: 'text', required: true, max: 120 },
    { key: 'name', label: 'Partner', kind: 'text', required: true, max: 160 },
    { key: 'kind', label: 'Type', kind: 'enum', required: true, options: ['designer', 'brand', 'celebrity', 'artisan_cluster'] },
    { key: 'bio', label: 'Bio', kind: 'long', required: false },
    { key: 'commissionBp', label: 'Commission', kind: 'percent', required: false, unit: 'basis_points', max: 10_000, help: 'The console shows whole percent; the column is basis points. 800 = 8%.' },
    { key: 'contactEmail', label: 'Contact email', kind: 'text', required: false, max: 254 },
    { key: 'contactPhone', label: 'Contact phone', kind: 'text', required: false, max: 20 },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['active', 'paused', 'archived'] },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['name', 'handle', 'contactEmail'],
  filterable: [
    enumFilter('status', 'Status', designers.status, ['active', 'paused', 'archived']),
    enumFilter('kind', 'Type', designers.kind, ['designer', 'brand', 'celebrity', 'artisan_cluster']),
  ],
  sortable: ['name', 'handle', 'kind', 'commissionBp', 'status', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'name', direction: 'asc' },
  softDeleteColumn: designers.deletedAt,
  bulkActions: [
    { action: 'activate', label: 'Activate', requires: 'edit', set: { status: 'active' } },
    { action: 'pause', label: 'Pause', requires: 'edit', set: { status: 'paused' } },
    { action: 'archive', label: 'Archive', requires: 'delete', set: { status: 'archived' }, destructive: true },
  ],
});

/* ================================================================ customers */

const customersResource = defineResource({
  slug: 'customers',
  title: 'Customers',
  description:
    'Shoppers. Lifetime spend and order counts live in the `customer_stats` satellite, refreshed by a ' +
    'job, so they are not writable here.',
  group: 'Customers',
  module: 'customers',
  name: { singular: 'Customer', plural: 'Customers' },
  tag: 'Admin customers',
  table: customers,
  primaryKey: customers.id,
  columns: {
    id: customers.id,
    email: customers.email,
    mobile: customers.mobile,
    fullName: customers.fullName,
    birthday: customers.birthday,
    gender: customers.gender,
    segment: customers.segment,
    corporateAccountId: customers.corporateAccountId,
    defaultBillingGstin: customers.defaultBillingGstin,
    tags: customers.tags,
    marketingOptIn: customers.marketingOptIn,
    whatsappOptIn: customers.whatsappOptIn,
    acceptsCod: customers.acceptsCod,
    blockedAt: customers.blockedAt,
    blockedReason: customers.blockedReason,
    emailVerifiedAt: customers.emailVerifiedAt,
    mobileVerifiedAt: customers.mobileVerifiedAt,
    firstOrderAt: customers.firstOrderAt,
    lastOrderAt: customers.lastOrderAt,
    createdAt: customers.createdAt,
    updatedAt: customers.updatedAt,
  },
  listColumns: ['id', 'fullName', 'email', 'mobile', 'segment', 'tags', 'lastOrderAt', 'createdAt'],
  fields: [
    { key: 'fullName', label: 'Name', kind: 'text', required: false, max: 160 },
    { key: 'email', label: 'Email', kind: 'text', required: false, max: 254, help: 'Case-insensitive. At least one of email or mobile is required.' },
    { key: 'mobile', label: 'Mobile', kind: 'text', required: false, max: 10, help: 'Ten digits starting 6-9.' },
    { key: 'birthday', label: 'Birthday', kind: 'date', required: false },
    { key: 'gender', label: 'Gender', kind: 'enum', required: false, options: ['female', 'male', 'other', 'undisclosed'] },
    { key: 'segment', label: 'Segment', kind: 'enum', required: false, options: ['vip', 'loyal', 'new', 'at_risk', 'corporate_buyer'] },
    { key: 'corporateAccountId', label: 'Corporate account', kind: 'reference', required: false, reference: { resource: 'corporate-accounts', labelField: 'companyName' } },
    { key: 'defaultBillingGstin', label: 'Default billing GSTIN', kind: 'text', required: false, max: 15 },
    { key: 'tags', label: 'Tags', kind: 'array', required: false, of: { key: 'tag', label: 'Tag', kind: 'text', required: true, max: 40 } },
    { key: 'marketingOptIn', label: 'Marketing opt-in', kind: 'boolean', required: false },
    { key: 'whatsappOptIn', label: 'WhatsApp opt-in', kind: 'boolean', required: false },
    { key: 'acceptsCod', label: 'COD allowed', kind: 'boolean', required: false, help: 'Turn off for repeat RTO offenders.' },
    { key: 'blockedReason', label: 'Blocked reason', kind: 'long', required: false },
    { key: 'firstOrderAt', label: 'First order', kind: 'datetime', required: false, readOnly: true },
    { key: 'lastOrderAt', label: 'Last order', kind: 'datetime', required: false, readOnly: true },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['fullName', 'email', 'mobile'],
  filterable: [
    enumFilter('segment', 'Segment', customers.segment, ['vip', 'loyal', 'new', 'at_risk', 'corporate_buyer']),
    refFilter('corporateAccountId', 'Corporate account', customers.corporateAccountId),
    boolFilter('marketingOptIn', 'Marketing opt-in', customers.marketingOptIn),
    boolFilter('acceptsCod', 'COD allowed', customers.acceptsCod),
    { key: 'blockedAt', label: 'Blocked', column: customers.blockedAt, valueKind: 'date', operators: ['isNull', 'notNull', 'lt', 'gt'] },
    dateFilter('lastOrderAt', 'Last order', customers.lastOrderAt),
    dateFilter('createdAt', 'Joined', customers.createdAt),
  ],
  sortable: ['fullName', 'email', 'segment', 'lastOrderAt', 'firstOrderAt', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'createdAt', direction: 'desc' },
  defaultPerPage: 12,
  softDeleteColumn: customers.deletedAt,
  bulkActions: [
    { action: 'mark_vip', label: 'Mark VIP', requires: 'edit', set: { segment: 'vip' } },
    { action: 'block_cod', label: 'Disallow COD', requires: 'edit', set: { acceptsCod: false }, destructive: true },
    { action: 'allow_cod', label: 'Allow COD', requires: 'edit', set: { acceptsCod: true } },
  ],
});

/* =============================================================== promotions */

const couponsResource = defineResource({
  slug: 'coupons',
  title: 'Coupons',
  description:
    'Discount codes. `discountType` decides which value column is required — the database refuses a ' +
    'percent coupon with no basis points, which the console mock could represent and did.',
  group: 'Promotions',
  module: 'promotions',
  name: { singular: 'Coupon', plural: 'Coupons' },
  tag: 'Admin promotions',
  table: coupons,
  primaryKey: coupons.id,
  columns: {
    id: coupons.id,
    code: coupons.code,
    description: coupons.description,
    discountType: coupons.discountType,
    discountBp: coupons.discountBp,
    discountPaise: coupons.discountPaise,
    maxDiscountPaise: coupons.maxDiscountPaise,
    minOrderPaise: coupons.minOrderPaise,
    appliesTo: coupons.appliesTo,
    channels: coupons.channels,
    maxRedemptions: coupons.maxRedemptions,
    maxRedemptionsPerCustomer: coupons.maxRedemptionsPerCustomer,
    redemptionCount: coupons.redemptionCount,
    stackable: coupons.stackable,
    startsAt: coupons.startsAt,
    endsAt: coupons.endsAt,
    status: coupons.status,
    createdAt: coupons.createdAt,
    updatedAt: coupons.updatedAt,
  },
  listColumns: ['id', 'code', 'discountType', 'discountBp', 'discountPaise', 'minOrderPaise', 'redemptionCount', 'maxRedemptions', 'endsAt', 'status'],
  fields: [
    { key: 'code', label: 'Code', kind: 'text', required: true, max: 32, help: 'Upper case, 3-32 characters, `A-Z 0-9 _ -` only.' },
    { key: 'description', label: 'Description', kind: 'long', required: false },
    { key: 'discountType', label: 'Type', kind: 'enum', required: true, options: ['percent', 'flat', 'free_shipping', 'bogo', 'free_gift'] },
    { key: 'discountBp', label: 'Percent off', kind: 'percent', required: false, unit: 'basis_points', max: 10_000, help: 'Required for `percent`.' },
    { key: 'discountPaise', label: 'Flat discount', kind: 'money', required: false, unit: 'paise', help: 'Required for `flat`.' },
    { key: 'maxDiscountPaise', label: 'Cap', kind: 'money', required: false, unit: 'paise', help: 'Caps a percent coupon.' },
    { key: 'minOrderPaise', label: 'Minimum order', kind: 'money', required: false, unit: 'paise' },
    { key: 'appliesTo', label: 'Applies to', kind: 'enum', required: false, options: ['all', 'collections', 'products', 'first_order'] },
    { key: 'channels', label: 'Channels', kind: 'array', required: false, of: { key: 'channel', label: 'Channel', kind: 'text', required: true, max: 32 }, help: 'Empty means every channel.' },
    { key: 'maxRedemptions', label: 'Global limit', kind: 'number', required: false, min: 1, max: 10_000_000 },
    { key: 'maxRedemptionsPerCustomer', label: 'Per-customer limit', kind: 'number', required: false, min: 1, max: 1_000 },
    { key: 'redemptionCount', label: 'Redeemed', kind: 'number', required: false, readOnly: true, help: 'Claimed atomically at order creation. Never write it by hand.' },
    { key: 'stackable', label: 'Stackable', kind: 'boolean', required: false },
    { key: 'startsAt', label: 'Starts', kind: 'datetime', required: false },
    { key: 'endsAt', label: 'Ends', kind: 'datetime', required: false },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['active', 'scheduled', 'expired', 'paused', 'draft'] },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['code', 'description'],
  filterable: [
    enumFilter('status', 'Status', coupons.status, ['active', 'scheduled', 'expired', 'paused', 'draft']),
    enumFilter('discountType', 'Type', coupons.discountType, ['percent', 'flat', 'free_shipping', 'bogo', 'free_gift']),
    enumFilter('appliesTo', 'Applies to', coupons.appliesTo, ['all', 'collections', 'products', 'first_order']),
    boolFilter('stackable', 'Stackable', coupons.stackable),
    dateFilter('endsAt', 'Ends', coupons.endsAt),
    moneyFilter('minOrderPaise', 'Minimum order (paise)', coupons.minOrderPaise),
  ],
  sortable: ['code', 'discountType', 'redemptionCount', 'minOrderPaise', 'startsAt', 'endsAt', 'status', 'createdAt'],
  defaultSort: { field: 'createdAt', direction: 'desc' },
  softDeleteColumn: coupons.deletedAt,
  bulkActions: [
    { action: 'pause', label: 'Pause', requires: 'edit', set: { status: 'paused' } },
    { action: 'activate', label: 'Activate', requires: 'edit', set: { status: 'active' } },
    { action: 'expire', label: 'Expire', requires: 'delete', set: { status: 'expired' }, destructive: true },
  ],
});

const giftCardsResource = defineResource({
  slug: 'gift-cards',
  createUnsupported:
    'Gift cards are issued by a purchase, not created by hand. The card code is generated and hashed at issue time — code_hash and codeLast4 cannot be supplied by a client, so this endpoint could never succeed.',
  title: 'Gift cards',
  description:
    'Issued cards. The code itself is never stored — only its hash and the last four characters — so ' +
    'there is no endpoint, here or anywhere, that can show a customer their code again.',
  group: 'Promotions',
  module: 'promotions',
  name: { singular: 'GiftCard', plural: 'GiftCards' },
  tag: 'Admin promotions',
  table: giftCards,
  primaryKey: giftCards.id,
  columns: {
    id: giftCards.id,
    codeLast4: giftCards.codeLast4,
    initialValuePaise: giftCards.initialValuePaise,
    balancePaise: giftCards.balancePaise,
    currency: giftCards.currency,
    issuedToName: giftCards.issuedToName,
    issuedToEmail: giftCards.issuedToEmail,
    issuedToCustomerId: giftCards.issuedToCustomerId,
    purchaseOrderId: giftCards.purchaseOrderId,
    issuedAt: giftCards.issuedAt,
    expiresOn: giftCards.expiresOn,
    status: giftCards.status,
    createdAt: giftCards.createdAt,
    updatedAt: giftCards.updatedAt,
  },
  listColumns: ['id', 'codeLast4', 'initialValuePaise', 'balancePaise', 'issuedToName', 'issuedAt', 'expiresOn', 'status'],
  fields: [
    { key: 'codeLast4', label: 'Code (last 4)', kind: 'text', required: false, readOnly: true, max: 4, help: 'Display only. The full code exists nowhere on the server.' },
    { key: 'initialValuePaise', label: 'Face value', kind: 'money', required: true, unit: 'paise', min: 1 },
    { key: 'balancePaise', label: 'Balance', kind: 'money', required: false, readOnly: true, unit: 'paise', help: 'Moved only by redemption and top-up ledger rows.' },
    { key: 'issuedToName', label: 'Issued to', kind: 'text', required: false, max: 160 },
    { key: 'issuedToEmail', label: 'Issued to (email)', kind: 'text', required: false, max: 254 },
    { key: 'issuedToCustomerId', label: 'Customer', kind: 'reference', required: false, reference: { resource: 'customers', labelField: 'fullName' } },
    { key: 'expiresOn', label: 'Expires', kind: 'date', required: false },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['active', 'redeemed', 'expired', 'void'] },
    { key: 'issuedAt', label: 'Issued', kind: 'datetime', required: false, readOnly: true },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['issuedToName', 'issuedToEmail', 'codeLast4'],
  filterable: [
    enumFilter('status', 'Status', giftCards.status, ['active', 'redeemed', 'expired', 'void']),
    refFilter('issuedToCustomerId', 'Customer', giftCards.issuedToCustomerId),
    dateFilter('expiresOn', 'Expiry', giftCards.expiresOn),
    moneyFilter('balancePaise', 'Balance (paise)', giftCards.balancePaise),
  ],
  sortable: ['issuedAt', 'expiresOn', 'balancePaise', 'initialValuePaise', 'status', 'createdAt'],
  defaultSort: { field: 'issuedAt', direction: 'desc' },
  // No `deleted_at` on this table — a gift card is money, so it is voided, never removed.
  archiveStatus: { column: giftCards.status, value: 'void' },
  bulkActions: [
    { action: 'void', label: 'Void', requires: 'delete', set: { status: 'void' }, destructive: true, description: 'Stops the card being redeemable. The balance ledger is untouched.' },
  ],
});

/* ================================================================== content */

const bannersResource = defineResource({
  slug: 'banners',
  title: 'Banners',
  description: 'Storefront banners. Clicks and CTR are analytics and live in `banner_stats_daily`.',
  group: 'Content & Storefront',
  module: 'content',
  name: { singular: 'Banner', plural: 'Banners' },
  tag: 'Admin content',
  table: banners,
  primaryKey: banners.id,
  columns: {
    id: banners.id,
    title: banners.title,
    subtitle: banners.subtitle,
    placement: banners.placement,
    device: banners.device,
    mediaId: banners.mediaId,
    mobileMediaId: banners.mobileMediaId,
    linkUrl: banners.linkUrl,
    collectionId: banners.collectionId,
    ctaLabel: banners.ctaLabel,
    position: banners.position,
    startsAt: banners.startsAt,
    endsAt: banners.endsAt,
    status: banners.status,
    createdAt: banners.createdAt,
    updatedAt: banners.updatedAt,
  },
  listColumns: ['id', 'title', 'placement', 'device', 'startsAt', 'endsAt', 'position', 'status'],
  fields: [
    { key: 'title', label: 'Title', kind: 'text', required: true, max: 200 },
    { key: 'subtitle', label: 'Subtitle', kind: 'text', required: false, max: 300 },
    { key: 'placement', label: 'Placement', kind: 'enum', required: true, options: ['homepage_hero', 'category_top', 'cart_strip', 'pdp_ribbon', 'announcement_bar'] },
    { key: 'device', label: 'Device', kind: 'enum', required: false, options: ['all', 'desktop', 'mobile'] },
    { key: 'mediaId', label: 'Image', kind: 'reference', required: false, reference: { resource: 'media', labelField: 'fileName' } },
    { key: 'mobileMediaId', label: 'Mobile image', kind: 'reference', required: false, reference: { resource: 'media', labelField: 'fileName' } },
    { key: 'linkUrl', label: 'Link URL', kind: 'text', required: false, max: 500 },
    { key: 'collectionId', label: 'Links to collection', kind: 'reference', required: false, reference: { resource: 'collections', labelField: 'title' } },
    { key: 'ctaLabel', label: 'CTA label', kind: 'text', required: false, max: 60 },
    { key: 'position', label: 'Position', kind: 'number', required: false, min: 0, max: 1_000 },
    { key: 'startsAt', label: 'Starts', kind: 'datetime', required: false },
    { key: 'endsAt', label: 'Ends', kind: 'datetime', required: false },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['live', 'scheduled', 'expired', 'draft'] },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['title', 'subtitle', 'ctaLabel'],
  filterable: [
    enumFilter('status', 'Status', banners.status, ['live', 'scheduled', 'expired', 'draft']),
    enumFilter('placement', 'Placement', banners.placement, ['homepage_hero', 'category_top', 'cart_strip', 'pdp_ribbon', 'announcement_bar']),
    enumFilter('device', 'Device', banners.device, ['all', 'desktop', 'mobile']),
    dateFilter('startsAt', 'Starts', banners.startsAt),
    dateFilter('endsAt', 'Ends', banners.endsAt),
  ],
  sortable: ['title', 'placement', 'position', 'startsAt', 'endsAt', 'status', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'position', direction: 'asc' },
  // No `deleted_at` column: a banner is retired by status, and `banner_stats_daily`
  // keeps a foreign key to it either way.
  archiveStatus: { column: banners.status, value: 'expired' },
  bulkActions: [
    { action: 'publish', label: 'Make live', requires: 'edit', set: { status: 'live' } },
    { action: 'expire', label: 'Expire', requires: 'delete', set: { status: 'expired' }, destructive: true },
  ],
});

const faqsResource = defineResource({
  slug: 'faqs',
  title: 'FAQs',
  description: '`answer` is NOT NULL — the console mock had no answer field at all.',
  group: 'Content & Storefront',
  module: 'content',
  name: { singular: 'Faq', plural: 'Faqs' },
  tag: 'Admin content',
  table: faqs,
  primaryKey: faqs.id,
  columns: {
    id: faqs.id,
    question: faqs.question,
    answer: faqs.answer,
    category: faqs.category,
    position: faqs.position,
    helpfulCount: faqs.helpfulCount,
    unhelpfulCount: faqs.unhelpfulCount,
    status: faqs.status,
    createdAt: faqs.createdAt,
    updatedAt: faqs.updatedAt,
  },
  listColumns: ['id', 'question', 'category', 'helpfulCount', 'position', 'status', 'updatedAt'],
  fields: [
    { key: 'question', label: 'Question', kind: 'text', required: true, max: 400 },
    { key: 'answer', label: 'Answer', kind: 'long', required: true },
    { key: 'category', label: 'Category', kind: 'text', required: false, max: 80 },
    { key: 'position', label: 'Position', kind: 'number', required: false, min: 0, max: 1_000 },
    { key: 'helpfulCount', label: 'Marked helpful', kind: 'number', required: false, readOnly: true },
    { key: 'unhelpfulCount', label: 'Marked unhelpful', kind: 'number', required: false, readOnly: true },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['published', 'draft'] },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['question', 'answer', 'category'],
  filterable: [
    enumFilter('status', 'Status', faqs.status, ['published', 'draft']),
    { key: 'category', label: 'Category', column: faqs.category, valueKind: 'string', operators: [...TEXTUAL, 'in', 'isNull'] },
  ],
  sortable: ['question', 'category', 'position', 'helpfulCount', 'status', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'position', direction: 'asc' },
  softDeleteColumn: faqs.deletedAt,
  bulkActions: [
    { action: 'publish', label: 'Publish', requires: 'edit', set: { status: 'published' } },
    { action: 'unpublish', label: 'Move to draft', requires: 'edit', set: { status: 'draft' } },
  ],
});

const testimonialsResource = defineResource({
  slug: 'testimonials',
  title: 'Testimonials',
  description: 'Marketing quotes, not linked to a product. Product reviews are a separate resource.',
  group: 'Content & Storefront',
  module: 'content',
  name: { singular: 'Testimonial', plural: 'Testimonials' },
  tag: 'Admin content',
  table: testimonials,
  primaryKey: testimonials.id,
  columns: {
    id: testimonials.id,
    authorName: testimonials.authorName,
    authorCity: testimonials.authorCity,
    company: testimonials.company,
    designation: testimonials.designation,
    quote: testimonials.quote,
    rating: testimonials.rating,
    mediaId: testimonials.mediaId,
    isFeatured: testimonials.isFeatured,
    position: testimonials.position,
    status: testimonials.status,
    createdAt: testimonials.createdAt,
    updatedAt: testimonials.updatedAt,
  },
  listColumns: ['id', 'authorName', 'company', 'quote', 'rating', 'isFeatured', 'status', 'createdAt'],
  fields: [
    { key: 'authorName', label: 'Author', kind: 'text', required: true, max: 160 },
    { key: 'authorCity', label: 'City', kind: 'text', required: false, max: 80 },
    { key: 'company', label: 'Company', kind: 'text', required: false, max: 160 },
    { key: 'designation', label: 'Designation', kind: 'text', required: false, max: 120 },
    { key: 'quote', label: 'Quote', kind: 'long', required: true, max: 2_000 },
    { key: 'rating', label: 'Rating', kind: 'number', required: false, min: 1, max: 5 },
    { key: 'mediaId', label: 'Photo', kind: 'reference', required: false, reference: { resource: 'media', labelField: 'fileName' } },
    { key: 'isFeatured', label: 'Featured', kind: 'boolean', required: false },
    { key: 'position', label: 'Position', kind: 'number', required: false, min: 0, max: 1_000 },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['published', 'pending', 'rejected'] },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['authorName', 'company', 'quote'],
  filterable: [
    enumFilter('status', 'Status', testimonials.status, ['published', 'pending', 'rejected']),
    boolFilter('isFeatured', 'Featured', testimonials.isFeatured),
    { key: 'rating', label: 'Rating', column: testimonials.rating, valueKind: 'number', operators: [...RANGE, 'isNull'] },
  ],
  sortable: ['authorName', 'company', 'rating', 'position', 'status', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'createdAt', direction: 'desc' },
  archiveStatus: { column: testimonials.status, value: 'rejected' },
  bulkActions: [
    { action: 'publish', label: 'Publish', requires: 'edit', set: { status: 'published' } },
    { action: 'feature', label: 'Feature on homepage', requires: 'edit', set: { isFeatured: true } },
    { action: 'reject', label: 'Reject', requires: 'delete', set: { status: 'rejected' }, destructive: true },
  ],
});

/* ================================================================ inventory */

const suppliersResource = defineResource({
  slug: 'suppliers',
  title: 'Suppliers',
  description: 'Vendors. `outstandingPaise` is a ledger rollup and is not writable here.',
  group: 'Inventory',
  module: 'inventory',
  name: { singular: 'Supplier', plural: 'Suppliers' },
  tag: 'Admin inventory',
  table: suppliers,
  primaryKey: suppliers.id,
  columns: {
    id: suppliers.id,
    code: suppliers.code,
    name: suppliers.name,
    contactName: suppliers.contactName,
    email: suppliers.email,
    mobile: suppliers.mobile,
    line1: suppliers.line1,
    city: suppliers.city,
    stateCode: suppliers.stateCode,
    pincode: suppliers.pincode,
    gstin: suppliers.gstin,
    pan: suppliers.pan,
    category: suppliers.category,
    leadTimeDays: suppliers.leadTimeDays,
    paymentTerms: suppliers.paymentTerms,
    rating: suppliers.rating,
    outstandingPaise: suppliers.outstandingPaise,
    status: suppliers.status,
    createdAt: suppliers.createdAt,
    updatedAt: suppliers.updatedAt,
  },
  listColumns: ['id', 'name', 'contactName', 'mobile', 'city', 'gstin', 'leadTimeDays', 'outstandingPaise', 'status'],
  fields: [
    { key: 'code', label: 'Code', kind: 'text', required: true, max: 32 },
    { key: 'name', label: 'Supplier', kind: 'text', required: true, max: 200 },
    { key: 'contactName', label: 'Contact', kind: 'text', required: false, max: 160 },
    { key: 'email', label: 'Email', kind: 'text', required: false, max: 254 },
    { key: 'mobile', label: 'Mobile', kind: 'text', required: false, max: 20 },
    { key: 'line1', label: 'Address', kind: 'text', required: false, max: 300 },
    { key: 'city', label: 'City', kind: 'text', required: false, max: 120 },
    { key: 'stateCode', label: 'State code', kind: 'text', required: false, max: 2, help: 'Two-digit GST state code.' },
    { key: 'pincode', label: 'PIN code', kind: 'text', required: false, max: 6 },
    { key: 'gstin', label: 'GSTIN', kind: 'text', required: false, max: 15 },
    { key: 'pan', label: 'PAN', kind: 'text', required: false, max: 10 },
    { key: 'category', label: 'Category', kind: 'text', required: false, max: 80, help: 'Gourmet, Packaging, Decor, Fragrance, Logistics.' },
    { key: 'leadTimeDays', label: 'Lead time', kind: 'number', required: false, unit: 'days', min: 0, max: 365 },
    { key: 'paymentTerms', label: 'Payment terms', kind: 'text', required: false, max: 80 },
    { key: 'outstandingPaise', label: 'Outstanding', kind: 'money', required: false, readOnly: true, unit: 'paise', help: 'Rolled up from purchase orders. May be negative.' },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['active', 'on_hold', 'archived'] },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['name', 'contactName', 'city', 'gstin', 'code'],
  filterable: [
    enumFilter('status', 'Status', suppliers.status, ['active', 'on_hold', 'archived']),
    { key: 'category', label: 'Category', column: suppliers.category, valueKind: 'string', operators: [...TEXTUAL, 'in', 'isNull'] },
    { key: 'city', label: 'City', column: suppliers.city, valueKind: 'string', operators: [...TEXTUAL, 'in'] },
    { key: 'leadTimeDays', label: 'Lead time (days)', column: suppliers.leadTimeDays, valueKind: 'number', operators: [...RANGE] },
  ],
  sortable: ['name', 'code', 'city', 'leadTimeDays', 'outstandingPaise', 'status', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'name', direction: 'asc' },
  softDeleteColumn: suppliers.deletedAt,
  bulkActions: [
    { action: 'hold', label: 'Put on hold', requires: 'edit', set: { status: 'on_hold' }, destructive: true },
    { action: 'activate', label: 'Activate', requires: 'edit', set: { status: 'active' } },
    { action: 'archive', label: 'Archive', requires: 'delete', set: { status: 'archived' }, destructive: true },
  ],
});

const warehousesResource = defineResource({
  slug: 'warehouses',
  title: 'Warehouses',
  description:
    'Fulfilment locations. GST registration is state-wise, so each carries its own GSTIN. Filed under ' +
    '“Delivery & Fulfilment” in the nav but gated on `inventory`, matching the console.',
  group: 'Delivery & Fulfilment',
  module: 'inventory',
  name: { singular: 'Warehouse', plural: 'Warehouses' },
  tag: 'Admin inventory',
  table: warehouses,
  primaryKey: warehouses.id,
  columns: {
    id: warehouses.id,
    code: warehouses.code,
    name: warehouses.name,
    line1: warehouses.line1,
    city: warehouses.city,
    stateCode: warehouses.stateCode,
    pincode: warehouses.pincode,
    gstin: warehouses.gstin,
    managerId: warehouses.managerId,
    capacityUnits: warehouses.capacityUnits,
    supportsSameDay: warehouses.supportsSameDay,
    isDefault: warehouses.isDefault,
    status: warehouses.status,
    createdAt: warehouses.createdAt,
    updatedAt: warehouses.updatedAt,
  },
  listColumns: ['id', 'name', 'code', 'city', 'stateCode', 'managerId', 'capacityUnits', 'supportsSameDay', 'status'],
  fields: [
    { key: 'code', label: 'Code', kind: 'text', required: true, max: 32, help: '`WH-MUM-AND`.' },
    { key: 'name', label: 'Warehouse', kind: 'text', required: true, max: 200 },
    { key: 'line1', label: 'Address', kind: 'text', required: true, max: 300 },
    { key: 'city', label: 'City', kind: 'text', required: true, max: 120 },
    { key: 'stateCode', label: 'State code', kind: 'text', required: true, max: 2, help: 'Two-digit GST state code. Determines whether a supply is interstate.' },
    { key: 'pincode', label: 'PIN code', kind: 'text', required: true, max: 6 },
    { key: 'gstin', label: 'GSTIN', kind: 'text', required: false, max: 15, help: 'One per state of operation.' },
    { key: 'managerId', label: 'Manager', kind: 'reference', required: false, reference: { resource: 'team-members', labelField: 'fullName' } },
    { key: 'capacityUnits', label: 'Capacity', kind: 'number', required: false, min: 1, max: 10_000_000 },
    { key: 'supportsSameDay', label: 'Same-day capable', kind: 'boolean', required: false },
    { key: 'isDefault', label: 'Default warehouse', kind: 'boolean', required: false, help: 'Exactly one live warehouse may be the default.' },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['active', 'maintenance', 'closed'] },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['name', 'code', 'city'],
  filterable: [
    enumFilter('status', 'Status', warehouses.status, ['active', 'maintenance', 'closed']),
    { key: 'city', label: 'City', column: warehouses.city, valueKind: 'string', operators: [...TEXTUAL, 'in'] },
    { key: 'stateCode', label: 'State', column: warehouses.stateCode, valueKind: 'string', operators: [...EXACT] },
    boolFilter('supportsSameDay', 'Same-day', warehouses.supportsSameDay),
    boolFilter('isDefault', 'Default', warehouses.isDefault),
  ],
  sortable: ['name', 'code', 'city', 'capacityUnits', 'status', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'name', direction: 'asc' },
  softDeleteColumn: warehouses.deletedAt,
  bulkActions: [
    { action: 'activate', label: 'Activate', requires: 'edit', set: { status: 'active' } },
    { action: 'maintenance', label: 'Mark under maintenance', requires: 'edit', set: { status: 'maintenance' }, destructive: true },
    { action: 'close', label: 'Close', requires: 'delete', set: { status: 'closed' }, destructive: true },
  ],
});

/* ================================================================ the list */

/** Registration order is route order, which is also OpenAPI tag order. */
/**
 * The three catalogue tables that existed with no admin API at all.
 *
 * `hamper_items`, `add_ons` and `personalisation_templates` have been in the
 * schema since the initial migration; the console rendered them from
 * `src/mock/catalog.ts`. Nothing new is created here — no table, no migration,
 * no bespoke handler. Each is a descriptor, which is what this engine exists
 * for, so they inherit pagination, search, filters, sorting, bulk actions,
 * RBAC and audit logging unchanged.
 *
 * The fields below follow the ACTUAL columns rather than the shapes the task
 * brief guessed at: there is no `stockQuantity` on an add-on and no
 * `templateUrl` on a personalisation template, and inventing them would mean
 * inventing storage for them.
 */
const hamperItemsResource = defineResource({
  slug: 'hamper-items',
  title: 'Hamper items',
  description:
    'Individual components a hamper is built from. Costs are integer paise; `cost_paise` is what the ' +
    'item costs US, and is never exposed on the storefront.',
  group: 'Catalogue',
  module: 'catalogue',
  name: { singular: 'HamperItem', plural: 'HamperItems' },
  tag: 'Admin catalogue',
  table: hamperItems,
  primaryKey: hamperItems.id,
  columns: {
    id: hamperItems.id,
    sku: hamperItems.sku,
    name: hamperItems.name,
    supplierId: hamperItems.supplierId,
    category: hamperItems.category,
    costPaise: hamperItems.costPaise,
    unit: hamperItems.unit,
    weightGrams: hamperItems.weightGrams,
    hsnCode: hamperItems.hsnCode,
    isPerishable: hamperItems.isPerishable,
    shelfLifeDays: hamperItems.shelfLifeDays,
    status: hamperItems.status,
    createdAt: hamperItems.createdAt,
    updatedAt: hamperItems.updatedAt,
  },
  listColumns: ['id', 'sku', 'name', 'category', 'costPaise', 'unit', 'isPerishable', 'status', 'updatedAt'],
  fields: [
    { key: 'sku', label: 'SKU', kind: 'text', required: true, max: 64 },
    { key: 'name', label: 'Item', kind: 'text', required: true, max: 160 },
    { key: 'supplierId', label: 'Supplier', kind: 'reference', required: false, reference: { resource: 'suppliers', labelField: 'name' } },
    { key: 'category', label: 'Category', kind: 'text', required: false, max: 80, help: 'Gourmet, Décor, Packaging, Beverage, Wellness.' },
    { key: 'costPaise', label: 'Cost', kind: 'money', required: true, unit: 'paise', help: 'What we pay, not what we charge.' },
    { key: 'unit', label: 'Unit', kind: 'enum', required: true, options: ['pcs', 'box', 'pack', 'kg', 'g', 'ml', 'l'] },
    { key: 'weightGrams', label: 'Weight (g)', kind: 'number', required: false },
    { key: 'hsnCode', label: 'HSN code', kind: 'text', required: false, max: 12, help: 'Must already exist in the HSN table.' },
    { key: 'isPerishable', label: 'Perishable', kind: 'boolean', required: false },
    { key: 'shelfLifeDays', label: 'Shelf life (days)', kind: 'number', required: false },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['active', 'inactive'] },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['name', 'sku', 'category'],
  filterable: [
    enumFilter('status', 'Status', hamperItems.status, ['active', 'inactive']),
    enumFilter('unit', 'Unit', hamperItems.unit, ['pcs', 'box', 'pack', 'kg', 'g', 'ml', 'l']),
    refFilter('supplierId', 'Supplier', hamperItems.supplierId),
    boolFilter('isPerishable', 'Perishable', hamperItems.isPerishable),
    moneyFilter('costPaise', 'Cost (paise)', hamperItems.costPaise),
  ],
  sortable: ['name', 'sku', 'costPaise', 'category', 'status', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'name', direction: 'asc' },
  softDeleteColumn: hamperItems.deletedAt,
  bulkActions: [
    { action: 'activate', label: 'Activate', requires: 'edit', set: { status: 'active' } },
    { action: 'deactivate', label: 'Deactivate', requires: 'edit', set: { status: 'inactive' }, destructive: true },
  ],
});

const addOnsResource = defineResource({
  slug: 'add-ons',
  title: 'Add-ons & packaging',
  description:
    'Wax seals, ribbons, gift boxes, calligraphy notes. `price_paise` is GST-INCLUSIVE, matching every ' +
    'other price in this API.',
  group: 'Catalogue',
  module: 'catalogue',
  name: { singular: 'AddOn', plural: 'AddOns' },
  tag: 'Admin catalogue',
  table: addOns,
  primaryKey: addOns.id,
  columns: {
    id: addOns.id,
    code: addOns.code,
    name: addOns.name,
    kind: addOns.kind,
    pricePaise: addOns.pricePaise,
    hsnCode: addOns.hsnCode,
    requiresInput: addOns.requiresInput,
    inputCharLimit: addOns.inputCharLimit,
    leadTimeHours: addOns.leadTimeHours,
    status: addOns.status,
    createdAt: addOns.createdAt,
    updatedAt: addOns.updatedAt,
  },
  listColumns: ['id', 'code', 'name', 'kind', 'pricePaise', 'requiresInput', 'leadTimeHours', 'status', 'updatedAt'],
  fields: [
    { key: 'code', label: 'Code', kind: 'text', required: true, max: 120, help: 'Lowercase handle form, e.g. `wax-seal-gold`. Unique.' },
    { key: 'name', label: 'Add-on', kind: 'text', required: true, max: 160 },
    { key: 'kind', label: 'Kind', kind: 'enum', required: true, options: ['packaging', 'message', 'fresh', 'bakery', 'digital', 'engraving', 'other'] },
    { key: 'pricePaise', label: 'Price', kind: 'money', required: true, unit: 'paise', help: 'GST-inclusive.' },
    { key: 'hsnCode', label: 'HSN code', kind: 'text', required: false, max: 12 },
    { key: 'requiresInput', label: 'Needs customer input', kind: 'boolean', required: false, help: 'Engraving text, card message.' },
    { key: 'inputCharLimit', label: 'Input character limit', kind: 'number', required: false },
    { key: 'leadTimeHours', label: 'Lead time (hours)', kind: 'number', required: false },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['active', 'inactive'] },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['name', 'code'],
  filterable: [
    enumFilter('status', 'Status', addOns.status, ['active', 'inactive']),
    enumFilter('kind', 'Kind', addOns.kind, ['packaging', 'message', 'fresh', 'bakery', 'digital', 'engraving', 'other']),
    boolFilter('requiresInput', 'Needs input', addOns.requiresInput),
    moneyFilter('pricePaise', 'Price (paise)', addOns.pricePaise),
  ],
  sortable: ['name', 'code', 'kind', 'pricePaise', 'leadTimeHours', 'status', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'name', direction: 'asc' },
  softDeleteColumn: addOns.deletedAt,
  bulkActions: [
    { action: 'activate', label: 'Activate', requires: 'edit', set: { status: 'active' } },
    { action: 'deactivate', label: 'Deactivate', requires: 'edit', set: { status: 'inactive' }, destructive: true },
  ],
});

const personalisationResource = defineResource({
  slug: 'personalisation',
  title: 'Personalisation templates',
  description:
    'Engraving, embroidery, print, digital and laser templates. `surcharge_paise` is what the ' +
    'personalisation adds to the line, in integer paise.',
  group: 'Catalogue',
  module: 'catalogue',
  name: { singular: 'PersonalisationTemplate', plural: 'PersonalisationTemplates' },
  tag: 'Admin catalogue',
  table: personalisationTemplates,
  primaryKey: personalisationTemplates.id,
  columns: {
    id: personalisationTemplates.id,
    name: personalisationTemplates.name,
    method: personalisationTemplates.method,
    turnaroundHours: personalisationTemplates.turnaroundHours,
    charLimit: personalisationTemplates.charLimit,
    allowsImage: personalisationTemplates.allowsImage,
    proofRequired: personalisationTemplates.proofRequired,
    surchargePaise: personalisationTemplates.surchargePaise,
    status: personalisationTemplates.status,
    createdAt: personalisationTemplates.createdAt,
    updatedAt: personalisationTemplates.updatedAt,
  },
  listColumns: ['id', 'name', 'method', 'turnaroundHours', 'charLimit', 'surchargePaise', 'status', 'updatedAt'],
  fields: [
    { key: 'name', label: 'Template', kind: 'text', required: true, max: 160, help: 'Unique among live templates.' },
    { key: 'method', label: 'Method', kind: 'enum', required: true, options: ['engraving', 'embroidery', 'print', 'digital', 'laser'] },
    { key: 'turnaroundHours', label: 'Turnaround (hours)', kind: 'number', required: true, help: 'Must be greater than zero — a CHECK enforces it.' },
    { key: 'charLimit', label: 'Character limit', kind: 'number', required: false, help: 'Null means no limit. Zero is rejected.' },
    { key: 'allowsImage', label: 'Allows image upload', kind: 'boolean', required: false },
    { key: 'proofRequired', label: 'Proof required', kind: 'boolean', required: false },
    { key: 'surchargePaise', label: 'Surcharge', kind: 'money', required: false, unit: 'paise' },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['active', 'draft', 'archived'] },
    { key: 'createdAt', label: 'Created', kind: 'datetime', required: false, readOnly: true },
    { key: 'updatedAt', label: 'Updated', kind: 'datetime', required: false, readOnly: true },
  ],
  searchable: ['name'],
  filterable: [
    enumFilter('status', 'Status', personalisationTemplates.status, ['active', 'draft', 'archived']),
    enumFilter('method', 'Method', personalisationTemplates.method, ['engraving', 'embroidery', 'print', 'digital', 'laser']),
    boolFilter('allowsImage', 'Allows image', personalisationTemplates.allowsImage),
    boolFilter('proofRequired', 'Proof required', personalisationTemplates.proofRequired),
  ],
  sortable: ['name', 'method', 'turnaroundHours', 'surchargePaise', 'status', 'createdAt', 'updatedAt'],
  defaultSort: { field: 'name', direction: 'asc' },
  softDeleteColumn: personalisationTemplates.deletedAt,
  bulkActions: [
    { action: 'activate', label: 'Activate', requires: 'edit', set: { status: 'active' } },
    { action: 'archive', label: 'Archive', requires: 'delete', set: { status: 'archived' }, destructive: true },
  ],
});

export const RESOURCES: readonly ResourceDescriptor[] = [
  productsResource,
  productVariantsResource,
  collectionsResource,
  designersResource,
  customersResource,
  couponsResource,
  giftCardsResource,
  bannersResource,
  faqsResource,
  testimonialsResource,
  suppliersResource,
  warehousesResource,
  hamperItemsResource,
  addOnsResource,
  personalisationResource,
];

const BY_SLUG = new Map(RESOURCES.map((r) => [r.slug, r]));

export const resourceBySlug = (slug: string): ResourceDescriptor | undefined => BY_SLUG.get(slug);

export const resourceSlugs = (): string[] => [...BY_SLUG.keys()];
