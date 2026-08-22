/**
 * Address-book contracts.
 *
 * `stateCode` deserves a note, because it looks like decoration and is not. It
 * is a foreign key to `gst_states.code` and it decides the **place of supply**,
 * which decides whether an order is taxed IGST or CGST+SGST. A wrong state code
 * is a wrong tax invoice, so it is a two-digit code from a reference table rather
 * than a free-text "state" string like the storefront's current local address
 * shape (`store/src/lib/account.ts`).
 */

import { z } from 'zod';

const PINCODE = /^[1-9][0-9]{5}$/;
const MOBILE_IN = /^[6-9][0-9]{9}$/;
const STATE_CODE = /^[0-3][0-9]$/;

/**
 * The fields, without defaults.
 *
 * POST and PATCH are built from this separately and deliberately: `.partial()`
 * does **not** strip a `.default()`, so a PATCH derived from the POST schema
 * would silently reset `label` to `Home` and `countryCode` to `IN` on every
 * request that did not mention them — a customer renaming "Office" to "Studio"
 * would find their country reset. Defaults belong on create only.
 */
const addressFields = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe('Address-book label, e.g. `Home`, `Office`, `Parents`. Free text — the list groups by it.'),
  contactName: z.string().trim().min(2).max(120).describe('Who receives the parcel at this address.'),
  mobile: z
    .string()
    .regex(MOBILE_IN, 'An Indian mobile number is ten digits starting 6-9.')
    .describe('Ten-digit number the courier calls on delivery. Not necessarily the account holder’s.'),
  line1: z.string().trim().min(3).max(200).describe('House/flat, building, street.'),
  line2: z.string().trim().max(200).optional().describe('Second address line, if needed.'),
  area: z.string().trim().max(120).optional().describe('Locality or area.'),
  city: z.string().trim().min(2).max(80).describe('City.'),
  stateCode: z
    .string()
    .regex(STATE_CODE, 'A GST state code is two digits, e.g. `27`.')
    .describe(
      'Two-digit GST state code — a foreign key to `gst_states`, not free text. It sets the place of ' +
        'supply, and therefore whether the order is taxed IGST or CGST+SGST.',
    ),
  pincode: z
    .string()
    .regex(PINCODE, 'An Indian PIN code is six digits and does not start with 0.')
    .describe('Six-digit PIN code. Drives serviceability, same-day eligibility and COD eligibility.'),
  countryCode: z
    .string()
    .length(2)
    .describe('ISO-3166-1 alpha-2. Only `IN` is serviceable today, whatever the marketing copy says.'),
  isDefault: z
    .boolean()
    .describe(
      'Make this the default address. The first address you save becomes the default automatically ' +
        'whether or not you ask for it — a customer with addresses but no default is a checkout with ' +
        'nothing pre-selected.',
    ),
});

/** POST: the two fields with sensible defaults are filled in; `isDefault` stays an opinion. */
export const addressBody = addressFields.extend({
  label: addressFields.shape.label.default('Home'),
  countryCode: addressFields.shape.countryCode.default('IN'),
  isDefault: addressFields.shape.isDefault.optional(),
});

/**
 * PATCH: every field optional and **no defaults**, so `{}` is a genuine no-op and
 * an absent field means "leave it" rather than "reset it".
 */
export const updateAddressBody = addressFields
  .partial()
  .describe('Only the fields present are changed.');

export const addressIdParam = z.object({
  addressId: z.uuid().describe('`addresses.id` as returned by `GET /v1/account/addresses`.'),
});

export const address = z.object({
  id: z.uuid().describe('Address id.'),
  label: z.string().describe('Address-book label.'),
  contactName: z.string().describe('Who receives the parcel.'),
  mobile: z.string().describe('Delivery contact number.'),
  line1: z.string().describe('House/flat, building, street.'),
  line2: z.string().nullable().describe('Second address line, or null.'),
  area: z.string().nullable().describe('Locality, or null.'),
  city: z.string().describe('City.'),
  stateCode: z.string().describe('Two-digit GST state code.'),
  pincode: z.string().describe('Six-digit PIN code.'),
  countryCode: z.string().describe('ISO-3166-1 alpha-2 country code.'),
  isDefault: z
    .boolean()
    .describe('Exactly one address per customer has this set — enforced by a partial unique index, not by hope.'),
  createdAt: z.string().describe('ISO-8601 timestamp.'),
  updatedAt: z.string().describe('ISO-8601 timestamp.'),
});

export type AddressBody = z.infer<typeof addressBody>;
export type UpdateAddressBody = z.infer<typeof updateAddressBody>;
export type AddressResponse = z.infer<typeof address>;
