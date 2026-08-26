/**
 * Firebase ID token → verified claims. The only place in the codebase that talks
 * to `firebase-admin/auth`.
 *
 * Three rules hold here.
 *
 * 1. **`checkRevoked` is on.** `verifyIdToken(token, true)` costs one lookup
 *    against Firebase per verification, and it is what makes revocation real: a
 *    "sign out everywhere", a disabled account or a deleted user stops working
 *    within seconds instead of staying live until the token expires on its own.
 *    A revocation that takes an hour to bite is not a revocation.
 *
 * 2. **Every 401 says exactly the same thing.** This sits on an unauthenticated
 *    endpoint, so a body that distinguishes "expired" from "malformed" from
 *    "revoked" is a free oracle for anyone feeding it captured tokens. The
 *    distinguishing detail lives in the stable `code` and in the server log —
 *    same trade `auth.service.ts` makes with `INVALID_CREDENTIALS`.
 *
 * 3. **An unrecognised failure is NOT a 401.** If Google is down, or the
 *    service-account key was revoked, or the clock is wrong, the caller's
 *    credentials are fine and the fault is ours. Those rethrow and become a 500,
 *    because telling a customer "your credentials are wrong" during our outage
 *    sends them to reset a password that was never the problem.
 */

import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirebaseApp } from '../../config/firebase.js';
import { logger } from '../../config/logger.js';
import { UnauthenticatedError } from '../../lib/errors.js';

/* ----------------------------------------------------------------- shape */

export type VerifiedFirebaseToken = {
  uid: string;
  /** E.164 from `phone_number`. Null for a provider that carries no phone. */
  phoneNumber: string | null;
  email: string | null;
  emailVerified: boolean;
  /** `phone`, `google.com`, `password`, … — from `firebase.sign_in_provider`. */
  signInProvider: string;
  issuedAt: Date;
  expiresAt: Date;
};

/** Stable machine-readable codes. Frontends switch on these; changing one is breaking. */
export type FirebaseRejectionCode =
  | 'firebase_token_expired'
  | 'firebase_token_revoked'
  | 'firebase_token_invalid';

/** The one body every rejected token gets, whatever actually went wrong. */
export const FIREBASE_TOKEN_REJECTED = 'That sign-in could not be verified. Please sign in again.';

/* ------------------------------------------------------------- the mapping */

/**
 * Firebase error code → our rejection code. Anything absent is deliberately
 * absent: it is a fault on our side of the wire, not a bad token.
 */
const REJECTIONS: Record<string, FirebaseRejectionCode> = {
  'auth/id-token-expired': 'firebase_token_expired',
  'auth/session-cookie-expired': 'firebase_token_expired',

  'auth/id-token-revoked': 'firebase_token_revoked',
  'auth/session-cookie-revoked': 'firebase_token_revoked',
  'auth/user-disabled': 'firebase_token_revoked',
  // Only reachable because `checkRevoked` loads the user record: the Firebase
  // account behind a still-valid signature is gone. Same meaning as revoked.
  'auth/user-not-found': 'firebase_token_revoked',

  'auth/argument-error': 'firebase_token_invalid',
  'auth/invalid-id-token': 'firebase_token_invalid',
  'auth/invalid-argument': 'firebase_token_invalid',
};

/** `FirebaseAuthError` carries `code`; some wrappers only carry `errorInfo.code`. */
function firebaseErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;

  if ('code' in err && typeof err.code === 'string') return err.code;

  if ('errorInfo' in err) {
    const info = err.errorInfo;
    if (typeof info === 'object' && info !== null && 'code' in info && typeof info.code === 'string') {
      return info.code;
    }
  }
  return undefined;
}

/**
 * Builds the 401. `UnauthenticatedError` pins `code` to `'unauthenticated'` and,
 * unlike `UnprocessableError`, takes no override parameter — so the code is set
 * per instance with the same `defineProperty` that `UnprocessableError` uses on
 * the very same field. `lib/errors.ts` is owned elsewhere and is not touched.
 */
function rejected(code: FirebaseRejectionCode): UnauthenticatedError {
  const error = new UnauthenticatedError(FIREBASE_TOKEN_REJECTED);
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

/**
 * Pure. Returns the 401 to throw, or `null` meaning "not a credential problem —
 * rethrow it". Exhaustively tested in `firebase-verify.test.ts`.
 *
 * Note what is NOT here: message sniffing. Firebase raises `auth/argument-error`
 * for a token that is malformed, wrongly signed, from another project or simply
 * not a JWT, so the code alone is enough — and guessing from prose would happily
 * turn a future SDK error into a spurious 401.
 */
export function mapFirebaseError(err: unknown): UnauthenticatedError | null {
  const code = firebaseErrorCode(err);
  const rejection = code === undefined ? undefined : REJECTIONS[code];
  return rejection ? rejected(rejection) : null;
}

/* ------------------------------------------------------------- projection */

/** Pure: the claims we keep, in our own shape. `iat`/`exp` are seconds, not ms. */
export function toVerifiedToken(decoded: DecodedIdToken): VerifiedFirebaseToken {
  return {
    uid: decoded.uid,
    phoneNumber: decoded.phone_number ?? null,
    email: decoded.email ?? null,
    // Absent means unverified. Never coerce a missing claim into `true`.
    emailVerified: decoded.email_verified === true,
    signInProvider: decoded.firebase.sign_in_provider,
    issuedAt: new Date(decoded.iat * 1000),
    expiresAt: new Date(decoded.exp * 1000),
  };
}

/* ---------------------------------------------------------- the verifier */

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseToken> {
  // A blank token cannot be anything but invalid, and answering it here avoids
  // both a pointless round trip and initialising Firebase to reject nothing.
  if (idToken.trim() === '') throw rejected('firebase_token_invalid');

  const auth = getAuth(getFirebaseApp());

  let decoded: DecodedIdToken;
  try {
    // `true` = checkRevoked. See rule 1 at the top of this file.
    decoded = await auth.verifyIdToken(idToken, true);
  } catch (err) {
    const rejection = mapFirebaseError(err);
    if (rejection) {
      // The client is told nothing beyond FIREBASE_TOKEN_REJECTED; the reason
      // lives here, where support can read it and an attacker cannot.
      logger.warn({ err, code: rejection.code }, 'auth.firebase_token_rejected');
      throw rejection;
    }

    logger.error(
      { err, firebaseCode: firebaseErrorCode(err) },
      'auth.firebase_verify_failed — an unrecognised Firebase failure. This is OUR fault, not the ' +
        "caller's, and is deliberately not reported as a 401.",
    );
    throw err;
  }

  return toVerifiedToken(decoded);
}
