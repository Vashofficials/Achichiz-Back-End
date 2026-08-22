import { describe, expect, it } from 'vitest';
import { toProfile, toWishlistItem } from './account.service.js';
import { addWishlistItemBody, updateProfileBody } from './account.schemas.js';
import type { CustomerRow, WishlistRow } from './account.repository.js';

/**
 * Pure tests over the profile contract and the two projections.
 *
 * The PATCH contract carries most of the risk here: it is the only place a
 * customer can change the two columns that are also unique keys, and `.partial()`
 * behaviour around defaults and nulls decides whether "leave it alone" and "clear
 * it" stay distinguishable. Conflating them means a form that submits every field
 * wipes whatever the customer did not fill in.
 */

const NOW = new Date('2026-08-08T10:00:00.000Z');

const customerRow = (overrides: Partial<CustomerRow> = {}): CustomerRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'arjun@example.com',
  mobile: '9820012345',
  fullName: 'Arjun Mehta',
  birthday: '1992-03-14',
  gender: 'male',
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
  authProviderUid: null,
  emailVerifiedAt: NOW,
  mobileVerifiedAt: null,
  marketingOptIn: false,
  whatsappOptIn: false,
  segment: null,
  corporateAccountId: null,
  defaultBillingGstin: null,
  tags: [],
  acceptsCod: true,
  blockedAt: null,
  blockedReason: null,
  firstOrderAt: null,
  lastOrderAt: null,
  legacyRef: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

const wishlistRow = (overrides: Partial<WishlistRow> = {}): WishlistRow => ({
  productId: '33333333-3333-4333-8333-333333333333',
  handle: 'cork-diary',
  title: 'Cork Diary',
  imageUrl: 'https://cdn.achichiz.com/cork-diary.jpg',
  fromPricePaise: 149_900,
  availableQty: 12,
  available: true,
  addedAt: NOW,
  ...overrides,
});

describe('toProfile', () => {
  it('projects verification timestamps to booleans and never exposes the hash', () => {
    const profile = toProfile(customerRow());
    expect(profile.emailVerified).toBe(true);
    expect(profile.mobileVerified).toBe(false);
    expect(profile.hasPassword).toBe(true);
    expect(JSON.stringify(profile)).not.toContain('argon2');
    expect(profile).not.toHaveProperty('passwordHash');
  });

  it('does not leak internal segmentation, blocking or soft-delete state', () => {
    const profile = toProfile(customerRow({ segment: 'vip', blockedReason: 'chargebacks' }));
    expect(profile).not.toHaveProperty('segment');
    expect(profile).not.toHaveProperty('blockedReason');
    expect(profile).not.toHaveProperty('deletedAt');
    expect(profile).not.toHaveProperty('legacyRef');
  });

  it('keeps birthday as a bare date, with no timezone attached', () => {
    // `customers.birthday` is a DATE. Serialising it through a Date object would
    // shift it a day for anyone east or west of the server.
    expect(toProfile(customerRow()).birthday).toBe('1992-03-14');
    expect(toProfile(customerRow({ birthday: null })).birthday).toBeNull();
  });

  it('handles a mobile-only OTP account', () => {
    const profile = toProfile(
      customerRow({ email: null, passwordHash: null, emailVerifiedAt: null, mobileVerifiedAt: NOW }),
    );
    expect(profile.email).toBeNull();
    expect(profile.hasPassword).toBe(false);
    expect(profile.mobileVerified).toBe(true);
  });
});

describe('toWishlistItem', () => {
  it('reports a live, stocked product as in stock', () => {
    expect(toWishlistItem(wishlistRow())).toEqual({
      productId: '33333333-3333-4333-8333-333333333333',
      handle: 'cork-diary',
      title: 'Cork Diary',
      imageUrl: 'https://cdn.achichiz.com/cork-diary.jpg',
      fromPricePaise: 149_900,
      inStock: true,
      available: true,
      addedAt: NOW.toISOString(),
    });
  });

  it('is out of stock at exactly zero available', () => {
    expect(toWishlistItem(wishlistRow({ availableQty: 0 })).inStock).toBe(false);
  });

  it('is never in stock once the product is unpublished, whatever inventory says', () => {
    // Stock rows outlive publication. Showing "in stock" for a product that
    // cannot be added to a cart is a promise the PDP will not keep.
    const row = wishlistRow({ available: false, availableQty: 40 });
    expect(toWishlistItem(row).inStock).toBe(false);
    expect(toWishlistItem(row).available).toBe(false);
  });

  it('carries a null price rather than pretending zero', () => {
    // No purchasable variant means there is no "from" price. Zero would render
    // as ₹0.00 — an offer nobody made.
    expect(toWishlistItem(wishlistRow({ fromPricePaise: null })).fromPricePaise).toBeNull();
  });
});

describe('profile PATCH contract', () => {
  it('accepts an empty body as a no-op', () => {
    expect(updateProfileBody.parse({})).toEqual({});
  });

  it('keeps "leave it alone" and "clear it" distinguishable', () => {
    // `undefined` (absent) must not become `null` (clear), or a form that submits
    // every field wipes the ones the customer left blank.
    expect(updateProfileBody.parse({ fullName: 'Arjun M' })).toEqual({ fullName: 'Arjun M' });
    expect(updateProfileBody.parse({ birthday: null })).toEqual({ birthday: null });
    expect('birthday' in updateProfileBody.parse({ fullName: 'Arjun M' })).toBe(false);
  });

  it('allows clearing birthday and gender but not the contact handles', () => {
    // `customer_needs_a_handle` requires an email OR a mobile. Accepting `null`
    // here would surface as a database CHECK violation instead of a field message.
    expect(updateProfileBody.safeParse({ birthday: null }).success).toBe(true);
    expect(updateProfileBody.safeParse({ gender: null }).success).toBe(true);
    expect(updateProfileBody.safeParse({ email: null }).success).toBe(false);
    expect(updateProfileBody.safeParse({ mobile: null }).success).toBe(false);
  });

  it('requires a full YYYY-MM-DD birthday', () => {
    expect(updateProfileBody.safeParse({ birthday: '1992-03-14' }).success).toBe(true);
    expect(updateProfileBody.safeParse({ birthday: '14/03/1992' }).success).toBe(false);
    expect(updateProfileBody.safeParse({ birthday: '1992-3-4' }).success).toBe(false);
  });

  it('restricts gender to the values the CHECK constraint permits', () => {
    for (const gender of ['female', 'male', 'other', 'undisclosed']) {
      expect(updateProfileBody.safeParse({ gender }).success).toBe(true);
    }
    expect(updateProfileBody.safeParse({ gender: 'unspecified' }).success).toBe(false);
  });

  it('validates a new mobile as an Indian ten-digit number', () => {
    expect(updateProfileBody.safeParse({ mobile: '9820012345' }).success).toBe(true);
    expect(updateProfileBody.safeParse({ mobile: '+919820012345' }).success).toBe(false);
  });

  it('does not accept the read-only fields as input', () => {
    // `emailVerified`, `acceptsCod` and friends are derived or ops-owned. zod
    // strips unknown keys, so sending them is silently ignored rather than
    // becoming an update.
    const parsed = updateProfileBody.parse({
      fullName: 'Arjun M',
      emailVerified: true,
      acceptsCod: false,
      id: 'someone-else',
    });
    expect(parsed).toEqual({ fullName: 'Arjun M' });
  });
});

describe('wishlist contract', () => {
  it('takes a product id, not a handle', () => {
    // The storefront's localStorage wishlist is keyed by handle, so it silently
    // loses the entry whenever a handle is edited in the admin.
    expect(
      addWishlistItemBody.safeParse({ productId: '33333333-3333-4333-8333-333333333333' }).success,
    ).toBe(true);
    expect(addWishlistItemBody.safeParse({ productId: 'cork-diary' }).success).toBe(false);
  });
});
