/**
 * Account contracts — profile and wishlist.
 *
 * The profile shape is a superset of what the storefront persists today. Right
 * now `account.profile.tsx` upserts `full_name`, `email` and `mobile` into
 * Supabase's `profiles` table and keeps **birthday and the newsletter switch in
 * `localStorage` only** (01_storefront_api.md §1) — so a customer who changes
 * browsers loses their birthday, and the "Gifting reminders & offers" toggle has
 * never reached a server at all. Both get a real home here.
 */

import { z } from 'zod';
import { CUSTOMER_GENDERS } from '../../db/schema/index.js';

const MOBILE_IN = /^[6-9][0-9]{9}$/;

export const customerProfile = z.object({
  id: z.uuid().describe('`customers.id`.'),
  fullName: z.string().nullable().describe('Display name, or null if never supplied.'),
  email: z.string().nullable().describe('Email address, or null on a mobile-only (OTP) account.'),
  mobile: z.string().nullable().describe('Ten-digit Indian mobile, or null on an email-only account.'),
  birthday: z
    .string()
    .nullable()
    .describe('`YYYY-MM-DD`, or null. Stored as a DATE — no timezone, because a birthday does not have one.'),
  gender: z.enum(CUSTOMER_GENDERS).nullable().describe('Self-declared, and optional. `undisclosed` is a valid answer.'),
  emailVerified: z.boolean().describe('True once the address has been proven.'),
  mobileVerified: z.boolean().describe('True once an OTP for the number has been verified.'),
  marketingOptIn: z.boolean().describe('Marketing consent. Toggling it on writes a timestamped consent record.'),
  whatsappOptIn: z.boolean().describe('WhatsApp consent. Separate from email/SMS because the channel is separate.'),
  hasPassword: z.boolean().describe('False on an OTP-only account — offer “set a password” when false.'),
  acceptsCod: z.boolean().describe('Whether cash-on-delivery is offered to this customer. Set by ops, read-only here.'),
  createdAt: z.string().describe('ISO-8601 timestamp of account creation.'),
});

/**
 * Every field optional — this is a PATCH, and `undefined` means "leave it".
 *
 * `null` is accepted for `birthday` and `gender` so a customer can clear them.
 * It is deliberately NOT accepted for `email` or `mobile`: the
 * `customer_needs_a_handle` CHECK requires at least one of them, and letting the
 * profile form null out the only one would fail at the database with a
 * constraint error rather than a field-level message.
 */
export const updateProfileBody = z
  .object({
    fullName: z.string().trim().min(2).max(120).describe('Display name, as it should appear on a parcel.'),
    email: z
      .email()
      .max(255)
      .describe(
        'New email address. Changing it clears `emailVerified` — the new address has not been proven. ' +
          'An address already in use returns 409.',
      ),
    mobile: z
      .string()
      .regex(MOBILE_IN, 'An Indian mobile number is ten digits starting 6-9.')
      .describe(
        'New ten-digit mobile. Changing it clears `mobileVerified`; verify the new number with an OTP. ' +
          'A number already in use returns 409.',
      ),
    birthday: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
      .nullable()
      .describe('`YYYY-MM-DD`, or null to clear. Drives birthday gifting reminders.'),
    gender: z.enum(CUSTOMER_GENDERS).nullable().describe('Or null to clear.'),
    marketingOptIn: z
      .boolean()
      .describe(
        'Turn marketing email/SMS on or off. Both directions are recorded in the append-only consent ' +
          'log with a timestamp and a source — the boolean alone cannot evidence consent.',
      ),
    whatsappOptIn: z.boolean().describe('Turn WhatsApp messaging on or off.'),
  })
  .partial()
  .describe('Only the fields present are changed. Send `{}` and nothing happens.');

/* --------------------------------------------------------------- wishlist */

export const wishlistItem = z.object({
  productId: z.uuid().describe('`products.id`. The wishlist is keyed by id, not by handle — a handle can be edited.'),
  handle: z.string().describe('Current URL slug, for linking to the PDP.'),
  title: z.string().describe('Product title.'),
  imageUrl: z.string().nullable().describe('Primary image URL, or null.'),
  fromPricePaise: z
    .number()
    .int()
    .nullable()
    .describe('Cheapest live variant price, GST-inclusive, in integer paise. Null when nothing is purchasable.'),
  inStock: z.boolean().describe('True when at least one variant has stock available right now.'),
  available: z
    .boolean()
    .describe(
      'False once the product is unpublished or deleted. The row is kept rather than silently dropped, ' +
        'so the customer sees “no longer available” instead of a shorter list they cannot explain.',
    ),
  addedAt: z.string().describe('ISO-8601 timestamp of when it was saved.'),
});

export const addWishlistItemBody = z.object({
  productId: z.uuid().describe('The product to save. Must exist and be published.'),
});

export const productIdParam = z.object({
  productId: z.uuid().describe('`products.id` as returned by `GET /v1/account/wishlist`.'),
});

export type CustomerProfileResponse = z.infer<typeof customerProfile>;
export type UpdateProfileBody = z.infer<typeof updateProfileBody>;
export type WishlistItemResponse = z.infer<typeof wishlistItem>;
