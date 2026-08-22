import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';

/**
 * Storefront catalogue contracts.
 *
 * Every field carries `.describe()` — that text is what the frontend team reads
 * in Swagger UI, and it is the only place the derivation of a computed field
 * (`stock`, `sameDay`, `bestSeller`, `isNew`) is written down.
 *
 * Money is integer paise everywhere, suffixed `...Paise`. There is no float
 * rupee value anywhere in this file, by design — see `lib/money.ts`.
 */

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * `z.coerce.boolean()` is wrong for query strings — `Boolean('false')` is `true`,
 * so `?inStock=false` would filter. Parse the literal instead.
 */
const boolParam = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const handleParam = z.object({
  handle: z
    .string()
    .regex(HANDLE, 'A handle is lowercase alphanumerics separated by single hyphens.')
    .min(2)
    .max(120)
    .describe('URL slug of the resource, e.g. `bamboo-water-bottle`.'),
});

export const stockState = z
  .enum(['in', 'low', 'out'])
  .describe(
    'Presentation of live availability, never stored: `out` when available quantity is 0, ' +
      '`low` when it is at or below the product low-stock threshold, otherwise `in`.',
  );

export const collectionKind = z
  .enum(['category', 'recipient', 'occasion', 'festival', 'designer', 'edit'])
  .describe('Taxonomy discriminator. One `collections` table serves all six.');

export const mediaRef = z.object({
  id: z.uuid().describe('Media asset id.'),
  url: z.string().describe('CDN URL when one exists, otherwise the origin URL.'),
  altText: z.string().nullable().describe('Alt text for accessibility. May be null.'),
  position: z.number().int().describe('0-based display order within the gallery.'),
});

export const designerRef = z.object({
  id: z.uuid().describe('Designer id.'),
  handle: z.string().describe('Designer URL slug.'),
  name: z.string().describe('Display name, e.g. `Studio Kaya`.'),
});

export const seoBlock = z.object({
  metaTitle: z.string().nullable().describe('`<title>` override. Falls back to the resource title.'),
  metaDescription: z.string().nullable().describe('`<meta name="description">` content.'),
  canonicalUrl: z.string().nullable().describe('Canonical URL when this page duplicates another.'),
  focusKeyword: z.string().nullable().describe('Primary keyword the page targets.'),
  robotsIndex: z.boolean().describe('False emits `noindex`.'),
  robotsFollow: z.boolean().describe('False emits `nofollow`.'),
  ogImageUrl: z.string().nullable().describe('Open Graph image URL.'),
  structuredData: z.unknown().nullable().describe('JSON-LD document to embed verbatim, or null.'),
});

// ── product ──────────────────────────────────────────────────────────────

export const productSummary = z.object({
  id: z.uuid().describe('Product id. Stable; prefer `handle` for URLs.'),
  handle: z.string().describe('URL slug, e.g. `bamboo-water-bottle`. Routes `/products/:handle`.'),
  sku: z.string().nullable().describe('SKU of the default variant. SKUs live on variants, not products.'),
  title: z.string().describe('Product name.'),
  subtitle: z.string().nullable().describe('Short merchandising line under the title.'),
  kind: z
    .enum(['hamper', 'single_gift', 'personalised', 'gourmet', 'add_on', 'builder'])
    .describe('Fulfilment class — does it need assembly, personalisation, is it an add-on.'),
  designer: designerRef.nullable().describe('Attributed designer/brand, or null.'),
  type: z
    .string()
    .nullable()
    .describe(
      'Merchandising category handle (the collection of `kind=category` this product leads with), ' +
        'e.g. `drinkware`. This is the storefront `type` facet; it is NOT `kind`.',
    ),
  typeLabel: z.string().nullable().describe('Human label for `type`, e.g. `Drinkware`.'),
  pricePaise: z
    .number()
    .int()
    .describe('Lowest active variant price, GST-inclusive, in integer paise. 149900 = ₹1,499.00.'),
  compareAtPaise: z
    .number()
    .int()
    .nullable()
    .describe('Struck-through was-price in integer paise, or null when not on offer.'),
  image: mediaRef.nullable().describe('Primary product image, or null when none is attached.'),
  collectionHandles: z.array(z.string()).describe('Every live collection this product belongs to, any kind.'),
  occasionHandles: z
    .array(z.string())
    .describe('Subset of `collectionHandles` of kind `occasion` or `festival`.'),
  recipientHandles: z.array(z.string()).describe('Subset of `collectionHandles` of kind `recipient`.'),
  stock: stockState,
  stockQty: z.number().int().describe('Available units summed across warehouses (on-hand minus reserved).'),
  sameDay: z
    .boolean()
    .describe(
      'True when stock sits in at least one same-day-capable warehouse. Destination still decides — ' +
        'confirm with `GET /v1/serviceability`.',
    ),
  bestSeller: z
    .boolean()
    .describe('Membership of the `best-sellers` collection, unless `badgeOverride` forces it either way.'),
  isNew: z
    .boolean()
    .describe('Published within the last 30 days, unless `badgeOverride` forces it either way.'),
  personalisable: z
    .boolean()
    .describe('Accepts engraving/printing. See `personalisationTemplates` on the detail.'),
  tags: z.array(z.string()).describe('Free-form merchandising tags, e.g. `fragile`, `gift-ready`.'),
  ratingAvg: z.number().nullable().describe('Mean published review rating 1.0–5.0, or null when unreviewed.'),
  reviewCount: z.number().int().describe('Count of published reviews.'),
  publishedAt: z.string().nullable().describe('ISO-8601 publish timestamp.'),
});

export const productVariant = z.object({
  id: z.uuid().describe('Variant id. Cart lines reference this, never the product.'),
  sku: z.string().describe('Stock-keeping unit.'),
  optionLabel: z.string().describe('Display label, e.g. `Signature`, `Rose`, `A5`.'),
  optionValue: z.string().describe('Machine value/slug of the option, e.g. `signature`.'),
  pricePaise: z.number().int().describe('GST-inclusive price in integer paise.'),
  compareAtPaise: z.number().int().nullable().describe('Struck-through was-price in integer paise.'),
  weightGrams: z.number().int().nullable().describe('Shipping weight in grams.'),
  isDefault: z.boolean().describe('The variant preselected on the PDP. Exactly one per product.'),
  position: z.number().int().describe('Display order.'),
  stock: stockState,
  stockQty: z.number().int().describe('Available units for this variant across warehouses.'),
});

export const addOn = z.object({
  id: z.uuid().describe('Add-on id. Cart lines reference this.'),
  code: z.string().describe('Stable code, e.g. `card`, `engraving`, `premium`.'),
  name: z.string().describe('Customer-facing label.'),
  kind: z
    .enum(['packaging', 'message', 'fresh', 'bakery', 'digital', 'engraving', 'other'])
    .describe('What sort of add-on this is; drives which input the PDP renders.'),
  pricePaise: z
    .number()
    .int()
    .describe('Price in integer paise, already resolved against any per-product override.'),
  requiresInput: z.boolean().describe('True when the shopper must supply text (engraving, card message).'),
  inputCharLimit: z
    .number()
    .int()
    .nullable()
    .describe('Server-enforced character cap on that text. The HTML `maxlength` is not the rule.'),
  leadTimeHours: z.number().int().describe('Extra production hours this add-on adds to the promise date.'),
});

export const personalisationTemplate = z.object({
  id: z.uuid().describe('Template id.'),
  name: z.string().describe('Template name, e.g. `Laser name engraving`.'),
  method: z
    .enum(['engraving', 'embroidery', 'print', 'digital', 'laser'])
    .describe('Production method, which decides the studio queue.'),
  turnaroundHours: z.number().int().describe('Production hours this method adds before dispatch.'),
  charLimit: z.number().int().nullable().describe('Server-enforced character cap, or null for unlimited.'),
  allowsImage: z.boolean().describe('True when a logo/artwork upload is accepted.'),
  proofRequired: z.boolean().describe('True when a digital proof must be approved before production.'),
  surchargePaise: z.number().int().describe('Surcharge in integer paise.'),
});

export const productDetail = productSummary.extend({
  description: z.string().nullable().describe('Long-form description. Plain text.'),
  isPerishable: z.boolean().describe('Perishable goods carry shorter delivery promises.'),
  isFragile: z.boolean().describe('Drives packaging selection and courier choice.'),
  images: z.array(mediaRef).describe('Full gallery in display order. `image` is the first of these.'),
  contents: z.array(z.string()).describe('The "what is inside" bullets, in order.'),
  variants: z.array(productVariant).describe('Every active variant. Always at least one.'),
  addOns: z
    .array(addOn)
    .describe('Add-ons offered on this product. Falls back to the global default set when none are pinned.'),
  personalisationTemplates: z
    .array(personalisationTemplate)
    .describe('Personalisation methods available. Empty when `personalisable` is false.'),
  relatedHandles: z
    .array(z.string())
    .describe('Handles of products sharing the most collections with this one, best first.'),
  seo: seoBlock.nullable().describe('SEO overrides for this PDP, or null to fall back to defaults.'),
});

export const productListQuery = listQuery.extend({
  collection: z
    .string()
    .regex(HANDLE)
    .optional()
    .describe('Restrict to a collection handle, any kind. e.g. `festivals-diwali`.'),
  type: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Category handle(s) to include. Repeat the parameter for several, e.g. `type=drinkware&type=candles`.',
    ),
  designer: z.string().regex(HANDLE).optional().describe('Restrict to one designer handle.'),
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
  inStock: boolParam.optional().describe('`true` hides products whose `stock` is `out`.'),
  sameDay: boolParam.optional().describe('`true` keeps only products with same-day-capable stock.'),
  personalisable: boolParam.optional().describe('`true` keeps only personalisable products.'),
});

/**
 * Sort allowlist for `GET /v1/products`.
 *
 * A sort field reaches an `ORDER BY`, so it is matched against this list and
 * never interpolated. Anything else falls back to `-publishedAt`.
 */
export const PRODUCT_SORT_FIELDS = ['price', 'publishedAt', 'title', 'unitsSold', 'rating'] as const;
export const PRODUCT_SORT_FALLBACK = { field: 'publishedAt', direction: 'desc' } as const;

export const collectionSummary = z.object({
  id: z.uuid().describe('Collection id.'),
  handle: z.string().describe('URL slug. Routes `/collections/:handle`.'),
  kind: collectionKind,
  parentHandle: z.string().nullable().describe('Parent collection handle, or null at the top level.'),
  title: z.string().describe('Nav label, e.g. `Drinkware`.'),
  heading: z.string().nullable().describe('Page H1, e.g. `Bamboo Drinkware`.'),
  subtext: z.string().nullable().describe('Short intro paragraph under the H1.'),
  seoDescription: z.string().nullable().describe('SEO copy block rendered at the foot of the listing.'),
  image: mediaRef.nullable().describe('Hero image, or null.'),
  curator: z.string().nullable().describe('Editor credit. Only meaningful for `kind=edit`.'),
  designer: designerRef.nullable().describe('Attributed designer. Only set for `kind=designer`.'),
  isFeatured: z.boolean().describe('Surfaced on the homepage tiles.'),
  sortOrder: z.number().int().describe('Manual display order within its kind.'),
  productCount: z.number().int().describe('Live, active products currently in this collection.'),
});

export const collectionDetail = z.object({
  collection: collectionSummary.describe('The collection itself.'),
  availableTypes: z
    .array(z.object({ handle: z.string(), title: z.string(), count: z.number().int() }))
    .describe('Category facets present in this collection, with counts. Computed server-side.'),
  priceBounds: z
    .object({
      minPaise: z.number().int().describe('Cheapest product in the collection, integer paise.'),
      maxPaise: z.number().int().describe('Dearest product in the collection, integer paise.'),
    })
    .describe('Price slider bounds for this collection.'),
  seo: seoBlock.nullable().describe('SEO overrides for this listing page.'),
});

export const collectionListQuery = listQuery.extend({
  kind: collectionKind.optional().describe('Restrict to one taxonomy kind.'),
  parent: z
    .string()
    .regex(HANDLE)
    .optional()
    .describe('Restrict to direct children of this collection handle.'),
  featured: boolParam.optional().describe('`true` keeps only featured collections.'),
});

export const COLLECTION_SORT_FIELDS = ['sortOrder', 'title', 'createdAt'] as const;
export const COLLECTION_SORT_FALLBACK = { field: 'sortOrder', direction: 'asc' } as const;

export const designerSummary = z.object({
  id: z.uuid().describe('Designer id.'),
  handle: z.string().describe('URL slug.'),
  name: z.string().describe('Display name.'),
  kind: z.enum(['designer', 'brand', 'celebrity', 'artisan_cluster']).describe('What sort of maker this is.'),
  bio: z.string().nullable().describe('Long-form biography.'),
  logo: mediaRef.nullable().describe('Logo asset, or null.'),
  productCount: z.number().int().describe('Live, active products attributed to this designer.'),
});

export const designerListQuery = listQuery.extend({
  kind: z
    .enum(['designer', 'brand', 'celebrity', 'artisan_cluster'])
    .optional()
    .describe('Restrict to one maker kind.'),
});

export const DESIGNER_SORT_FIELDS = ['name', 'createdAt', 'productCount'] as const;
export const DESIGNER_SORT_FALLBACK = { field: 'name', direction: 'asc' } as const;

// ── add-ons & personalisation ────────────────────────────────────────────

export const addOnListQuery = listQuery.extend({
  kind: z
    .enum(['packaging', 'message', 'fresh', 'bakery', 'digital', 'engraving', 'other'])
    .optional()
    .describe('Restrict to one add-on kind.'),
  product: z
    .string()
    .regex(HANDLE)
    .optional()
    .describe(
      'Product handle. Returns exactly the add-ons that product offers, with any per-product ' +
        'price override already applied. Omit for the global catalogue of active add-ons.',
    ),
});

export const ADD_ON_SORT_FIELDS = ['name', 'pricePaise', 'code'] as const;
export const ADD_ON_SORT_FALLBACK = { field: 'name', direction: 'asc' } as const;

export const personalisationTemplateListQuery = listQuery.extend({
  method: z
    .enum(['engraving', 'embroidery', 'print', 'digital', 'laser'])
    .optional()
    .describe('Restrict to one production method.'),
  product: z
    .string()
    .regex(HANDLE)
    .optional()
    .describe('Product handle. Returns only the templates pinned to that product.'),
});

export const PERSONALISATION_SORT_FIELDS = ['name', 'turnaroundHours', 'surchargePaise'] as const;
export const PERSONALISATION_SORT_FALLBACK = { field: 'name', direction: 'asc' } as const;

// ── hamper builder ───────────────────────────────────────────────────────

export const hamperOption = z.object({
  id: z.uuid().describe('Option id. Submit these in `builderComponents` when adding the hamper to a cart.'),
  label: z.string().describe('Customer-facing label, e.g. `Dark chocolate truffles`.'),
  pricePaise: z.number().int().describe('Price contribution in integer paise.'),
  weightGrams: z.number().int().nullable().describe('Weight contribution in grams, or null when unmodelled.'),
  position: z.number().int().describe('Display order within the step.'),
  stock: z
    .enum(['in', 'out'])
    .describe('`out` when the option is switched off or its component has no available stock.'),
});

export const hamperStep = z.object({
  id: z.uuid().describe('Step id.'),
  position: z.number().int().describe('1-based wizard step order.'),
  title: z.string().describe('Step heading, e.g. `Snacks & chocolates`.'),
  note: z.string().nullable().describe('Helper copy, e.g. `Choose 2 to 4`.'),
  stepKind: z
    .enum(['packaging', 'items', 'personalisation', 'review'])
    .describe('What the step collects; `review` steps carry no options.'),
  minChoices: z.number().int().describe('Server-enforced minimum selections for this step.'),
  maxChoices: z.number().int().describe('Server-enforced maximum selections for this step.'),
  options: z.array(hamperOption).describe('Selectable options, in display order.'),
});

export const hamperComponents = z.object({
  id: z.uuid().describe('Builder template id.'),
  handle: z.string().describe('Builder template handle, e.g. `build-your-own-hamper`.'),
  name: z.string().describe('Template name.'),
  basePricePaise: z.number().int().describe('Price floor before any option is chosen, integer paise.'),
  maxWeightGrams: z.number().int().nullable().describe('Hard weight ceiling for the assembled hamper.'),
  steps: z.array(hamperStep).describe('The wizard, in order. Per-step min/max are the real constraints.'),
});

export const hamperTemplateSummary = z.object({
  id: z.uuid().describe('Builder template id.'),
  handle: z.string().describe('URL slug, e.g. `build-your-own-hamper`.'),
  name: z.string().describe('Template name.'),
  basePricePaise: z.number().int().describe('Price floor before any option is chosen, integer paise.'),
  maxWeightGrams: z.number().int().nullable().describe('Hard weight ceiling for the assembled hamper.'),
  stepCount: z.number().int().describe('Number of wizard steps. Fetch the detail for the steps themselves.'),
});

export const BUILDER_TEMPLATE_SORT_FIELDS = ['name', 'basePricePaise', 'createdAt'] as const;
export const BUILDER_TEMPLATE_SORT_FALLBACK = { field: 'name', direction: 'asc' } as const;

// ── serviceability ───────────────────────────────────────────────────────

export const serviceabilityQuery = z.object({
  pincode: z
    .string()
    .regex(/^[1-9][0-9]{5}$/, 'An Indian PIN code is six digits and does not start with 0.')
    .describe('Destination Indian PIN code, e.g. `400053`.'),
});

export const serviceability = z.object({
  pincode: z.string().describe('The PIN code that was checked, echoed back.'),
  serviceable: z.boolean().describe('False for both unknown PIN codes and known-but-suspended ones.'),
  city: z.string().nullable().describe('City the PIN code resolves to.'),
  stateCode: z.string().nullable().describe('Two-digit GST state code, e.g. `27` for Maharashtra.'),
  zoneName: z.string().nullable().describe('Delivery zone name, e.g. `Mumbai Metro`.'),
  tier: z
    .enum(['metro', 'tier_1', 'tier_2', 'tier_3', 'remote', 'international'])
    .nullable()
    .describe('Zone tier. Drives the shipping slab.'),
  standardTatDays: z.number().int().nullable().describe('Standard turnaround in working days for this zone.'),
  estimatedDeliveryDate: z
    .string()
    .nullable()
    .describe('`YYYY-MM-DD` promise date for a standard order placed now, in Asia/Kolkata.'),
  sameDayEligible: z
    .boolean()
    .describe('True only when the zone supports same-day AND the cutoff has not passed in Asia/Kolkata.'),
  sameDayCutoff: z.string().nullable().describe('Local cutoff time `HH:MM:SS` for same-day dispatch.'),
  midnightEligible: z.boolean().describe('True when the zone runs midnight deliveries.'),
  codEligible: z
    .boolean()
    .describe('Cash on delivery allowed — zone policy AND PIN-code policy must both allow it.'),
});

export type ProductListQuery = z.infer<typeof productListQuery>;
export type CollectionListQuery = z.infer<typeof collectionListQuery>;
export type DesignerListQuery = z.infer<typeof designerListQuery>;
export type AddOnListQuery = z.infer<typeof addOnListQuery>;
export type PersonalisationTemplateListQuery = z.infer<typeof personalisationTemplateListQuery>;
export type BuilderTemplateListQuery = z.infer<typeof listQuery>;
export type ServiceabilityQuery = z.infer<typeof serviceabilityQuery>;
export type MediaRef = z.infer<typeof mediaRef>;
export type ProductSummary = z.infer<typeof productSummary>;
export type ProductDetail = z.infer<typeof productDetail>;
export type CollectionSummary = z.infer<typeof collectionSummary>;
export type CollectionDetail = z.infer<typeof collectionDetail>;
export type DesignerSummary = z.infer<typeof designerSummary>;
export type AddOnResponse = z.infer<typeof addOn>;
export type PersonalisationTemplateResponse = z.infer<typeof personalisationTemplate>;
export type HamperComponents = z.infer<typeof hamperComponents>;
export type HamperTemplateSummary = z.infer<typeof hamperTemplateSummary>;
export type ProductVariantResponse = z.infer<typeof productVariant>;
export type Serviceability = z.infer<typeof serviceability>;
export type StockState = z.infer<typeof stockState>;
