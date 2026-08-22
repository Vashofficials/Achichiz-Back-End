/**
 * Account business rules — profile and wishlist.
 *
 * Two things here are more than CRUD.
 *
 * **Consent transitions are events, not field writes.** Flipping
 * `marketingOptIn` writes an append-only record through `leads.service` saying
 * when it changed, in which direction, from what source and from what IP. The
 * column tells you the state; the log is what answers "prove it" — and the
 * withdrawal is logged as carefully as the grant, because a withdrawal that
 * cannot be evidenced is the more expensive of the two to get wrong.
 *
 * **Changing a contact handle un-verifies it.** A customer who edits their email
 * to one they do not control must not inherit the old address's verified status;
 * `emailVerifiedAt` and `mobileVerifiedAt` are cleared on change. Anything else
 * turns the profile form into a way to mint a verified address.
 */

import { ConflictError, NotFoundError, UnauthenticatedError } from '../../lib/errors.js';
import { pageMeta, type PageMeta } from '../../lib/http.js';
import { offsetOf } from '../../lib/pagination.js';
import * as leadsService from '../leads/leads.service.js';
import * as repo from './account.repository.js';
import type { CustomerProfileResponse, UpdateProfileBody, WishlistItemResponse } from './account.schemas.js';

/* ------------------------------------------------------------ projections */

export function toProfile(row: repo.CustomerRow): CustomerProfileResponse {
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    mobile: row.mobile,
    birthday: row.birthday,
    gender: row.gender,
    emailVerified: row.emailVerifiedAt !== null,
    mobileVerified: row.mobileVerifiedAt !== null,
    marketingOptIn: row.marketingOptIn,
    whatsappOptIn: row.whatsappOptIn,
    hasPassword: row.passwordHash !== null,
    acceptsCod: row.acceptsCod,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toWishlistItem(row: repo.WishlistRow): WishlistItemResponse {
  return {
    productId: row.productId,
    handle: row.handle,
    title: row.title,
    imageUrl: row.imageUrl,
    fromPricePaise: row.fromPricePaise,
    inStock: row.available && row.availableQty > 0,
    available: row.available,
    addedAt: row.addedAt.toISOString(),
  };
}

/* ----------------------------------------------------------------- profile */

/**
 * The token verified, so this row existed when it was issued. If it is gone the
 * account was deleted mid-session — an expired session, not a missing resource.
 */
async function requireCustomer(customerId: string): Promise<repo.CustomerRow> {
  const row = await repo.findCustomerById(customerId);
  if (!row) throw new UnauthenticatedError('This session is no longer valid.');
  return row;
}

export async function getProfile(customerId: string): Promise<CustomerProfileResponse> {
  return toProfile(await requireCustomer(customerId));
}

export async function updateProfile(
  customerId: string,
  patch: UpdateProfileBody,
  ip: string | null,
): Promise<CustomerProfileResponse> {
  const current = await requireCustomer(customerId);

  const changes: Parameters<typeof repo.updateCustomer>[1] = {};

  if (patch.fullName !== undefined) changes.fullName = patch.fullName;
  if (patch.birthday !== undefined) changes.birthday = patch.birthday;
  if (patch.gender !== undefined) changes.gender = patch.gender;
  if (patch.whatsappOptIn !== undefined) changes.whatsappOptIn = patch.whatsappOptIn;

  // Email is CITEXT: `A@x.com` and `a@x.com` are the same address, so a
  // case-only edit is not a change and must not clear the verified flag.
  if (patch.email !== undefined && patch.email.toLowerCase() !== (current.email ?? '').toLowerCase()) {
    if (await repo.emailBelongsToAnother(patch.email, customerId)) {
      throw new ConflictError('That email address is already in use on another account.');
    }
    changes.email = patch.email;
    changes.emailVerifiedAt = null;
  }

  if (patch.mobile !== undefined && patch.mobile !== current.mobile) {
    if (await repo.mobileBelongsToAnother(patch.mobile, customerId)) {
      throw new ConflictError('That mobile number is already in use on another account.');
    }
    changes.mobile = patch.mobile;
    changes.mobileVerifiedAt = null;
  }

  const consentChanged =
    patch.marketingOptIn !== undefined && patch.marketingOptIn !== current.marketingOptIn;
  if (consentChanged) changes.marketingOptIn = patch.marketingOptIn;

  if (Object.keys(changes).length === 0) return toProfile(current);

  const updated = (await repo.updateCustomer(customerId, changes)) ?? current;

  if (consentChanged) {
    const label = updated.email ?? updated.mobile ?? 'storefront customer';
    if (patch.marketingOptIn === true) {
      await leadsService.recordMarketingConsent({ customerId, source: 'profile', ip, label });
    } else {
      await leadsService.recordMarketingWithdrawal({ customerId, source: 'profile', ip });
    }
  }

  return toProfile(updated);
}

/* ---------------------------------------------------------------- wishlist */

export async function listWishlist(
  customerId: string,
  query: { page: number; perPage: number },
): Promise<{ items: WishlistItemResponse[]; meta: PageMeta }> {
  const [rows, total] = await Promise.all([
    repo.listWishlist(customerId, {
      limit: query.perPage,
      offset: offsetOf(query.page, query.perPage),
    }),
    repo.countWishlist(customerId),
  ]);
  return { items: rows.map(toWishlistItem), meta: pageMeta(total, query.page, query.perPage) };
}

export async function addWishlistItem(
  customerId: string,
  productId: string,
): Promise<WishlistItemResponse> {
  if (!(await repo.findPublishedProduct(productId))) throw new NotFoundError('Product', productId);

  // Idempotent: the (customer_id, product_id) primary key means a second tap of
  // an already-filled heart is a no-op, not a 409.
  await repo.upsertWishlistItem(customerId, productId);

  const row = await repo.findWishlistRow(customerId, productId);
  if (!row) throw new NotFoundError('Product', productId);
  return toWishlistItem(row);
}

/**
 * Removing something that was not saved is a 404, not a silent 204.
 *
 * The distinction matters to the storefront: the heart icon is optimistic, and a
 * 404 tells it its local state had drifted and should be re-fetched.
 */
export async function removeWishlistItem(customerId: string, productId: string): Promise<void> {
  const removed = await repo.deleteWishlistItem(customerId, productId);
  if (removed === 0) throw new NotFoundError('Wishlist item', productId);
}
