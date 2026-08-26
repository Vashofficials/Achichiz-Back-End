import { describe, expect, it } from 'vitest';
import {
  normaliseIndianMobile,
  outcomeOf,
  providerOf,
  resolveFirebaseIdentity,
  toE164,
  type ExistingCustomer,
  type FirebaseIdentity,
  type Resolution,
  type ResolutionInput,
} from './firebase-identity.js';

/**
 * Pure tests. No Firebase, no Postgres.
 *
 * Firebase decides whether the OTP was right. This file's subject decides what
 * that means for OUR `customers` table, and that second half is where an account
 * takeover or a corrupted delivery phone number would live. Both are the kind of
 * bug nobody notices until it is somebody else's order history, so the decision
 * table is swept exhaustively rather than sampled.
 *
 * Two invariants carry most of the weight:
 *   1. a number we cannot store is REFUSED, never truncated into a different one;
 *   2. an UNVERIFIED email is not a matching signal, so it can never link.
 */

/* ------------------------------------------------------------------ fixtures */

const identity = (overrides: Partial<FirebaseIdentity> = {}): FirebaseIdentity => ({
  uid: 'fb-uid-token',
  phoneNumber: '+919820012345',
  email: null,
  emailVerified: false,
  signInProvider: 'phone',
  ...overrides,
});

const customer = (overrides: Partial<ExistingCustomer> = {}): ExistingCustomer => ({
  id: 'customer-1',
  firebaseUid: null,
  mobile: '9820012345',
  email: 'arjun@example.com',
  blockedAt: null,
  ...overrides,
});

const resolve = (overrides: Partial<ResolutionInput> = {}): Resolution =>
  resolveFirebaseIdentity({
    identity: identity(),
    byFirebaseUid: null,
    byMobile: null,
    byEmail: null,
    ...overrides,
  });

const BLOCKED = new Date('2026-07-01T09:00:00.000Z');

/* =========================================================== mobile normalising */

describe('normaliseIndianMobile — the shapes a number actually arrives in', () => {
  it('accepts E.164, the bare country code, ten digits, and the 0-trunk form', () => {
    // `customers.mobile` is DOMAIN mobile_in — ten digits, no country code. All
    // four of these are the same subscriber and must land on the same stored value,
    // or the same person gets a second account every time the form differs.
    for (const raw of ['+919820012345', '919820012345', '9820012345', '09820012345']) {
      expect(normaliseIndianMobile(raw)).toEqual({ ok: true, mobile: '9820012345' });
    }
  });

  it('strips the punctuation humans and Firebase consoles write numbers with', () => {
    for (const raw of ['+91 98200-12345', '+91 (982) 001 2345', '+91-98200-12345', ' 9820012345 ']) {
      expect(normaliseIndianMobile(raw)).toEqual({ ok: true, mobile: '9820012345' });
    }
  });

  it('accepts every first digit the DOMAIN allows, and no other', () => {
    // The CHECK is `^[6-9][0-9]{9}$`. Accepting a digit the column rejects turns a
    // sign-in into a constraint violation at INSERT time — a 500, not a 4xx.
    for (let first = 0; first <= 9; first += 1) {
      const raw = `${String(first)}123456789`;
      const expected = first >= 6 ? { ok: true, mobile: raw } : { ok: false, reason: 'malformed' };
      expect(normaliseIndianMobile(raw)).toEqual(expected);
    }
  });
});

describe('normaliseIndianMobile — nothing to normalise', () => {
  it('reports a missing number as missing rather than malformed', () => {
    // `missing` and `malformed` mean different things to the caller: one is a
    // provider that carries no phone (Google), the other is a number we refused.
    expect(normaliseIndianMobile(null)).toEqual({ ok: false, reason: 'missing' });
    expect(normaliseIndianMobile(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(normaliseIndianMobile('')).toEqual({ ok: false, reason: 'missing' });
    expect(normaliseIndianMobile('   ')).toEqual({ ok: false, reason: 'missing' });
    expect(normaliseIndianMobile('\t\n ')).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('normaliseIndianMobile — refuses international numbers instead of truncating them', () => {
  it('rejects a US number, and does NOT hand back its last ten digits', () => {
    const result = normaliseIndianMobile('+14155552671');
    expect(result).toEqual({ ok: false, reason: 'not_indian' });
    // THE assertion in this file. `4155552671` is not this customer's number — it is
    // a different, quite possibly real, Indian subscriber. Truncating would write a
    // stranger's phone onto a delivery address and route the courier's call to them.
    // A refused international sign-in is a product limitation; this would be a
    // data-corruption bug that only surfaces at somebody's doorstep.
    expect(JSON.stringify(result)).not.toContain('4155552671');
  });

  it('rejects a UK number the same way', () => {
    const result = normaliseIndianMobile('+442071838750');
    expect(result).toEqual({ ok: false, reason: 'not_indian' });
    // 442071838750 is twelve digits but does not start 91, so the +91 branch must
    // not claim it — `2071838750` would otherwise pass the 6-9 check as `7...`.
    expect(JSON.stringify(result)).not.toContain('2071838750');
  });

  it('rejects an international number written without the leading +', () => {
    // Same number, no plus: still refused, still not truncated.
    expect(normaliseIndianMobile('14155552671')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a +91 number carrying too many digits', () => {
    expect(normaliseIndianMobile('+919820012345678')).toEqual({ ok: false, reason: 'not_indian' });
    expect(normaliseIndianMobile('+91982001234')).toEqual({ ok: false, reason: 'not_indian' });
  });

  /**
   * REGRESSION. This suite originally found `normaliseIndianMobile` testing
   * `digits.length === 10` BEFORE it looked at whether the input was `+`-prefixed,
   * so a `+`-prefixed number totalling exactly ten digits was swallowed whole —
   * country code and all — and waved through by the 6-9 check.
   *
   * That was the failure the file's own header swears cannot happen ("silently
   * rewriting somebody's phone number is a data-corruption bug that surfaces at
   * the doorstep"), arriving from the other direction: nothing was truncated, the
   * country code was absorbed INTO the subscriber number.
   *
   * It was reachable with real numbers, not just typos. Each of these was accepted
   * and stored as an Indian mobile:
   *   +6591234567  Singapore   → 6591234567
   *   +6421234567  New Zealand → 6421234567
   *   +8491234567  Vietnam     → 8491234567
   * and `+9198200123`, a mistyped Indian number two digits short, became the
   * unrelated-but-plausible subscriber 9198200123.
   */
  it('rejects a +prefixed number that is only ten digits INCLUDING its country code', () => {
    // Regression. A leading `+` means E.164, and E.164 always carries a country
    // code — so a `+`-prefixed ten-digit number cannot be Indian, whatever its
    // first digit happens to be. `+6591234567` is Singapore (+65, subscriber
    // 91234567); accepting it as the Indian number 6591234567 handed a Firebase
    // token proving control of the Singapore line straight to whoever holds that
    // Indian number.
    expect(normaliseIndianMobile('+9198200123').ok).toBe(false);
    expect(normaliseIndianMobile('+6591234567').ok).toBe(false);
    expect(normaliseIndianMobile('+6421234567').ok).toBe(false);
    expect(normaliseIndianMobile('+8491234567').ok).toBe(false);
  });

  it('calls those numbers foreign rather than malformed', () => {
    // The reason matters: `not_indian` is what the service turns into
    // "we only deliver within India", which is true and actionable.
    expect(normaliseIndianMobile('+6591234567')).toEqual({ ok: false, reason: 'not_indian' });
    expect(normaliseIndianMobile('+9198200123')).toEqual({ ok: false, reason: 'not_indian' });
  });

  it('still accepts the genuine +91 form', () => {
    // The fix must not cost the only E.164 shape that IS Indian.
    expect(normaliseIndianMobile('+919820012345')).toEqual({ ok: true, mobile: '9820012345' });
  });
});

describe('normaliseIndianMobile — not a mobile at all', () => {
  it('rejects ten digits starting 0-5 as a landline or a typo', () => {
    for (const raw of ['5820012345', '0820012345', '1234567890', '4445556667']) {
      expect(normaliseIndianMobile(raw).ok).toBe(false);
    }
  });

  it('rejects letters, a lone plus, and an empty stem', () => {
    for (const raw of ['9820abcdef', 'not-a-number', '+', '()', '98200+12345', '+-+-']) {
      expect(normaliseIndianMobile(raw)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('rejects non-ASCII digits rather than treating them as numeric', () => {
    // Eastern Arabic numerals render as a phone number to a human and to some
    // input methods. `\d` is ASCII-only, so they must be refused, not half-parsed.
    expect(normaliseIndianMobile('٩٨٢٠٠١٢٣٤٥')).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects an absurdly long input without hanging or accepting a prefix', () => {
    expect(normaliseIndianMobile('9'.repeat(30)).ok).toBe(false);
    expect(normaliseIndianMobile(`+${'9'.repeat(30)}`).ok).toBe(false);
    expect(normaliseIndianMobile('9'.repeat(4000)).ok).toBe(false);
  });

  it('calls an Indian-shaped number with a bad local part malformed, not not_indian', () => {
    // The two reasons are not interchangeable: the service turns `not_indian` into
    // "we only deliver within India" and `malformed` into "check that number".
    // Every input here IS Indian — `+91`, the bare 91-twelve, the 0-trunk eleven,
    // the bare ten — and only the local part is wrong, so telling the customer
    // their own number is foreign would send them looking for the wrong mistake.
    for (const raw of ['+915820012345', '915820012345', '05820012345', '5820012345']) {
      expect(normaliseIndianMobile(raw)).toEqual({ ok: false, reason: 'malformed' });
    }
    // `not_indian` stays reserved for what it says: another country's code.
    expect(normaliseIndianMobile('+14155552671')).toEqual({ ok: false, reason: 'not_indian' });
  });

  it('never returns ok with a value the DOMAIN would reject — sweep', () => {
    const inputs = [
      '+919820012345', '919820012345', '9820012345', '09820012345', '+91 98200-12345',
      '+14155552671', '+442071838750', '+8613800138000', '+971501234567', '+12125551234',
      '5820012345', '0123456789', '', '   ', '+', 'abcdefghij', '9'.repeat(20), '91',
      '+91', '+910000000000', '00919820012345', '919820012345678', '9.8.2.0.0.1.2.3.4.5',
    ];
    for (const raw of inputs) {
      const result = normaliseIndianMobile(raw);
      if (result.ok) expect(result.mobile).toMatch(/^[6-9][0-9]{9}$/);
    }
  });
});

describe('toE164', () => {
  it('puts the country code back for anything that talks to a gateway', () => {
    expect(toE164('9820012345')).toBe('+919820012345');
  });

  it('round-trips with normaliseIndianMobile for every acceptable number', () => {
    // The two functions are each other's inverse across the whole valid space. If
    // they ever drift, an OTP goes to a number we did not store and the customer
    // is locked out of the account they just created.
    for (const first of ['6', '7', '8', '9']) {
      for (let tail = 0; tail < 20; tail += 1) {
        const mobile = `${first}${String(tail).padStart(9, '0')}`;
        expect(normaliseIndianMobile(mobile)).toEqual({ ok: true, mobile });
        expect(normaliseIndianMobile(toE164(mobile))).toEqual({ ok: true, mobile });
      }
    }
  });
});

/* ======================================================= the resolution order */

describe('resolveFirebaseIdentity — 1. a UID we have seen before', () => {
  it('signs the customer straight in', () => {
    expect(resolve({ byFirebaseUid: customer({ id: 'cust-uid', firebaseUid: 'fb-uid-token' }) })).toEqual({
      action: 'sign_in',
      customerId: 'cust-uid',
      matchedOn: 'firebase_uid',
    });
  });

  it('wins over a mobile match and an email match', () => {
    // The UID is the credential we already attached to an account. If a later
    // signal disagreed and won, a returning customer would be re-linked to a
    // different row on every sign-in.
    expect(
      resolve({
        identity: identity({ email: 'arjun@example.com', emailVerified: true }),
        byFirebaseUid: customer({ id: 'cust-uid', firebaseUid: 'fb-uid-token' }),
        byMobile: customer({ id: 'cust-mobile' }),
        byEmail: customer({ id: 'cust-email' }),
      }),
    ).toEqual({ action: 'sign_in', customerId: 'cust-uid', matchedOn: 'firebase_uid' });
  });
});

describe('resolveFirebaseIdentity — 2. a proven phone number', () => {
  it('links the Firebase credential onto the existing customer', () => {
    // Firebase phone sign-in PROVES the bearer received an SMS at that number.
    // Matching on it and attaching the credential is correct; refusing would
    // strand every pre-Firebase customer behind an account they cannot reach.
    expect(resolve({ byMobile: customer({ id: 'cust-mobile' }) })).toEqual({
      action: 'link',
      customerId: 'cust-mobile',
      matchedOn: 'mobile',
      setFirebaseUid: 'fb-uid-token',
    });
  });

  it('links the UID from the TOKEN, never anything already on the row', () => {
    const r = resolve({
      identity: identity({ uid: 'fb-uid-token' }),
      byMobile: customer({ id: 'cust-mobile', firebaseUid: null }),
    });
    expect(r).toMatchObject({ setFirebaseUid: 'fb-uid-token' });
  });

  it('matches on the normalised number, whatever shape the token used', () => {
    for (const raw of ['+919820012345', '9820012345', '09820012345', '+91 98200 12345']) {
      expect(resolve({ identity: identity({ phoneNumber: raw }), byMobile: customer({ id: 'c' }) })).toEqual({
        action: 'link',
        customerId: 'c',
        matchedOn: 'mobile',
        setFirebaseUid: 'fb-uid-token',
      });
    }
  });

  it('wins over a verified email pointing at a different customer', () => {
    expect(
      resolve({
        identity: identity({ email: 'arjun@example.com', emailVerified: true }),
        byMobile: customer({ id: 'cust-mobile' }),
        byEmail: customer({ id: 'cust-email' }),
      }),
    ).toMatchObject({ action: 'link', customerId: 'cust-mobile', matchedOn: 'mobile' });
  });
});

describe('resolveFirebaseIdentity — 3. a VERIFIED email', () => {
  it('links when Firebase says the address was verified', () => {
    expect(
      resolve({
        identity: identity({
          signInProvider: 'google.com',
          phoneNumber: null,
          email: 'arjun@example.com',
          emailVerified: true,
        }),
        byEmail: customer({ id: 'cust-email' }),
      }),
    ).toEqual({
      action: 'link',
      customerId: 'cust-email',
      matchedOn: 'email',
      setFirebaseUid: 'fb-uid-token',
    });
  });
});

describe('resolveFirebaseIdentity — an UNVERIFIED email is not a signal', () => {
  const unverified = identity({
    signInProvider: 'google.com',
    phoneNumber: null,
    email: 'founder@achichiz.in',
    emailVerified: false,
  });

  it('creates a new customer instead of linking to the matching row', () => {
    // The account-takeover case. Firebase will happily mint a token carrying an
    // arbitrary UNVERIFIED email — a self-asserted Google address, or an
    // email/password account nobody confirmed. Linking on that would let anyone
    // who types `founder@achichiz.in` into a signup form inherit that customer's
    // account, their saved addresses and their whole order history.
    expect(resolve({ identity: unverified, byEmail: customer({ id: 'cust-email' }) })).toEqual({
      action: 'create',
      mobile: null,
      email: 'founder@achichiz.in',
      emailVerified: false,
    });
  });

  it('does not reject either — a duplicate account is the conservative failure', () => {
    // Erroring would strand a legitimate Google user whose provider simply did not
    // assert verification. A duplicate is an annoyance somebody can merge later;
    // a takeover is not, and a lockout loses the order. So: fall through to create.
    const r = resolve({ identity: unverified, byEmail: customer({ id: 'cust-email' }) });
    expect(r.action).not.toBe('reject');
    expect(r.action).not.toBe('link');
  });

  it('does not leak that the address is taken, even by the reason code', () => {
    // The result for a matching unverified address is byte-identical to the result
    // for an address nobody holds. Anything else is an account-enumeration oracle.
    const matched = resolve({ identity: unverified, byEmail: customer({ id: 'cust-email' }) });
    const unmatched = resolve({ identity: unverified, byEmail: null });
    expect(matched).toEqual(unmatched);
  });

  it('does not link even when the matching row carries no Firebase UID yet', () => {
    // The row looks "free" to claim. It is not — verification, not vacancy, is
    // what authorises the link.
    expect(
      resolve({ identity: unverified, byEmail: customer({ id: 'cust-email', firebaseUid: null }) }),
    ).toMatchObject({ action: 'create' });
  });

  it('does not report a uid_conflict when the matching row carries a different UID', () => {
    // An unverified email must not even be able to probe another account's state.
    expect(
      resolve({ identity: unverified, byEmail: customer({ id: 'cust-email', firebaseUid: 'fb-uid-other' }) }),
    ).toMatchObject({ action: 'create' });
  });

  it('flipping only emailVerified is what turns create into link', () => {
    // The entire takeover defence hangs on this one boolean, so it is asserted as
    // a pair: same inputs, one flag, two different outcomes.
    const row = customer({ id: 'cust-email' });
    const base = { signInProvider: 'google.com', phoneNumber: null, email: 'arjun@example.com' };
    expect(
      resolve({ identity: identity({ ...base, emailVerified: false }), byEmail: row }),
    ).toMatchObject({ action: 'create' });
    expect(resolve({ identity: identity({ ...base, emailVerified: true }), byEmail: row })).toMatchObject({
      action: 'link',
      customerId: 'cust-email',
      matchedOn: 'email',
    });
  });

  it('still links on a proven phone number — verification only gates the email branch', () => {
    expect(
      resolve({
        identity: identity({ email: 'arjun@example.com', emailVerified: false }),
        byMobile: customer({ id: 'cust-mobile' }),
        byEmail: customer({ id: 'cust-email' }),
      }),
    ).toMatchObject({ action: 'link', customerId: 'cust-mobile', matchedOn: 'mobile' });
  });

  it('creates rather than rejecting when the unverified match is a BLOCKED account', () => {
    // Pinned deliberately, and it is the one place the header's "blocked is refused
    // at every branch, including CREATE" does not hold: an unverified email is not a
    // signal at all, so the blocked row it happens to hit cannot be acted on either.
    // Rejecting here would hand anybody an oracle for which addresses are blocked,
    // on nothing better than a self-asserted claim.
    expect(
      resolve({ identity: unverified, byEmail: customer({ id: 'cust-email', blockedAt: BLOCKED }) }),
    ).toMatchObject({ action: 'create' });
  });
});

describe('resolveFirebaseIdentity — 4. nothing matched', () => {
  it('creates a customer carrying the phone number', () => {
    expect(resolve()).toEqual({
      action: 'create',
      mobile: '9820012345',
      email: null,
      emailVerified: false,
    });
  });

  it('creates a customer carrying the email and its verification state', () => {
    expect(
      resolve({
        identity: identity({
          signInProvider: 'google.com',
          phoneNumber: null,
          email: 'arjun@example.com',
          emailVerified: true,
        }),
      }),
    ).toEqual({ action: 'create', mobile: null, email: 'arjun@example.com', emailVerified: true });
  });

  it('carries emailVerified through honestly rather than assuming it', () => {
    // The service writes `email_verified_at` from this flag. Defaulting it to true
    // would mark an unconfirmed address as confirmed, and the NEXT sign-in would
    // then be allowed to link on it — the takeover, one step later.
    expect(
      resolve({
        identity: identity({ signInProvider: 'google.com', email: 'a@b.com', emailVerified: false }),
      }),
    ).toMatchObject({ emailVerified: false });
  });

  it('stores the normalised ten digits, not the E.164 Firebase sent', () => {
    expect(resolve({ identity: identity({ phoneNumber: '+919820012345' }) })).toMatchObject({
      mobile: '9820012345',
    });
  });
});

/* ============================================================ refusal branches */

describe('resolveFirebaseIdentity — blocked accounts', () => {
  it('refuses a blocked customer matched on firebase_uid', () => {
    expect(
      resolve({ byFirebaseUid: customer({ id: 'cust-uid', firebaseUid: 'fb-uid-token', blockedAt: BLOCKED }) }),
    ).toEqual({ action: 'reject', reason: 'account_blocked', customerId: 'cust-uid' });
  });

  it('refuses a blocked customer matched on a proven mobile', () => {
    expect(resolve({ byMobile: customer({ id: 'cust-mobile', blockedAt: BLOCKED }) })).toEqual({
      action: 'reject',
      reason: 'account_blocked',
      customerId: 'cust-mobile',
    });
  });

  it('refuses a blocked customer matched on a verified email', () => {
    expect(
      resolve({
        identity: identity({
          signInProvider: 'google.com',
          phoneNumber: null,
          email: 'arjun@example.com',
          emailVerified: true,
        }),
        byEmail: customer({ id: 'cust-email', blockedAt: BLOCKED }),
      }),
    ).toEqual({ action: 'reject', reason: 'account_blocked', customerId: 'cust-email' });
  });

  it('names the customer so the refusal can be audited', () => {
    // `customer_auth_events` records who was refused. A reject with no customerId
    // is an unattributable event — support cannot answer "why can I not log in?".
    for (const input of [
      { byFirebaseUid: customer({ id: 'blocked-1', firebaseUid: 'fb-uid-token', blockedAt: BLOCKED }) },
      { byMobile: customer({ id: 'blocked-1', blockedAt: BLOCKED }) },
    ]) {
      expect(resolve(input)).toMatchObject({ customerId: 'blocked-1' });
    }
  });

  it('refuses before considering any later match', () => {
    // A blocked row must not be escaped by also holding a second matching signal.
    expect(
      resolve({
        identity: identity({ email: 'arjun@example.com', emailVerified: true }),
        byMobile: customer({ id: 'cust-mobile', blockedAt: BLOCKED }),
        byEmail: customer({ id: 'cust-email' }),
      }),
    ).toEqual({ action: 'reject', reason: 'account_blocked', customerId: 'cust-mobile' });
  });

  it('blocks even when the credential would otherwise link cleanly', () => {
    expect(
      resolve({ byMobile: customer({ id: 'cust-mobile', firebaseUid: 'fb-uid-token', blockedAt: BLOCKED }) }),
    ).toEqual({ action: 'reject', reason: 'account_blocked', customerId: 'cust-mobile' });
  });
});

describe('resolveFirebaseIdentity — two Firebase accounts claiming one row', () => {
  it('refuses to move a mobile-matched row onto a different UID', () => {
    const r = resolve({ byMobile: customer({ id: 'cust-mobile', firebaseUid: 'fb-uid-other' }) });
    expect(r).toEqual({ action: 'reject', reason: 'uid_conflict', customerId: 'cust-mobile' });
    // Overwriting would silently hand the account to whoever signed in last, and
    // the previous owner's credential would stop working with no trace of why.
    expect(r).not.toHaveProperty('setFirebaseUid');
    expect(r.action).not.toBe('link');
  });

  it('refuses to move an email-matched row onto a different UID', () => {
    const r = resolve({
      identity: identity({
        signInProvider: 'google.com',
        phoneNumber: null,
        email: 'arjun@example.com',
        emailVerified: true,
      }),
      byEmail: customer({ id: 'cust-email', firebaseUid: 'fb-uid-other' }),
    });
    expect(r).toEqual({ action: 'reject', reason: 'uid_conflict', customerId: 'cust-email' });
    expect(r).not.toHaveProperty('setFirebaseUid');
  });

  it('links idempotently when the row already carries THIS uid', () => {
    // A retried or concurrent sign-in must not turn into a conflict. Same uid on
    // the row is the write we were about to make, already made.
    expect(resolve({ byMobile: customer({ id: 'cust-mobile', firebaseUid: 'fb-uid-token' }) })).toEqual({
      action: 'link',
      customerId: 'cust-mobile',
      matchedOn: 'mobile',
      setFirebaseUid: 'fb-uid-token',
    });
  });

  it('links idempotently on the email branch too', () => {
    expect(
      resolve({
        identity: identity({
          signInProvider: 'google.com',
          phoneNumber: null,
          email: 'arjun@example.com',
          emailVerified: true,
        }),
        byEmail: customer({ id: 'cust-email', firebaseUid: 'fb-uid-token' }),
      }),
    ).toEqual({
      action: 'link',
      customerId: 'cust-email',
      matchedOn: 'email',
      setFirebaseUid: 'fb-uid-token',
    });
  });

  it('treats the uid comparison as exact — case and whitespace are not the same uid', () => {
    for (const rowUid of ['FB-UID-TOKEN', ' fb-uid-token', 'fb-uid-token ']) {
      expect(resolve({ byMobile: customer({ id: 'cust-mobile', firebaseUid: rowUid }) })).toMatchObject({
        action: 'reject',
        reason: 'uid_conflict',
      });
    }
  });

  it('reports blocked before uid_conflict when a row is both', () => {
    // Ordering matters for the audit trail: "this account is blocked" is the fact
    // support needs, and it is the stronger of the two refusals.
    expect(
      resolve({ byMobile: customer({ id: 'cust-mobile', firebaseUid: 'fb-uid-other', blockedAt: BLOCKED }) }),
    ).toEqual({ action: 'reject', reason: 'account_blocked', customerId: 'cust-mobile' });
  });
});

describe('resolveFirebaseIdentity — a phone sign-in we cannot store', () => {
  it('refuses an international phone-provider token', () => {
    expect(
      resolve({ identity: identity({ signInProvider: 'phone', phoneNumber: '+14155552671' }) }),
    ).toEqual({ action: 'reject', reason: 'unusable_phone' });
  });

  it('refuses a phone-provider token with no number at all', () => {
    expect(resolve({ identity: identity({ signInProvider: 'phone', phoneNumber: null }) })).toEqual({
      action: 'reject',
      reason: 'unusable_phone',
    });
  });

  it('refuses BEFORE any lookup is consulted — even a matching UID does not rescue it', () => {
    // Creating (or signing into) a phone account without the number produces a
    // customer nobody can deliver to and who can never authenticate again, since
    // the number is the only credential they have. So the guard runs first.
    expect(
      resolve({
        identity: identity({ signInProvider: 'phone', phoneNumber: '+14155552671', email: 'a@b.com', emailVerified: true }),
        byFirebaseUid: customer({ id: 'cust-uid', firebaseUid: 'fb-uid-token' }),
        byMobile: customer({ id: 'cust-mobile' }),
        byEmail: customer({ id: 'cust-email' }),
      }),
    ).toEqual({ action: 'reject', reason: 'unusable_phone' });
  });

  it('names no customer, because none was consulted', () => {
    expect(
      resolve({
        identity: identity({ signInProvider: 'phone', phoneNumber: 'nonsense' }),
        byFirebaseUid: customer({ id: 'cust-uid', firebaseUid: 'fb-uid-token' }),
      }),
    ).not.toHaveProperty('customerId');
  });

  it('refuses every unusable shape a phone token could carry', () => {
    for (const phoneNumber of ['+14155552671', '+442071838750', '5820012345', 'nope', '', null]) {
      expect(resolve({ identity: identity({ signInProvider: 'phone', phoneNumber }) })).toEqual({
        action: 'reject',
        reason: 'unusable_phone',
      });
    }
  });

  /**
   * REGRESSION — the downstream consequence of the normalisation bug documented
   * above, and the reason it was worth more than a data-quality ticket.
   *
   * `+6591234567` is a Singapore mobile. It used to normalise to `6591234567`,
   * a well-formed Indian ten-digit number, so it was neither refused as unusable
   * nor stored as itself. Somebody holds `6591234567` — it is a perfectly ordinary
   * Indian number — and a Firebase token proving control of the SINGAPORE line
   * linked straight onto that Indian customer's account. Firebase proves *a*
   * number; it does not prove *this* number.
   */
  it('refuses a foreign phone token rather than mistaking it for Indian', () => {
    expect(resolve({ identity: identity({ signInProvider: 'phone', phoneNumber: '+6591234567' }) })).toEqual({
      action: 'reject',
      reason: 'unusable_phone',
    });
  });

  it('refuses it even when an Indian customer holds the digits it collapses to', () => {
    // The takeover itself, pinned. Before the fix this returned
    // `{ action: 'link', customerId: 'unrelated-indian-customer' }` — a Firebase
    // token proving control of a Singapore line, attached to a stranger's
    // account. It must reject regardless of what the lookup found.
    expect(
      resolve({
        identity: identity({ signInProvider: 'phone', phoneNumber: '+6591234567' }),
        byMobile: customer({ id: 'unrelated-indian-customer', mobile: '6591234567' }),
      }),
    ).toEqual({ action: 'reject', reason: 'unusable_phone' });
  });
});

describe('resolveFirebaseIdentity — providers that carry no phone', () => {
  it('does not refuse a Google sign-in for having no phone number', () => {
    // The guard is scoped to `phone` on purpose. Google sign-in legitimately has
    // no phone claim; refusing it would break the entire web sign-in flow.
    expect(
      resolve({
        identity: identity({
          signInProvider: 'google.com',
          phoneNumber: null,
          email: 'arjun@example.com',
          emailVerified: true,
        }),
      }),
    ).toEqual({ action: 'create', mobile: null, email: 'arjun@example.com', emailVerified: true });
  });

  it('resolves a Google sign-in on its verified email', () => {
    expect(
      resolve({
        identity: identity({
          signInProvider: 'google.com',
          phoneNumber: null,
          email: 'arjun@example.com',
          emailVerified: true,
        }),
        byEmail: customer({ id: 'cust-email' }),
      }),
    ).toMatchObject({ action: 'link', matchedOn: 'email' });
  });

  it('lets a non-phone provider through with an unusable number, minus the number', () => {
    // A Google account whose profile carries a US phone still signs in; we simply
    // decline to store the number. That is the product limitation, stated once.
    expect(
      resolve({
        identity: identity({
          signInProvider: 'google.com',
          phoneNumber: '+14155552671',
          email: 'arjun@example.com',
          emailVerified: true,
        }),
      }),
    ).toEqual({ action: 'create', mobile: null, email: 'arjun@example.com', emailVerified: true });
  });

  it('applies the same leniency to every non-phone provider', () => {
    for (const signInProvider of ['google.com', 'password', 'apple.com', 'custom', '']) {
      expect(
        resolve({ identity: identity({ signInProvider, phoneNumber: null, email: 'a@b.com' }) }),
      ).toMatchObject({ action: 'create' });
    }
  });
});

describe('resolveFirebaseIdentity — an account nobody could sign into again', () => {
  it('refuses to create a customer with neither a phone nor an email', () => {
    expect(
      resolve({ identity: identity({ signInProvider: 'google.com', phoneNumber: null, email: null }) }),
    ).toEqual({ action: 'reject', reason: 'no_identifier' });
  });

  it('treats an empty-string email as no email', () => {
    // An empty address is not an identifier; creating on it would produce a row
    // matching nothing and reachable by nobody.
    expect(
      resolve({ identity: identity({ signInProvider: 'google.com', phoneNumber: null, email: '' }) }),
    ).toEqual({ action: 'reject', reason: 'no_identifier' });
  });

  it('refuses even when an unverified email row was found, since that email is not usable', () => {
    expect(
      resolve({
        identity: identity({ signInProvider: 'google.com', phoneNumber: null, email: null }),
        byEmail: customer({ id: 'cust-email' }),
      }),
    ).toEqual({ action: 'reject', reason: 'no_identifier' });
  });

  it('does not apply once either identifier is present', () => {
    expect(resolve({ identity: identity({ signInProvider: 'google.com', phoneNumber: null, email: 'a@b.com' }) }))
      .toMatchObject({ action: 'create' });
    expect(resolve({ identity: identity({ signInProvider: 'google.com', email: null }) })).toMatchObject({
      action: 'create',
    });
  });
});

/* ================================================================ totality */

describe('resolveFirebaseIdentity — totality over the whole input space', () => {
  const ACTIONS = ['sign_in', 'link', 'create', 'reject'] as const;
  const REASONS = ['no_identifier', 'unusable_phone', 'account_blocked', 'uid_conflict'] as const;
  const BOOLS = [false, true] as const;
  const PHONES = ['+919820012345', null, '+14155552671'] as const;
  const PROVIDERS = ['phone', 'google.com', 'password'] as const;
  const UIDS = [null, 'fb-uid-token', 'fb-uid-other'] as const;

  it('always returns a valid Resolution — never undefined, never a throw', () => {
    let cases = 0;
    for (const hasUid of BOOLS) {
      for (const hasMobile of BOOLS) {
        for (const hasEmail of BOOLS) {
          for (const emailVerified of BOOLS) {
            for (const blocked of BOOLS) {
              for (const phoneNumber of PHONES) {
                for (const signInProvider of PROVIDERS) {
                  for (const rowUid of UIDS) {
                    const blockedAt = blocked ? BLOCKED : null;
                    const input: ResolutionInput = {
                      identity: identity({
                        phoneNumber,
                        signInProvider,
                        email: 'arjun@example.com',
                        emailVerified,
                      }),
                      byFirebaseUid: hasUid
                        ? customer({ id: 'cust-uid', firebaseUid: 'fb-uid-token', blockedAt })
                        : null,
                      byMobile: hasMobile ? customer({ id: 'cust-mobile', firebaseUid: rowUid, blockedAt }) : null,
                      byEmail: hasEmail ? customer({ id: 'cust-email', firebaseUid: rowUid, blockedAt }) : null,
                    };
                    const label = [
                      `uid=${String(hasUid)}`,
                      `mobile=${String(hasMobile)}`,
                      `email=${String(hasEmail)}`,
                      `verified=${String(emailVerified)}`,
                      `blocked=${String(blocked)}`,
                      `phone=${String(phoneNumber)}`,
                      `provider=${signInProvider}`,
                      `rowUid=${String(rowUid)}`,
                    ].join(' ');

                    const r = resolveFirebaseIdentity(input);
                    cases += 1;

                    expect(r, label).toBeDefined();
                    expect(ACTIONS, label).toContain(r.action);
                    if (r.action === 'reject') expect(REASONS, label).toContain(r.reason);
                    if (r.action === 'link') {
                      expect(r.setFirebaseUid, label).toBe('fb-uid-token');
                      expect(['mobile', 'email'], label).toContain(r.matchedOn);
                    }
                    if (r.action === 'sign_in') expect(r.matchedOn, label).toBe('firebase_uid');
                    if (r.action === 'create' && r.mobile !== null) {
                      // Whatever else happens, a number reaching the INSERT must
                      // satisfy the DOMAIN, or the sign-in 500s at the database.
                      expect(r.mobile, label).toMatch(/^[6-9][0-9]{9}$/);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(2 * 2 * 2 * 2 * 2 * 3 * 3 * 3);
  });

  it('never signs into or links a BLOCKED customer — sweep', () => {
    // The invariant that survives any future refactor of the branch order: if the
    // result names a customer as signed-in or linked, that customer is not blocked.
    for (const hasUid of BOOLS) {
      for (const hasMobile of BOOLS) {
        for (const hasEmail of BOOLS) {
          for (const emailVerified of BOOLS) {
            for (const blocked of BOOLS) {
              const blockedAt = blocked ? BLOCKED : null;
              const rows: ExistingCustomer[] = [];
              const byFirebaseUid = hasUid
                ? customer({ id: 'cust-uid', firebaseUid: 'fb-uid-token', blockedAt })
                : null;
              const byMobile = hasMobile ? customer({ id: 'cust-mobile', blockedAt }) : null;
              const byEmail = hasEmail ? customer({ id: 'cust-email', blockedAt }) : null;
              for (const row of [byFirebaseUid, byMobile, byEmail]) if (row) rows.push(row);

              const r = resolveFirebaseIdentity({
                identity: identity({ email: 'arjun@example.com', emailVerified }),
                byFirebaseUid,
                byMobile,
                byEmail,
              });

              if (r.action === 'sign_in' || r.action === 'link') {
                const named = rows.find((row) => row.id === r.customerId);
                expect(named?.blockedAt ?? null).toBeNull();
              }
            }
          }
        }
      }
    }
  });

  it('never links on an unverified email — sweep', () => {
    // The takeover invariant, stated over the whole space rather than one case.
    for (const hasMobile of BOOLS) {
      for (const hasEmail of BOOLS) {
        for (const rowUid of UIDS) {
          const r = resolveFirebaseIdentity({
            identity: identity({
              signInProvider: 'google.com',
              phoneNumber: null,
              email: 'founder@achichiz.in',
              emailVerified: false,
            }),
            byFirebaseUid: null,
            byMobile: hasMobile ? customer({ id: 'cust-mobile', firebaseUid: rowUid }) : null,
            byEmail: hasEmail ? customer({ id: 'cust-email', firebaseUid: rowUid }) : null,
          });
          if (r.action === 'link') expect(r.matchedOn).not.toBe('email');
        }
      }
    }
  });
});

/* ============================================================= event mapping */

describe('outcomeOf — the customer_auth_events vocabulary', () => {
  it('maps every action onto its outcome', () => {
    expect(outcomeOf({ action: 'sign_in', customerId: 'c', matchedOn: 'firebase_uid' })).toBe('signed_in');
    expect(
      outcomeOf({ action: 'link', customerId: 'c', matchedOn: 'mobile', setFirebaseUid: 'u' }),
    ).toBe('linked');
    expect(outcomeOf({ action: 'create', mobile: '9820012345', email: null, emailVerified: false })).toBe(
      'created',
    );
    expect(outcomeOf({ action: 'reject', reason: 'account_blocked' })).toBe('rejected');
  });

  it('maps every reject reason to rejected, not just the first', () => {
    // A refusal that logged as `created` would make the block look like a signup
    // in the audit table — the one place somebody looks after an incident.
    for (const reason of ['no_identifier', 'unusable_phone', 'account_blocked', 'uid_conflict'] as const) {
      expect(outcomeOf({ action: 'reject', reason })).toBe('rejected');
    }
  });

  it('maps both link flavours to linked', () => {
    for (const matchedOn of ['mobile', 'email'] as const) {
      expect(outcomeOf({ action: 'link', customerId: 'c', matchedOn, setFirebaseUid: 'u' })).toBe('linked');
    }
  });
});

describe('providerOf — the customer_auth_events provider column', () => {
  it('recognises phone sign-in', () => {
    expect(providerOf('phone')).toBe('firebase_phone');
  });

  it('files everything else as google', () => {
    for (const p of ['google.com', 'password', 'apple.com', 'anonymous', '', 'PHONE', 'phone.com']) {
      expect(providerOf(p)).toBe('firebase_google');
    }
  });

  it('is exact about the phone string, so a near-miss is never mislabelled', () => {
    // `PHONE` or `phone ` would otherwise be recorded as a phone sign-in while the
    // resolver treated it as a non-phone provider — two halves disagreeing about
    // what happened, in the table meant to settle exactly that.
    expect(providerOf('PHONE')).toBe('firebase_google');
    expect(providerOf(' phone')).toBe('firebase_google');
  });
});
