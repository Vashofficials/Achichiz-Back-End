import { Router, type Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, noContent, ok, paginated } from '../../lib/http.js';
import { paginationQuery } from '../../lib/pagination.js';
import * as account from './account.service.js';
import {
  addWishlistItemBody,
  customerProfile,
  productIdParam,
  updateProfileBody,
  wishlistItem,
} from './account.schemas.js';

/**
 * The signed-in customer's own record: profile and wishlist.
 *
 * Everything is `auth: 'customer'` and everything is scoped to
 * `auth.customerId` — there is no id in any path that could address another
 * customer's data, which is the only reliable way to not have an IDOR here.
 *
 * The wishlist moves off `localStorage`. Today it is an array of product
 * *handles* in the browser (`store/src/lib/store.ts`), which means it does not
 * survive a device change and silently breaks whenever a handle is edited in the
 * admin. Here it is a row keyed by product id.
 */
export const accountRouter: Router = Router();

const IP_SHAPE = /^[0-9a-fA-F:.]{3,45}$/;

/** `activity_logs.ip` is `inet` and rejects junk; anything unrecognised becomes NULL. */
const clientIp = (req: Request): string | null => {
  const raw = req.ip ?? req.socket.remoteAddress ?? '';
  return IP_SHAPE.test(raw) ? raw : null;
};

defineRoute(accountRouter, {
  method: 'get',
  path: '/v1/account/profile',
  surface: 'storefront',
  operationId: 'getMyProfile',
  summary: 'Get my profile',
  description:
    'The full account record, including the two fields the storefront currently keeps in ' +
    '`localStorage` and therefore loses on a device change: `birthday` and the marketing toggle. ' +
    '`hasPassword` is false on an OTP-created account — use it to decide whether to offer ' +
    '“set a password” rather than “change password”.',
  tags: ['Account'],
  auth: 'customer',
  responses: {
    200: { description: 'The signed-in customer’s profile.', schema: customerProfile },
    401: { description: 'Missing, expired or revoked access token.' },
  },
  handler: async ({ auth }) => ok(await account.getProfile(auth.customerId)),
});

defineRoute(accountRouter, {
  method: 'patch',
  path: '/v1/account/profile',
  surface: 'storefront',
  operationId: 'updateMyProfile',
  summary: 'Update my profile',
  description:
    'A true PATCH — only the fields present are touched, and `{}` is a valid no-op. `birthday` and ' +
    '`gender` accept `null` to clear them; `email` and `mobile` do not, because the ' +
    '`customer_needs_a_handle` constraint requires at least one of the two and clearing the last one ' +
    'would surface as a database error rather than a field message.' +
    '\n\n' +
    '**Changing `email` clears `emailVerified`; changing `mobile` clears `mobileVerified`.** Otherwise ' +
    'the profile form would be a way to mint a verified address you do not control. Re-verify a new ' +
    'mobile with `POST /v1/auth/otp/request`.' +
    '\n\n' +
    'Toggling `marketingOptIn` in either direction writes a timestamped, sourced record to the ' +
    'append-only consent log. An address or number already in use on another account returns 409.',
  tags: ['Account'],
  auth: 'customer',
  request: { body: updateProfileBody },
  responses: {
    200: { description: 'The updated profile.', schema: customerProfile },
    409: { description: 'That email address or mobile number belongs to another account.' },
  },
  handler: async ({ body, auth, req }) =>
    ok(await account.updateProfile(auth.customerId, body, clientIp(req))),
});

defineRoute(accountRouter, {
  method: 'get',
  path: '/v1/account/wishlist',
  surface: 'storefront',
  operationId: 'listMyWishlist',
  summary: 'List my wishlist',
  description:
    'Newest first, wrapped as `{ data, meta }`. Price, image and stock are read live on every request, ' +
    'so a saved product shows its current price rather than the one it had when it was hearted.' +
    '\n\n' +
    'A product that has since been unpublished or deleted still appears, with `available: false`. ' +
    'Dropping it silently would give the customer a shorter list with no explanation; this way the UI ' +
    'can say “no longer available” and offer to remove it.',
  tags: ['Account'],
  auth: 'customer',
  request: { query: paginationQuery },
  responses: {
    200: { description: 'A page of wishlist items.', schema: z.array(wishlistItem) },
    401: { description: 'Missing, expired or revoked access token.' },
  },
  handler: async ({ query, auth }) => {
    const { items, meta } = await account.listWishlist(auth.customerId, query);
    return paginated(items, meta);
  },
});

defineRoute(accountRouter, {
  method: 'post',
  path: '/v1/account/wishlist',
  surface: 'storefront',
  operationId: 'addWishlistItem',
  summary: 'Save a product to my wishlist',
  description:
    'Keyed by product id, not handle — a handle can be edited in the admin, and the storefront’s ' +
    'handle-keyed `localStorage` wishlist silently loses its entry when that happens.' +
    '\n\n' +
    'Idempotent: saving something already saved returns 201 with the same item rather than 409, ' +
    'because a heart icon tapped twice is not an error. An unpublished or unknown product is 404.',
  tags: ['Account'],
  auth: 'customer',
  request: { body: addWishlistItemBody },
  responses: {
    201: { description: 'Saved.', schema: wishlistItem },
    404: { description: 'No such published product.' },
  },
  handler: async ({ body, auth }) => created(await account.addWishlistItem(auth.customerId, body.productId)),
});

defineRoute(accountRouter, {
  method: 'delete',
  path: '/v1/account/wishlist/:productId',
  surface: 'storefront',
  operationId: 'removeWishlistItem',
  summary: 'Remove a product from my wishlist',
  description:
    'Removing something that was not saved returns 404 rather than a silent 204 — the storefront’s ' +
    'heart is optimistic, and a 404 is how it learns its local state has drifted and should re-fetch.',
  tags: ['Account'],
  auth: 'customer',
  request: { params: productIdParam },
  responses: {
    204: { description: 'Removed.' },
    404: { description: 'That product is not on your wishlist.' },
  },
  handler: async ({ params, auth }) => {
    await account.removeWishlistItem(auth.customerId, params.productId);
    return noContent();
  },
});
