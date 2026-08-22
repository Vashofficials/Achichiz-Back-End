import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, noContent, ok } from '../../lib/http.js';
import * as addresses from './addresses.service.js';
import {
  address,
  addressBody,
  addressIdParam,
  updateAddressBody,
} from './addresses.schemas.js';

/**
 * The customer's address book.
 *
 * Replaces `store/src/routes/account.addresses.tsx`, which keeps addresses in
 * `localStorage` — so they do not follow the customer to another device, and
 * checkout cannot offer them (`checkout.tsx` has no address-book integration at
 * all today, 01_storefront_api.md §1).
 *
 * Every route is scoped to `auth.customerId` inside the SQL predicate, so an id
 * belonging to another customer returns 404 rather than being loaded and then
 * rejected. Exactly one address is the default at any moment; see
 * `addresses.service.ts` for which of the three mechanisms enforces which half of
 * that.
 */
export const addressesRouter: Router = Router();

defineRoute(addressesRouter, {
  method: 'get',
  path: '/v1/account/addresses',
  surface: 'storefront',
  operationId: 'listMyAddresses',
  summary: 'List my addresses',
  description:
    'Default first, then oldest first. Not paginated — an address book is a handful of rows, and the ' +
    'checkout screen needs all of them at once to render its picker.',
  tags: ['Addresses'],
  auth: 'customer',
  responses: {
    200: { description: 'Every saved address.', schema: z.array(address) },
    401: { description: 'Missing, expired or revoked access token.' },
  },
  handler: async ({ auth }) => ok(await addresses.listMyAddresses(auth.customerId)),
});

defineRoute(addressesRouter, {
  method: 'get',
  path: '/v1/account/addresses/:addressId',
  surface: 'storefront',
  operationId: 'getMyAddress',
  summary: 'Get one of my addresses',
  description: 'An id that is not yours returns 404, not 403 — confirming an id exists is itself a leak.',
  tags: ['Addresses'],
  auth: 'customer',
  request: { params: addressIdParam },
  responses: {
    200: { description: 'The address.', schema: address },
    404: { description: 'No such address, or it belongs to someone else.' },
  },
  handler: async ({ params, auth }) => ok(await addresses.getMyAddress(auth.customerId, params.addressId)),
});

defineRoute(addressesRouter, {
  method: 'post',
  path: '/v1/account/addresses',
  surface: 'storefront',
  operationId: 'createMyAddress',
  summary: 'Add an address',
  description:
    '**The first address you save becomes the default automatically**, whether or not `isDefault` was ' +
    'sent — a customer with addresses but no default is a checkout with nothing pre-selected. The ' +
    'storefront does this in the browser today, which means any address created by another path ' +
    '(checkout’s `saveToAddressBook`, an admin, an import) silently misses it.' +
    '\n\n' +
    'Passing `isDefault: true` stands the previous default down in the same transaction, in that order ' +
    '— the uniqueness index is partial and cannot be deferred, so the other order is a constraint ' +
    'violation even though the end state would be legal.' +
    '\n\n' +
    '`stateCode` is a foreign key to `gst_states`, not free text: it decides the place of supply and ' +
    'therefore whether the order is taxed IGST or CGST+SGST. An unknown code is rejected.',
  tags: ['Addresses'],
  auth: 'customer',
  request: { body: addressBody },
  responses: {
    201: { description: 'The saved address.', schema: address },
    409: { description: 'An unknown `stateCode` — there is no such GST state.' },
  },
  handler: async ({ body, auth }) => created(await addresses.createMyAddress(auth.customerId, body)),
});

defineRoute(addressesRouter, {
  method: 'patch',
  path: '/v1/account/addresses/:addressId',
  surface: 'storefront',
  operationId: 'updateMyAddress',
  summary: 'Update an address',
  description:
    'A true PATCH — only the fields present are changed, and `{}` is a valid no-op.' +
    '\n\n' +
    '`isDefault: true` promotes this address and stands the incumbent down atomically. ' +
    '`isDefault: false` **on the address that is currently the default is refused** (422 ' +
    '`default_address_required`): while any address exists one of them is the default, so clearing the ' +
    'flag would just cause some other address to be promoted arbitrarily. Use ' +
    '`POST /v1/account/addresses/{addressId}/default` on the address you actually want instead.',
  tags: ['Addresses'],
  auth: 'customer',
  request: { params: addressIdParam, body: updateAddressBody },
  responses: {
    200: { description: 'The updated address.', schema: address },
    404: { description: 'No such address, or it belongs to someone else.' },
    422: { description: 'Tried to clear the default flag without nominating a replacement.' },
  },
  handler: async ({ params, body, auth }) =>
    ok(await addresses.updateMyAddress(auth.customerId, params.addressId, body)),
});

defineRoute(addressesRouter, {
  method: 'post',
  path: '/v1/account/addresses/:addressId/default',
  surface: 'storefront',
  operationId: 'setDefaultAddress',
  summary: 'Make an address the default',
  description:
    'Two statements in one transaction, in the only order the partial unique index permits: stand the ' +
    'incumbent down, then promote this one.' +
    '\n\n' +
    'Returns the **whole list**, not just the address that changed. Two rows move — one gains the flag, ' +
    'one loses it — and a client that re-renders from a single-object response would show two ticks ' +
    'until its next refetch.',
  tags: ['Addresses'],
  auth: 'customer',
  request: { params: addressIdParam },
  responses: {
    200: { description: 'The full address list, with exactly one default.', schema: z.array(address) },
    404: { description: 'No such address, or it belongs to someone else.' },
  },
  handler: async ({ params, auth }) => ok(await addresses.setDefaultAddress(auth.customerId, params.addressId)),
});

defineRoute(addressesRouter, {
  method: 'delete',
  path: '/v1/account/addresses/:addressId',
  surface: 'storefront',
  operationId: 'deleteMyAddress',
  summary: 'Delete an address',
  description:
    'Soft delete — `addresses` is Tier 2, and orders reference the address snapshot they were placed ' +
    'against, so the row survives even though it disappears from the book.' +
    '\n\n' +
    'Deleting the default is allowed: `trg_ensure_default_address` promotes the oldest surviving ' +
    'address in the same statement, so the customer is never left with addresses and no default.',
  tags: ['Addresses'],
  auth: 'customer',
  request: { params: addressIdParam },
  responses: {
    204: { description: 'Deleted.' },
    404: { description: 'No such address, or it belongs to someone else.' },
  },
  handler: async ({ params, auth }) => {
    await addresses.deleteMyAddress(auth.customerId, params.addressId);
    return noContent();
  },
});
