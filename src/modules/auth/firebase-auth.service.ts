/**
 * Firebase sign-in — the bridge between a verified Google token and our own session.
 *
 * The split of responsibility is the whole design:
 *
 * ```
 *   Firebase (Google)          this file                 our database
 *   ─────────────────          ─────────                 ────────────
 *   sends the SMS
 *   verifies the code
 *   signs an ID token    →     verify the signature  →   find / link / create
 *                              decide what it means      issue OUR session
 *                                                        record what happened
 * ```
 *
 * We never see the OTP. That is the point of moving off MSG91: the code, its
 * attempt counter and its expiry are Google's problem, and the whole class of
 * bugs around hashing and rate-limiting our own codes disappears with them.
 *
 * What does NOT move to Google is the session. A Firebase ID token is not an
 * Achichiz access token, and the frontend never sends one to any other endpoint.
 * This endpoint exchanges it, exactly once, for the same rotating opaque refresh
 * cookie and short-lived access token every other login path issues — so
 * `/v1/auth/refresh`, `/v1/auth/logout` and `logout-all` keep working unchanged,
 * and a Firebase outage cannot log out customers who are already signed in.
 *
 * The decision logic lives next door in `firebase-identity.ts`, pure and
 * exhaustively tested. This file is the I/O around it.
 */

import type { Request } from 'express';
import { logger } from '../../config/logger.js';
import { ForbiddenError, UnauthenticatedError, UnprocessableError } from '../../lib/errors.js';
import * as repo from './auth.repository.js';
import { verifyFirebaseIdToken } from './firebase-verify.js';
import {
  normaliseIndianMobile,
  outcomeOf,
  providerOf,
  resolveFirebaseIdentity,
  type ExistingCustomer,
  type FirebaseIdentity,
  type RejectReason,
  type Resolution,
} from './firebase-identity.js';

/** Messages a rejected sign-in may show. Each says what to DO about it. */
const REJECTION: Record<RejectReason, { message: string; code: string }> = {
  no_identifier: {
    message:
      'That sign-in carried neither a phone number nor an email address, so there is nothing to ' +
      'create an account against. Sign in with your mobile number instead.',
    code: 'firebase_no_identifier',
  },
  unusable_phone: {
    message:
      'We can only deliver within India, so accounts are keyed to a ten-digit Indian mobile number and ' +
      'that number is not one. Sign in with an Indian mobile number, or contact support if you believe ' +
      'this is wrong.',
    code: 'firebase_unusable_phone',
  },
  account_blocked: {
    message: 'This account has been suspended. Contact support@achichiz.in.',
    code: 'account_blocked',
  },
  uid_conflict: {
    message:
      'That mobile number is already attached to a different sign-in. Contact support@achichiz.in — we ' +
      'have not changed anything on the account.',
    code: 'firebase_uid_conflict',
  },
};

export type FirebaseSignInResult = {
  customer: repo.CustomerRow;
  /** What the resolution did, so the caller can report it and the route can log it. */
  outcome: 'signed_in' | 'linked' | 'created';
  /** True the first time this customer ever authenticated. Lets the client route to onboarding. */
  isNewAccount: boolean;
};

/**
 * Verify a Firebase ID token and resolve it to one of our customers.
 *
 * Returns the customer row; issuing the session is the caller's job, because
 * `issueSession` and the cart merge already live in `auth.service.ts` and there
 * is no reason for two copies of them.
 */
export async function resolveFirebaseSignIn(
  idToken: string,
  context: { ip: string | null; userAgent: string | null },
): Promise<FirebaseSignInResult> {
  // Throws 401 with an identical message for expired / revoked / malformed —
  // see firebase-verify.ts. The distinguishing detail is in the stable code.
  const token = await verifyFirebaseIdToken(idToken);

  const identity: FirebaseIdentity = {
    uid: token.uid,
    phoneNumber: token.phoneNumber,
    email: token.email,
    emailVerified: token.emailVerified,
    signInProvider: token.signInProvider,
  };

  const lookups = await loadCandidates(identity);
  const resolution = resolveFirebaseIdentity({ identity, ...lookups });

  const audit = {
    provider: providerOf(identity.signInProvider),
    outcome: outcomeOf(resolution),
    firebaseUid: identity.uid,
    mobile: lookups.normalisedMobile,
    email: identity.email,
    ip: context.ip,
    userAgent: context.userAgent,
  } as const;

  if (resolution.action === 'reject') {
    const { message, code } = REJECTION[resolution.reason];

    // Written OUTSIDE any transaction and before the throw. A refusal is the row
    // most worth having, and rolling it back with the failed sign-in would erase
    // exactly the evidence an investigation needs.
    await repo.insertAuthEvent({
      ...audit,
      outcome: 'rejected',
      reason: resolution.reason,
      ...(resolution.customerId ? { customerId: resolution.customerId } : {}),
    });

    logger.warn(
      { reason: resolution.reason, uid: identity.uid, customerId: resolution.customerId },
      'auth.firebase_rejected',
    );

    // 403, and it says so plainly — which deliberately DIFFERS from
    // `auth.service.ts:assertUsable`, where a blocked account fails like a wrong
    // password so the response cannot confirm the account exists.
    //
    // That reasoning does not carry here. To reach this branch the caller has
    // already presented a Firebase token proving they control the phone number,
    // so "an account exists for this number" is something they demonstrated
    // rather than something we disclosed. Failing them with a vague credential
    // error would only send the legitimate owner of a suspended account round
    // the login loop forever.
    //
    // The status is the distinguishing signal: 403 for blocked, 422 for a valid
    // token we cannot act on. `UnauthenticatedError` carries a fixed
    // `unauthenticated` code and cannot express these.
    throw resolution.reason === 'account_blocked'
      ? new ForbiddenError(message, { context: { code } })
      : new UnprocessableError(message, code);
  }

  const customer = await applyResolution(resolution, identity);

  await repo.insertAuthEvent({ ...audit, customerId: customer.id, reason: null });

  logger.info(
    { customerId: customer.id, outcome: audit.outcome, provider: audit.provider },
    'auth.firebase_signed_in',
  );

  return {
    customer,
    outcome: audit.outcome === 'rejected' ? 'signed_in' : audit.outcome,
    isNewAccount: resolution.action === 'create',
  };
}

/* --------------------------------------------------------------- lookups */

/**
 * The three candidate rows the decision needs, fetched together.
 *
 * All three are read even when the first would decide it. One extra indexed
 * lookup is cheaper than the alternative — a resolution whose inputs were
 * gathered lazily is one whose test fixtures and production behaviour can
 * diverge, and this is not the function to have that happen in.
 */
async function loadCandidates(identity: FirebaseIdentity): Promise<{
  byFirebaseUid: ExistingCustomer | null;
  byMobile: ExistingCustomer | null;
  byEmail: ExistingCustomer | null;
  normalisedMobile: string | null;
}> {
  const phone = normaliseIndianMobile(identity.phoneNumber);
  const mobile = phone.ok ? phone.mobile : null;

  const [uidRow, mobileRow, emailRow] = await Promise.all([
    repo.findCustomerByFirebaseUid(identity.uid),
    mobile ? repo.findCustomerByMobile(mobile) : Promise.resolve(null),
    // Only fetched when Firebase VOUCHES for the address. An unverified email is
    // not a matching signal (see firebase-identity.ts), so looking it up would
    // be work whose only possible use is the one we refuse to make of it.
    identity.emailVerified && identity.email
      ? repo.findCustomerByEmail(identity.email)
      : Promise.resolve(null),
  ]);

  return {
    byFirebaseUid: uidRow ? toExisting(uidRow) : null,
    byMobile: mobileRow ? toExisting(mobileRow) : null,
    byEmail: emailRow ? toExisting(emailRow) : null,
    normalisedMobile: mobile,
  };
}

const toExisting = (row: repo.CustomerRow): ExistingCustomer => ({
  id: row.id,
  firebaseUid: row.firebaseUid,
  mobile: row.mobile,
  email: row.email,
  blockedAt: row.blockedAt,
});

/* ------------------------------------------------------------- mutations */

async function applyResolution(
  resolution: Exclude<Resolution, { action: 'reject' }>,
  identity: FirebaseIdentity,
): Promise<repo.CustomerRow> {
  const now = new Date();

  if (resolution.action === 'sign_in') {
    const row = await repo.findCustomerById(resolution.customerId);
    if (!row) {
      // The row was deleted between the lookup and here. Vanishingly rare, but
      // returning a stale row would sign somebody into a deleted account.
      throw new UnauthenticatedError('That account is no longer available.');
    }
    return row;
  }

  if (resolution.action === 'link') {
    const patch: Parameters<typeof repo.updateCustomer>[1] = {
      firebaseUid: resolution.setFirebaseUid,
    };

    // Phone sign-in proves possession of the number, so it is also the moment
    // the number becomes verified — for an account that had never confirmed it.
    if (resolution.matchedOn === 'mobile') patch.mobileVerifiedAt = now;
    if (resolution.matchedOn === 'email') patch.emailVerifiedAt = now;

    const row = await repo.updateCustomer(resolution.customerId, patch);
    if (!row) throw new UnauthenticatedError('That account is no longer available.');
    return row;
  }

  return repo.insertCustomer({
    firebaseUid: identity.uid,
    mobile: resolution.mobile,
    email: resolution.email,
    // Firebase carries a display name only for OAuth providers; a phone sign-in
    // has none. Left null rather than invented — the account screen asks for it.
    fullName: null,
    // A phone sign-in IS the verification. There is no separate confirm step.
    mobileVerifiedAt: resolution.mobile ? now : null,
    emailVerifiedAt: resolution.emailVerified ? now : null,
    // Never inferred from a sign-in. DPDP consent is granted explicitly or not
    // at all — see invariant 4 in auth.service.ts.
    marketingOptIn: false,
  });
}

/** `req.ip` and the UA, for the audit row. */
export const fingerprintOf = (req: Request): { ip: string | null; userAgent: string | null } => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});
