import { describe, expect, it } from 'vitest';
import { planDefault, toAddress } from './addresses.service.js';
import { addressBody, updateAddressBody } from './addresses.schemas.js';
import type { AddressRow } from './addresses.repository.js';

/**
 * Pure tests over the default-address invariant and the address contract.
 *
 * `planDefault` is small and it is the piece the database will punish us for
 * getting wrong: `uq_one_default_address_per_customer` is a **partial unique
 * index**, and a unique index cannot be deferred to COMMIT. Every case where the
 * flag moves has to say so, so the service can clear the incumbent BEFORE writing
 * the new holder inside the same transaction. Getting `clearExistingDefault`
 * wrong is a 23505 on a customer saving their office address.
 */

const NOW = new Date('2026-08-08T10:00:00.000Z');

const addressRow = (overrides: Partial<AddressRow> = {}): AddressRow => ({
  id: '22222222-2222-4222-8222-222222222222',
  customerId: '11111111-1111-4111-8111-111111111111',
  label: 'Home',
  contactName: 'Arjun Mehta',
  mobile: '9820012345',
  line1: '12 Carter Road',
  line2: null,
  area: 'Bandra West',
  city: 'Mumbai',
  stateCode: '27',
  pincode: '400050',
  countryCode: 'IN',
  isDefault: true,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

describe('planDefault — the one-default-per-customer invariant', () => {
  it('makes the very first address the default without being asked', () => {
    // The storefront does this in the browser today, so an address created by
    // checkout's `saveToAddressBook`, an admin or an import misses it entirely
    // and the customer ends up with addresses and no default.
    expect(planDefault({ requested: undefined, hasOtherAddresses: false, alreadyDefault: false })).toEqual(
      { isDefault: true, clearExistingDefault: false },
    );
  });

  it('does not make a subsequent address default when nobody asked', () => {
    expect(planDefault({ requested: undefined, hasOtherAddresses: true, alreadyDefault: false })).toEqual(
      { isDefault: false, clearExistingDefault: false },
    );
  });

  it('leaves the flag alone on an unrelated edit to the address that holds it', () => {
    // Renaming "Home" to "Flat" must not silently demote it.
    expect(planDefault({ requested: undefined, hasOtherAddresses: true, alreadyDefault: true })).toEqual(
      { isDefault: true, clearExistingDefault: false },
    );
  });

  it('promotes on request, and says the incumbent must be stood down first', () => {
    expect(planDefault({ requested: true, hasOtherAddresses: true, alreadyDefault: false })).toEqual({
      isDefault: true,
      clearExistingDefault: true,
    });
  });

  it('does not try to clear anything when the requester is already the default', () => {
    // Clearing "every default except this one" would be harmless but pointless;
    // more importantly, a plan that says "clear" for a no-op invites a
    // clear-then-set round trip that briefly leaves the customer with none.
    expect(planDefault({ requested: true, hasOtherAddresses: true, alreadyDefault: true })).toEqual({
      isDefault: true,
      clearExistingDefault: false,
    });
  });

  it('does not try to clear an incumbent that cannot exist', () => {
    // First address, explicitly flagged. There is nothing to stand down, and
    // issuing the UPDATE anyway would be a pointless write on the hot path.
    expect(planDefault({ requested: true, hasOtherAddresses: false, alreadyDefault: false })).toEqual({
      isDefault: true,
      clearExistingDefault: false,
    });
  });

  it('cannot leave a lone address without the flag', () => {
    // `isDefault: false` on the only address: the trigger would immediately
    // re-promote it, so the plan says what will actually be true.
    expect(planDefault({ requested: false, hasOtherAddresses: false, alreadyDefault: true })).toEqual({
      isDefault: true,
      clearExistingDefault: false,
    });
  });

  it('never asks to clear a default it is not about to replace', () => {
    // The property that matters: `clearExistingDefault` implies `isDefault`.
    // A plan that clears the incumbent without taking the flag leaves the
    // customer with no default at all until the trigger guesses one.
    const options = [true, false, undefined] as const;
    for (const requested of options) {
      for (const hasOtherAddresses of [true, false]) {
        for (const alreadyDefault of [true, false]) {
          const plan = planDefault({ requested, hasOtherAddresses, alreadyDefault });
          if (plan.clearExistingDefault) expect(plan.isDefault).toBe(true);
          if (plan.clearExistingDefault) expect(alreadyDefault).toBe(false);
        }
      }
    }
  });
});

describe('address contract', () => {
  const valid = {
    contactName: 'Arjun Mehta',
    mobile: '9820012345',
    line1: '12 Carter Road',
    city: 'Mumbai',
    stateCode: '27',
    pincode: '400050',
  };

  it('defaults the label and the country so a minimal form still works', () => {
    const parsed = addressBody.parse(valid);
    expect(parsed.label).toBe('Home');
    expect(parsed.countryCode).toBe('IN');
    expect(parsed.isDefault).toBeUndefined();
  });

  it('rejects a PIN code that is not six digits starting 1-9', () => {
    for (const bad of ['012345', '40005', '4000500', '40005a']) {
      expect(addressBody.safeParse({ ...valid, pincode: bad }).success).toBe(false);
    }
  });

  it('rejects a state code outside the GST two-digit range', () => {
    // It is a foreign key to `gst_states`, and it decides IGST vs CGST+SGST —
    // a wrong value here is a wrong tax invoice, not a cosmetic error.
    for (const bad of ['7', '400', 'MH', '99']) {
      expect(addressBody.safeParse({ ...valid, stateCode: bad }).success).toBe(false);
    }
    expect(addressBody.safeParse({ ...valid, stateCode: '27' }).success).toBe(true);
    expect(addressBody.safeParse({ ...valid, stateCode: '07' }).success).toBe(true);
  });

  it('rejects a delivery mobile that is not an Indian ten-digit number', () => {
    expect(addressBody.safeParse({ ...valid, mobile: '+919820012345' }).success).toBe(false);
  });

  it('accepts an empty PATCH as a no-op', () => {
    const parsed = updateAddressBody.parse({});
    expect(parsed).toEqual({});
  });

  it('does not resurrect defaults on a PATCH', () => {
    // `.partial()` must strip the `label`/`countryCode` defaults, or every PATCH
    // would quietly reset the label to "Home".
    expect(updateAddressBody.parse({ city: 'Pune' })).toEqual({ city: 'Pune' });
  });
});

describe('toAddress', () => {
  it('serialises timestamps as ISO-8601 and preserves nulls', () => {
    expect(toAddress(addressRow({ line2: null, area: null }))).toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Home',
      contactName: 'Arjun Mehta',
      mobile: '9820012345',
      line1: '12 Carter Road',
      line2: null,
      area: null,
      city: 'Mumbai',
      stateCode: '27',
      pincode: '400050',
      countryCode: 'IN',
      isDefault: true,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it('does not leak the owning customer id or the soft-delete marker', () => {
    const serialised = toAddress(addressRow());
    expect(serialised).not.toHaveProperty('customerId');
    expect(serialised).not.toHaveProperty('deletedAt');
  });
});
