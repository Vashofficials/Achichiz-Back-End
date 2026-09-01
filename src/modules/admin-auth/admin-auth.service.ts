/**
 * Staff authentication: password, mandatory TOTP, sessions, reset, step-up.
 *
 * The invariant that shapes this file: **a write-capable role cannot hold a
 * staff access token without a second factor.** A correct password buys a
 * five-minute challenge token and nothing else; the session is minted only after
 * `verifyTwoFactor` or `enableTwoFactor` succeeds. `decideLoginOutcome` in
 * `admin-auth.totp.ts` is the whole policy, as a pure function, so it is tested
 * without a database.
 *
 * The other invariant: responses must not reveal which accounts exist. An
 * unknown email, a wrong password, a suspended account and an invited account
 * all take the same code path, burn the same argon2 time, and return the same
 * 401. Forgot-password always returns 200.
 */

import { randomBytes } from 'node:crypto';
import { db } from '../../config/db.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { emailSender } from '../../integrations/ses/index.js';
import { ForbiddenError, NotFoundError, UnauthenticatedError, UnprocessableError } from '../../lib/errors.js';
import { MODULES, ACTIONS, type ModuleKey } from '../../lib/rbac-matrix.js';
import {
  burnVerificationTime,
  hashPassword,
  hashSecret,
  verifyPassword,
  verifySecret,
} from '../auth/password.js';
// The shared revocation denylist the `authenticate` middleware reads on EVERY
// request. Reimplementing it here would produce a "revoked" session that the
// middleware happily keeps accepting, so this import is deliberate.
import { revokeSession, revokeSessions } from '../auth/session-store.js';
import { signStaffToken } from './staff-token.js';
import { resetLink } from './reset-link.js';
import * as repo from './admin-auth.repository.js';
import {
  clearStepUp,
  hasRecentStepUp,
  hashStaffRefreshToken,
  markStepUp,
  newStaffRefreshToken,
  signChallengeToken,
  staffRefreshTtlMs,
  verifyChallengeToken,
  STEP_UP_TTL_SECONDS,
} from './admin-auth.session.js';
import {
  decideLoginOutcome,
  hashRecoveryCode,
  isWriteCapable,
  newRecoveryCodes,
  newTotpSecret,
  recoveryCodeMatches,
  totpKeyUri,
  verifyTotp,
} from './admin-auth.totp.js';
import type { StaffAuth } from '../../lib/openapi/define-route.js';
import type {
  AdminMeResponse,
  LoginResultResponse,
  StaffSessionTokens,
  StaffSessionViewResponse,
  TwoFactorEnabledResponse,
  TwoFactorSetupResponse,
} from './admin-auth.schemas.js';

/** Five wrong passwords, then fifteen minutes of nothing. */
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;
const RESET_TOKEN_TTL_MINUTES = 30;

/** Everything the transport knows that the session row wants recorded. */
export type RequestMeta = {
  ip?: string | null;
  userAgent?: string | null;
  deviceLabel?: string | null;
};

/** A session plus the opaque refresh token the route turns into a cookie. */
export type IssuedSession = { tokens: StaffSessionTokens; refreshToken: string };

const accessTtlSeconds = (): number => {
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(env.JWT_STAFF_TTL.trim());
  if (!match?.[1]) return 600;
  const unit = (match[2] ?? 's').toLowerCase();
  const multiplier = unit === 'd' ? 86_400 : unit === 'h' ? 3_600 : unit === 'm' ? 60 : 1;
  return Number(match[1]) * multiplier;
};

/** The same flat 401 for every failure mode. Anything more is an enumeration oracle. */
const badCredentials = (): UnauthenticatedError =>
  new UnauthenticatedError('That email and password combination was not recognised.');

/* ------------------------------------------------------------- issuing */

async function issueSession(
  staffId: string,
  roleName: string,
  permissions: readonly string[],
  meta: RequestMeta,
): Promise<IssuedSession> {
  const refreshToken = newStaffRefreshToken();

  const session = await repo.insertSession({
    staffUserId: staffId,
    refreshTokenHash: hashStaffRefreshToken(refreshToken),
    deviceLabel: meta.deviceLabel ?? null,
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
    expiresAt: new Date(Date.now() + staffRefreshTtlMs),
  });

  const accessToken = await signStaffToken({
    staffId,
    sessionId: session.id,
    role: roleName,
    permissions: new Set(permissions),
  });

  await repo.clearFailedLogins(staffId);

  return {
    tokens: { accessToken, expiresInSeconds: accessTtlSeconds(), sessionId: session.id },
    refreshToken,
  };
}

/* --------------------------------------------------------------- login */

export async function login(
  input: { email: string; password: string; deviceLabel?: string | undefined },
  meta: RequestMeta,
): Promise<{ result: LoginResultResponse; refreshToken: string | null }> {
  const found = await repo.findByEmail(input.email);

  // Captured here rather than re-read off `staff` below: destructuring `found`
  // creates a fresh binding that loses this narrowing, and `password_hash` is
  // genuinely nullable for an invited account that has never set one.
  const passwordHash = found?.staff.passwordHash;

  // No account, or an invited account that has never set a password. Burn the
  // same CPU a real verification would, so latency is not an oracle.
  if (!found || !passwordHash) {
    await burnVerificationTime(input.password);
    throw badCredentials();
  }

  const { staff, roleName } = found;

  if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) {
    await burnVerificationTime(input.password);
    throw new UnauthenticatedError(
      'This account is temporarily locked after too many failed sign-in attempts. Try again shortly.',
    );
  }

  const verified = await verifyPassword(input.password, passwordHash);
  if (!verified.ok) {
    await repo.registerFailedLogin(staff.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES);
    throw badCredentials();
  }

  // A suspended account is checked AFTER the password so that probing suspension
  // costs a valid credential.
  if (staff.status !== 'active') {
    throw new ForbiddenError('This account is not active. Ask an administrator to reinstate it.');
  }

  if (verified.needsRehash) {
    await repo.updateStaff(staff.id, { passwordHash: await hashPassword(input.password) });
  }

  const permissions = await repo.permissionsForRole(staff.roleId);
  const outcome = decideLoginOutcome({ mfaEnabled: staff.mfaEnabled, permissions });

  if (outcome === 'session') {
    const issued = await issueSession(staff.id, roleName, permissions, {
      ...meta,
      deviceLabel: input.deviceLabel ?? meta.deviceLabel ?? null,
    });
    return {
      result: { status: 'authenticated', challengeToken: null, tokens: issued.tokens },
      refreshToken: issued.refreshToken,
    };
  }

  await repo.clearFailedLogins(staff.id);

  return {
    result: {
      status: outcome === 'mfa_required' ? 'mfa_required' : 'enrolment_required',
      challengeToken: await signChallengeToken({
        staffId: staff.id,
        purpose: outcome === 'mfa_required' ? 'verify' : 'enrol',
      }),
      tokens: null,
    },
    refreshToken: null,
  };
}

/* ------------------------------------------------------- second factor */

/**
 * Mint (but do not yet trust) a TOTP secret.
 *
 * The secret is written to `staff_users.mfa_secret` while `mfa_enabled` stays
 * false, so a half-finished enrolment cannot be used to log in — only
 * `enableTwoFactor`, which requires a code generated from that same secret,
 * flips the flag.
 */
export async function startTwoFactorSetup(challengeToken: string): Promise<TwoFactorSetupResponse> {
  const claims = await verifyChallengeToken(challengeToken);
  if (claims.purpose !== 'enrol') {
    throw new UnprocessableError('This account already has an authenticator enrolled.', 'mfa_already_enrolled');
  }

  const found = await repo.findById(claims.staffId);
  if (!found) throw badCredentials();

  const secret = newTotpSecret();
  await repo.updateStaff(found.staff.id, { mfaSecret: secret, mfaEnabled: false });

  return { secret, otpauthUri: totpKeyUri(found.staff.email, secret) };
}

export async function enableTwoFactor(
  input: { challengeToken: string; code: string; deviceLabel?: string | undefined },
  meta: RequestMeta,
): Promise<{ result: TwoFactorEnabledResponse; refreshToken: string | null }> {
  const claims = await verifyChallengeToken(input.challengeToken);
  if (claims.purpose !== 'enrol') {
    throw new UnprocessableError('This account already has an authenticator enrolled.', 'mfa_already_enrolled');
  }

  const found = await repo.findById(claims.staffId);
  if (!found?.staff.mfaSecret) {
    throw new UnprocessableError(
      'Start the enrolment first — call POST /v1/admin/auth/2fa/setup for a secret.',
      'mfa_setup_missing',
    );
  }
  if (!verifyTotp(input.code, found.staff.mfaSecret)) {
    throw new UnauthenticatedError('That code is not valid. Check the clock on the device generating it.');
  }

  const codes = newRecoveryCodes();

  await db.transaction(async (tx) => {
    await repo.updateStaff(found.staff.id, { mfaEnabled: true }, tx);
    await repo.putRecoveryCodes(found.staff.id, codes.map(hashRecoveryCode), tx);
  });

  const permissions = await repo.permissionsForRole(found.staff.roleId);
  const issued = await issueSession(found.staff.id, found.roleName, permissions, {
    ...meta,
    deviceLabel: input.deviceLabel ?? meta.deviceLabel ?? null,
  });

  // Shown once. Only digests were stored, so this response is the only copy.
  return { result: { recoveryCodes: codes, tokens: issued.tokens }, refreshToken: issued.refreshToken };
}

export async function verifyTwoFactor(
  input: {
    challengeToken: string;
    code?: string | undefined;
    recoveryCode?: string | undefined;
    deviceLabel?: string | undefined;
  },
  meta: RequestMeta,
): Promise<{ result: LoginResultResponse; refreshToken: string }> {
  const claims = await verifyChallengeToken(input.challengeToken);
  if (claims.purpose !== 'verify') {
    throw new UnprocessableError(
      'This account has no authenticator yet. Complete enrolment instead.',
      'mfa_enrolment_required',
    );
  }

  const found = await repo.findById(claims.staffId);
  if (!found?.staff.mfaSecret || found.staff.status !== 'active') throw badCredentials();

  if (input.code) {
    if (!verifyTotp(input.code, found.staff.mfaSecret)) {
      await repo.registerFailedLogin(found.staff.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES);
      throw new UnauthenticatedError('That code is not valid.');
    }
  } else {
    const consumed = await consumeRecoveryCode(found.staff.id, input.recoveryCode ?? '');
    if (!consumed) {
      await repo.registerFailedLogin(found.staff.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES);
      throw new UnauthenticatedError('That recovery code is not valid, or has already been used.');
    }
  }

  const permissions = await repo.permissionsForRole(found.staff.roleId);
  const issued = await issueSession(found.staff.id, found.roleName, permissions, {
    ...meta,
    deviceLabel: input.deviceLabel ?? meta.deviceLabel ?? null,
  });

  return {
    result: { status: 'authenticated', challengeToken: null, tokens: issued.tokens },
    refreshToken: issued.refreshToken,
  };
}

/** Single-use: the matching digest is removed whether or not the login later fails. */
async function consumeRecoveryCode(staffId: string, candidate: string): Promise<boolean> {
  if (!candidate) return false;
  const digests = await repo.getRecoveryCodes(staffId);
  const remaining = digests.filter((digest) => !recoveryCodeMatches(candidate, digest));
  if (remaining.length === digests.length) return false;
  await repo.putRecoveryCodes(staffId, remaining);
  return true;
}

/**
 * Reissue the ten codes. Requires a live step-up, because anyone holding a
 * borrowed laptop with an open console would otherwise mint themselves a
 * permanent 2FA bypass.
 */
export async function regenerateRecoveryCodes(auth: StaffAuth): Promise<{ recoveryCodes: string[] }> {
  await assertStepUp(auth);
  const found = await repo.findById(auth.staffId);
  if (!found?.staff.mfaEnabled) {
    throw new UnprocessableError('This account has no authenticator enrolled.', 'mfa_not_enrolled');
  }
  const codes = newRecoveryCodes();
  await repo.putRecoveryCodes(auth.staffId, codes.map(hashRecoveryCode));
  return { recoveryCodes: codes };
}

/* ------------------------------------------------------------- refresh */

/**
 * Rotate the refresh token.
 *
 * The presented token's hash must match a live, unrevoked, unexpired row. A hash
 * that matches nothing is a flat 401 — there is no partial credit and no message
 * that distinguishes "expired" from "never existed".
 */
export async function refresh(
  presentedToken: string | undefined,
  meta: RequestMeta,
): Promise<{ tokens: StaffSessionTokens; refreshToken: string }> {
  if (!presentedToken) throw new UnauthenticatedError('No refresh token was presented.');

  const session = await repo.findLiveSessionByRefreshHash(hashStaffRefreshToken(presentedToken));
  if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
    throw new UnauthenticatedError('That session has expired. Sign in again.');
  }

  const found = await repo.findById(session.staffUserId);
  if (!found || found.staff.status !== 'active') {
    await repo.revokeSessionRow(session.id);
    await revokeSession(session.id);
    throw new UnauthenticatedError('That session is no longer valid.');
  }

  const rotated = newStaffRefreshToken();
  await repo.rotateSession(
    session.id,
    hashStaffRefreshToken(rotated),
    new Date(Date.now() + staffRefreshTtlMs),
  );

  // Permissions are re-read on every refresh, so a revoked grant takes effect
  // within one access-token lifetime rather than at the next sign-in.
  const permissions = await repo.permissionsForRole(found.staff.roleId);
  const accessToken = await signStaffToken({
    staffId: found.staff.id,
    sessionId: session.id,
    role: found.roleName,
    permissions: new Set(permissions),
  });

  await repo.updateStaff(found.staff.id, { lastActiveAt: new Date() });
  logger.debug({ staffId: found.staff.id, sessionId: session.id, ip: meta.ip }, 'staff session refreshed');

  return {
    tokens: { accessToken, expiresInSeconds: accessTtlSeconds(), sessionId: session.id },
    refreshToken: rotated,
  };
}

/* -------------------------------------------------------------- logout */

export async function logout(presentedToken: string | undefined, auth: StaffAuth | undefined): Promise<void> {
  const sessionId =
    auth?.sessionId ??
    (presentedToken
      ? (await repo.findLiveSessionByRefreshHash(hashStaffRefreshToken(presentedToken)))?.id
      : undefined);

  if (!sessionId) return;

  await repo.revokeSessionRow(sessionId);
  await revokeSession(sessionId);
  await clearStepUp(sessionId);
}

/* ------------------------------------------------------ me and sessions */

export async function me(auth: StaffAuth): Promise<AdminMeResponse> {
  const found = await repo.findById(auth.staffId);
  if (!found) throw new NotFoundError('Staff user', auth.staffId);

  const [permissions, warehouseIds, stepUpActive] = await Promise.all([
    repo.permissionsForRole(found.staff.roleId),
    repo.warehouseScopeFor(found.staff.id),
    hasRecentStepUp(auth.sessionId),
  ]);

  const granted = new Set(permissions.map((p) => p.slice(0, p.indexOf(':'))));

  return {
    id: found.staff.id,
    email: found.staff.email,
    fullName: found.staff.fullName,
    avatarInitials: found.staff.avatarInitials,
    role: { key: found.roleKey, name: found.roleName },
    permissions,
    modules: MODULES.filter((m): m is ModuleKey => granted.has(m)),
    actions: [...ACTIONS],
    warehouseIds,
    mfaEnabled: found.staff.mfaEnabled,
    mfaRequired: isWriteCapable(permissions),
    stepUpActive,
    sessionId: auth.sessionId,
    lastActiveAt: found.staff.lastActiveAt ? found.staff.lastActiveAt.toISOString() : null,
  };
}

export async function listSessions(auth: StaffAuth): Promise<StaffSessionViewResponse[]> {
  const rows = await repo.listActiveSessions(auth.staffId);
  return rows.map((row) => ({
    id: row.id,
    deviceLabel: row.deviceLabel,
    userAgent: row.userAgent,
    ip: row.ip,
    locationLabel: row.locationLabel,
    issuedAt: row.issuedAt.toISOString(),
    lastActiveAt: row.lastActiveAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    isCurrent: row.id === auth.sessionId,
  }));
}

export async function revokeOwnSession(auth: StaffAuth, sessionId: string): Promise<void> {
  const session = await repo.findSession(sessionId);
  // Someone else's session id is a 404, not a 403 — confirming it exists is the leak.
  if (!session || session.staffUserId !== auth.staffId) throw new NotFoundError('Session', sessionId);

  await repo.revokeSessionRow(sessionId);
  await revokeSession(sessionId);
  await clearStepUp(sessionId);
}

/* ------------------------------------------------------ password reset */

/**
 * Always 200, always the same body, always the same rough latency.
 *
 * The reset token is 256 random bits; only its argon2id hash reaches
 * `otp_challenges`. Reusing that table rather than inventing one keeps the
 * expiry, attempt-count and consumption semantics identical to every other
 * challenge in the system.
 */
export async function forgotPassword(email: string): Promise<void> {
  const found = await repo.findByEmail(email);

  if (!found || found.staff.status === 'suspended') {
    // Spend comparable time so the response is not a membership test.
    await burnVerificationTime(email);
    return;
  }

  const token = randomBytes(32).toString('base64url');

  await repo.insertResetChallenge({
    channel: 'email',
    destination: found.staff.email,
    codeHash: await hashSecret(token),
    purpose: 'password_reset',
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000),
  });

  try {
    await emailSender.send({
      to: found.staff.email,
      subject: 'Reset your Achichiz admin password',
      text:
        `Hello ${found.staff.fullName},\n\n` +
        `Open this link to set a new password. It expires in ${RESET_TOKEN_TTL_MINUTES} minutes ` +
        `and works once.\n\n${resetLink(found.staff.email, token)}\n\n` +
        `If the link does not open, go to ${env.ADMIN_PANEL_URL}/reset-password and enter this ` +
        `token:\n\n${token}\n\n` +
        `If you did not ask for this, ignore this email — nothing has changed.\n`,
    });
  } catch (err) {
    // A mail outage must not turn into a signal about whether the account exists.
    logger.error({ err, staffId: found.staff.id }, 'staff password reset email failed to send');
  }
}

export async function resetPassword(input: {
  email: string;
  token: string;
  newPassword: string;
}): Promise<void> {
  const found = await repo.findByEmail(input.email);
  const challenge = found ? await repo.findLiveResetChallenge(found.staff.email) : null;

  if (!found || !challenge) {
    await burnVerificationTime(input.token);
    throw new UnprocessableError('That reset link is invalid or has expired.', 'reset_token_invalid');
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    await repo.consumeResetChallenge(challenge.id);
    throw new UnprocessableError('That reset link has been tried too many times.', 'reset_token_invalid');
  }

  if (!(await verifySecret(input.token, challenge.codeHash))) {
    await repo.bumpResetAttempts(challenge.id);
    throw new UnprocessableError('That reset link is invalid or has expired.', 'reset_token_invalid');
  }

  const passwordHash = await hashPassword(input.newPassword);

  const revoked = await db.transaction(async (tx) => {
    await repo.consumeResetChallenge(challenge.id, tx);
    await repo.updateStaff(
      found.staff.id,
      {
        passwordHash,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        // An invited account becomes usable the moment it has a password, which
        // is what `staff_active_needs_password` is asserting from the other side.
        ...(found.staff.status === 'invited' ? { status: 'active' as const } : {}),
      },
      tx,
    );
    // Changing a password ends every other session. A reset is what you do when
    // you believe someone else has your credentials.
    return repo.revokeAllSessions(found.staff.id, tx);
  });

  await revokeSessions(revoked);
}

/* ------------------------------------------------------------- step-up */

export async function stepUp(auth: StaffAuth, password: string): Promise<{ expiresInSeconds: number }> {
  const found = await repo.findById(auth.staffId);
  if (!found?.staff.passwordHash || found.staff.status !== 'active') {
    await burnVerificationTime(password);
    throw badCredentials();
  }

  const verified = await verifyPassword(password, found.staff.passwordHash);
  if (!verified.ok) {
    await repo.registerFailedLogin(found.staff.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES);
    throw badCredentials();
  }

  await markStepUp(auth.sessionId);
  return { expiresInSeconds: STEP_UP_TTL_SECONDS };
}

/**
 * The gate in front of money movement. Exported for `admin-orders`, which calls
 * it service→service rather than reaching into this module's internals.
 */
export async function assertStepUp(auth: StaffAuth): Promise<void> {
  if (await hasRecentStepUp(auth.sessionId)) return;
  throw new ForbiddenError(
    'Re-enter your password before doing this. POST /v1/admin/auth/step-up, then retry.',
    { context: { code: 'step_up_required' } },
  );
}
