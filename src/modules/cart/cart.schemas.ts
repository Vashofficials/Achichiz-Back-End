/**
 * Cart contracts.
 *
 * A cart is server-side state keyed by an opaque token, so it survives a browser
 * wipe and follows the account across devices — replacing the `tgs-store-v1`
 * localStorage blob the storefront uses today (`store/src/lib/store.ts:24`).
 *
 * The request schemas carry ids, quantities and free text. They carry no money.
 * `unitPricePaise` on a response is read from `product_variants` at read time,
 * never from `cart_lines.unit_price_paise` (that column is a display snapshot,
 * kept so an admin can see what the shopper was shown) and never from a client.
 */

import { z } from 'zod';
import { priceBreakdown } from '../checkout/checkout.schemas.js';

/** Personalisation is a free-form map because the template set is data, not code. */
export const personalisationInput = z
  .record(z.string().min(1).max(40), z.string().max(600))
  .describe(
    'Personalisation inputs keyed by field name, e.g. `{ "Name": "Aarav", "Message": "Happy Diwali" }`. ' +
      'Per-key character limits (Name 24, Message 180, Gift message 240) are enforced HERE, server-side — ' +
      'the PDP `maxlength` attribute is decoration.',
  );

export const cartLineAddOnInput = z.object({
  addOnId: z.uuid().describe('Add-on id from `GET /v1/add-ons`.'),
  inputText: z
    .string()
    .max(600)
    .optional()
    .describe('Text for an add-on that requires input (engraving, card message). Capped by the add-on’s own limit.'),
});

export const addCartLineBody = z.object({
  cartToken: z
    .string()
    .min(8)
    .max(255)
    .optional()
    .describe(
      'Opaque cart handle. Omit on the first add — the response mints one and returns it as `token`. ' +
        'May also be sent as the `X-Cart-Token` request header.',
    ),
  variantId: z.uuid().describe('The variant to add. Cart lines reference a variant, never a product.'),
  quantity: z
    .number()
    .int()
    .min(1)
    .max(99)
    .default(1)
    .describe('Units to add. Adding to a line that already exists sums the quantities.'),
  addOns: z
    .array(cartLineAddOnInput)
    .max(10)
    .default([])
    .describe('Chosen add-ons. A different add-on set makes a different cart line, not a merged one.'),
  personalisation: personalisationInput.optional(),
  builderTemplateId: z
    .uuid()
    .optional()
    .describe(
      'Build-your-own-hamper template. NOT YET SUPPORTED — a builder line reserves its bill-of-materials ' +
        'components rather than a variant, and the pricing engine has no BOM path. Sending it returns 422 ' +
        '`builder_lines_unsupported` rather than silently dropping the hamper.',
    ),
  builderConfig: z.unknown().optional().describe('Chosen option ids for a built hamper. See `builderTemplateId`.'),
});

export const updateCartLineBody = z.object({
  cartToken: z.string().min(8).max(255).optional().describe('Opaque cart handle, or send `X-Cart-Token`.'),
  quantity: z
    .number()
    .int()
    .min(0)
    .max(99)
    .describe('New absolute quantity. Zero removes the line, mirroring the storefront’s existing behaviour.'),
  personalisation: personalisationInput.optional().describe('Replaces the line’s personalisation when present.'),
});

export const applyCouponBody = z.object({
  cartToken: z.string().min(8).max(255).optional().describe('Opaque cart handle, or send `X-Cart-Token`.'),
  code: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .describe('Coupon code, case-insensitive. Validated against the live `coupons` table, never a hardcoded list.'),
});

export const mergeCartBody = z.object({
  cartToken: z
    .string()
    .min(8)
    .max(255)
    .optional()
    .describe(
      'The guest cart to fold in. Omit to simply fetch (or create) the signed-in customer’s own cart — ' +
        'which is how a second device gets its cart handle.',
    ),
});

export const cartTokenQuery = z.object({
  cartToken: z
    .string()
    .min(8)
    .max(255)
    .optional()
    .describe('Opaque cart handle. Prefer the `X-Cart-Token` header; this exists for GET/DELETE convenience.'),
});

export const cartLineIdParam = z.object({
  lineId: z.uuid().describe('`cart_lines.id` as returned by `GET /v1/cart`.'),
});

/* -------------------------------------------------------------- responses */

export const cartLineAddOn = z.object({
  addOnId: z.uuid().describe('Add-on id.'),
  code: z.string().describe('Stable add-on code, e.g. `gift-wrap`.'),
  name: z.string().describe('Display name.'),
  pricePaise: z.number().int().describe('LIVE add-on price per unit, GST-inclusive, in integer paise.'),
  inputText: z.string().nullable().describe('The text the shopper supplied, or null.'),
});

export const cartLine = z.object({
  id: z.uuid().describe('Cart line id. Use it for PATCH/DELETE.'),
  lineKey: z
    .string()
    .describe('Deterministic dedupe key over variant + add-ons + personalisation. Two identical configurations collapse.'),
  variantId: z.uuid().describe('Variant id.'),
  productId: z.uuid().describe('Product id.'),
  productHandle: z.string().describe('Product URL slug, for linking back to the PDP.'),
  title: z.string().describe('Product title.'),
  variantLabel: z.string().describe('Variant option label, e.g. `Signature`.'),
  sku: z.string().describe('Variant SKU.'),
  imageUrl: z.string().nullable().describe('Primary image URL, or null.'),
  quantity: z.number().int().describe('Units on this line.'),
  unitPricePaise: z.number().int().describe('LIVE variant price, GST-inclusive, in paise. Re-read on every request.'),
  addOns: z.array(cartLineAddOn).describe('Add-ons on this line.'),
  addOnsPaise: z.number().int().describe('Sum of add-on prices PER UNIT, in paise.'),
  personalisation: z.record(z.string(), z.string()).nullable().describe('Personalisation inputs, or null.'),
  lineTotalPaise: z.number().int().describe('`quantity × (unitPrice + addOns)` before discount, in paise.'),
  availableQty: z.number().int().describe('Live available units (on-hand minus reserved) across all warehouses.'),
  inStock: z.boolean().describe('False when `availableQty` is below `quantity` — the line blocks checkout.'),
  priceChanged: z
    .boolean()
    .describe('True when the live price differs from the price snapshotted at add-to-cart. Show it before payment.'),
});

export const cart = z.object({
  id: z.uuid().nullable().describe('Cart id, or null when no cart exists yet.'),
  token: z
    .string()
    .nullable()
    .describe('Opaque cart handle. Store it and send it back as `X-Cart-Token`. Null when no cart exists yet.'),
  stage: z
    .enum(['cart', 'address', 'payment', 'converted'])
    .describe('How far through checkout this cart got. Drives abandonment recovery.'),
  couponCode: z.string().nullable().describe('Applied coupon code, or null.'),
  lines: z.array(cartLine).describe('Lines in add order.'),
  totals: priceBreakdown.describe('Server-computed money. Standard delivery, prepaid, before an address is known.'),
  itemCount: z.number().int().describe('Total units, not the number of lines.'),
  hasUnavailableLines: z.boolean().describe('True when any line exceeds available stock. Checkout will reject.'),
  updatedAt: z.string().describe('ISO-8601 timestamp of the last change.'),
});

export type CartResponse = z.infer<typeof cart>;
export type CartLineResponse = z.infer<typeof cartLine>;
export type AddCartLineBody = z.infer<typeof addCartLineBody>;
export type UpdateCartLineBody = z.infer<typeof updateCartLineBody>;
