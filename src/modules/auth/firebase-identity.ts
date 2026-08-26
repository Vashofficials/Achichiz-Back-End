/**
 * Firebase identity → Achichiz customer. Pure decisions, no I/O, no Firebase SDK.
 *
 * Firebase verifies the OTP; this file decides what that verification MEANS for
 * our own `customers` table. Both halves are separable and only one of them is
 * subtle, so the subtle one lives here where it can be tested exhaustively
 * without a network or a database.
 *
 * ## The resolution order
 *
 * ```
 *   1. firebase_uid matches a live customer   → SIGN IN
 *   2. mobile matches a live customer         → LINK, then sign in
 *   3. verified email matches a live customer → LINK, then sign in
 *   4. nothing matches                        → CREATE
 * ```
 *
 * Step 2 is safe for a reason worth stating: Firebase phone sign-in PROVES the
 * bearer controls that number — they received an SMS at it. Matching an existing
 * customer on a proven number and attaching the new credential is the correct
 * behaviour, and refusing would strand every pre-Firebase customer behind an
 * account they can no longer reach.
 *
 * ## Step 3 is where an account takeover would live
 *
 * Matching on email is only safe when the token says `email_verified: true`.
 * Firebase will happily mint a token carrying an arbitrary UNVERIFIED email —
 * a Google sign-in with a self-asserted address, or an email/password account
 * nobody confirmed. Linking on that would let anyone who types
 * `founder@achichiz.in` into a signup form inherit that customer's account,
 * their addresses and their order history.
 *
 * So an unverified email never links. It does not error either — it simply
 * stops being a matching signal, and the flow falls through to CREATE. That is
 * the conservative direction: a duplicate account is an annoyance somebody can
 * merge, an account takeover is not.
 *
 * ## Blocked accounts
 *
 * A blocked customer is refused at every branch that MATCHES one — uid, mobile
 * and verified email. CREATE is not such a branch: reaching it means nothing
 * matched, so there is no row to be blocked.
 *
 * That leaves one case which looks like a hole and is not. An UNVERIFIED email
 * matching a blocked row still resolves to CREATE, because step 3 never
 * consults `byEmail` without verification. Rejecting there would be worse than
 * the duplicate account it avoids: anyone can mint a Firebase token carrying
 * any self-asserted address, so a refusal keyed on it would answer "is this
 * address blocked?" for any address an attacker cares to type. The new account
 * carries none of the blocked one's orders, addresses or history — it is a
 * stranger's empty account that happens to share a string nobody verified.
 */

/* ------------------------------------------------------------ mobile shape */

/**
 * `customers.mobile` is `DOMAIN mobile_in AS TEXT CHECK (VALUE ~ '^[6-9][0-9]{9}$')`
 * — ten digits, no country code, first digit 6-9. Firebase returns E.164
 * (`+919820012345`). Every number crossing that boundary goes through here.
 */
const INDIAN_MOBILE = /^[6-9][0-9]{9}$/;

export type MobileNormalisation =
  | { ok: true; mobile: string }
  | { ok: false; reason: 'missing' | 'not_indian' | 'malformed' };

/**
 * E.164 → the ten digits the database domain accepts.
 *
 * Rejects rather than truncates. A non-Indian number trimmed to its last ten
 * digits is not that customer's number — it is a different, possibly real,
 * Indian number, and it would end up on a delivery address. Refusing an
 * international sign-in is a product limitation; silently rewriting somebody's
 * phone number is a data-corruption bug that surfaces at the doorstep.
 */
export function normaliseIndianMobile(raw: string | null | undefined): MobileNormalisation {
  if (raw === null || raw === undefined || raw.trim() === '') return { ok: false, reason: 'missing' };

  // Strip everything a phone number is written with but is not part of it.
  const cleaned = raw.replace(/[\s()\-.]/g, '');

  if (!/^\+?\d+$/.test(cleaned)) return { ok: false, reason: 'malformed' };

  const hadPlus = cleaned.startsWith('+');
  const digits = cleaned.replace(/^\+/, '');

  let local: string;

  if (hadPlus) {
    // A leading `+` means E.164, and E.164 ALWAYS carries a country code. The
    // only Indian shape is therefore `+91` followed by ten digits — twelve in
    // all — and a `+`-prefixed number of any other length is somebody else's.
    //
    // This branch must come first. Testing `digits.length === 10` before looking
    // at the `+` is the bug that makes `+6591234567` — a Singapore mobile, +65
    // then subscriber 91234567 — arrive as the perfectly well-formed Indian
    // number 6591234567. Somebody holds that number, and a Firebase token
    // proving control of the Singapore line would then link straight onto their
    // account. Firebase proves *a* number; it does not prove *this* number.
    if (digits.length === 12 && digits.startsWith('91')) local = digits.slice(2);
    else return { ok: false, reason: 'not_indian' };
  } else if (digits.length === 10) {
    local = digits;
  } else if (digits.length === 12 && digits.startsWith('91')) {
    // No `+`, so nothing marks a country code; for an India-only service the
    // only sensible reading of a bare 91-prefixed twelve is the local number.
    local = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    // The trunk-prefix form some checkout forms still emit.
    local = digits.slice(1);
  } else {
    return { ok: false, reason: 'malformed' };
  }

  if (!INDIAN_MOBILE.test(local)) {
    // Always `malformed`, never `not_indian`. Every branch that reaches here has
    // already established the input IS Indian-shaped — bare ten, `+91`/`91`
    // twelve, or `0`-trunk eleven. What failed is the local part: it does not
    // start 6-9, so it is a landline or a typo, not another country's number.
    // `not_indian` is reserved for the one thing it should mean — an E.164
    // number belonging to a different country code.
    return { ok: false, reason: 'malformed' };
  }

  return { ok: true, mobile: local };
}

/** The stored form back to E.164, for anything that talks to Firebase or a gateway. */
export const toE164 = (mobile: string): string => `+91${mobile}`;

/* -------------------------------------------------------- the decision table */

/** The claims we care about, already extracted from a VERIFIED Firebase token. */
export type FirebaseIdentity = {
  uid: string;
  /** E.164, or null for a provider that carries no phone (Google sign-in). */
  phoneNumber: string | null;
  email: string | null;
  /** Firebase's own assertion. Only `true` may be used to match an account. */
  emailVerified: boolean;
  /** `phone`, `google.com`, `password`, … — from `firebase.sign_in_provider`. */
  signInProvider: string;
};

/** What a lookup found, or null. Supplied by the service; this file does no I/O. */
export type ExistingCustomer = {
  id: string;
  firebaseUid: string | null;
  mobile: string | null;
  email: string | null;
  blockedAt: Date | null;
};

export type ResolutionInput = {
  identity: FirebaseIdentity;
  /** Live customer whose `firebase_uid` equals `identity.uid`. */
  byFirebaseUid: ExistingCustomer | null;
  /** Live customer whose `mobile` equals the normalised phone. */
  byMobile: ExistingCustomer | null;
  /** Live customer whose `email` equals `identity.email`. */
  byEmail: ExistingCustomer | null;
};

export type Resolution =
  | { action: 'sign_in'; customerId: string; matchedOn: 'firebase_uid' }
  | { action: 'link'; customerId: string; matchedOn: 'mobile' | 'email'; setFirebaseUid: string }
  | { action: 'create'; mobile: string | null; email: string | null; emailVerified: boolean }
  | { action: 'reject'; reason: RejectReason; customerId?: string };

export type RejectReason =
  | 'no_identifier'
  | 'unusable_phone'
  | 'account_blocked'
  | 'uid_conflict';

/**
 * The whole decision, in one total function.
 *
 * Total on purpose: every input shape produces a Resolution, and `reject` is a
 * value rather than a thrown error. A decision this consequential should be
 * enumerable in a test table, and it is — see `firebase-identity.test.ts`.
 */
export function resolveFirebaseIdentity(input: ResolutionInput): Resolution {
  const { identity, byFirebaseUid, byMobile, byEmail } = input;

  const phone = normaliseIndianMobile(identity.phoneNumber);
  const mobile = phone.ok ? phone.mobile : null;

  // A phone-provider token whose number we cannot store is refused outright.
  // Creating the account without the number would produce a customer who can
  // never be delivered to and can never sign in again, since the number is the
  // only thing they authenticate with.
  if (identity.signInProvider === 'phone' && !phone.ok) {
    return { action: 'reject', reason: 'unusable_phone' };
  }

  // 1 — the UID we have seen before.
  if (byFirebaseUid) {
    if (byFirebaseUid.blockedAt) {
      return { action: 'reject', reason: 'account_blocked', customerId: byFirebaseUid.id };
    }
    return { action: 'sign_in', customerId: byFirebaseUid.id, matchedOn: 'firebase_uid' };
  }

  // 2 — a proven phone number matching an existing account.
  if (mobile && byMobile) {
    if (byMobile.blockedAt) {
      return { action: 'reject', reason: 'account_blocked', customerId: byMobile.id };
    }
    // That row already carries a DIFFERENT Firebase UID. Two Firebase accounts
    // claim one phone number, which Firebase itself should prevent; overwriting
    // would silently hand the account to whichever signed in last.
    if (byMobile.firebaseUid && byMobile.firebaseUid !== identity.uid) {
      return { action: 'reject', reason: 'uid_conflict', customerId: byMobile.id };
    }
    return {
      action: 'link',
      customerId: byMobile.id,
      matchedOn: 'mobile',
      setFirebaseUid: identity.uid,
    };
  }

  // 3 — a VERIFIED email matching an existing account. Unverified never matches;
  //     see the header. It falls through to CREATE rather than erroring.
  if (identity.emailVerified && identity.email && byEmail) {
    if (byEmail.blockedAt) {
      return { action: 'reject', reason: 'account_blocked', customerId: byEmail.id };
    }
    if (byEmail.firebaseUid && byEmail.firebaseUid !== identity.uid) {
      return { action: 'reject', reason: 'uid_conflict', customerId: byEmail.id };
    }
    return {
      action: 'link',
      customerId: byEmail.id,
      matchedOn: 'email',
      setFirebaseUid: identity.uid,
    };
  }

  // 4 — nothing matched. A new customer needs at least one identifier: an
  //     account with neither a phone nor an email cannot be signed into again.
  if (!mobile && !identity.email) {
    return { action: 'reject', reason: 'no_identifier' };
  }

  return {
    action: 'create',
    mobile,
    email: identity.email,
    emailVerified: identity.emailVerified,
  };
}

/** Maps a resolution onto the `customer_auth_events.outcome` vocabulary. */
export const outcomeOf = (r: Resolution): 'signed_in' | 'linked' | 'created' | 'rejected' =>
  r.action === 'sign_in' ? 'signed_in' : r.action === 'link' ? 'linked' : r.action === 'create' ? 'created' : 'rejected';

/** Maps `firebase.sign_in_provider` onto `customer_auth_events.provider`. */
export function providerOf(signInProvider: string): 'firebase_phone' | 'firebase_google' {
  return signInProvider === 'phone' ? 'firebase_phone' : 'firebase_google';
}
