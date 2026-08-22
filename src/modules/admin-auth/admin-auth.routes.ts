import { Router, type Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, noContent, ok } from '../../lib/http.js';
import * as adminAuth from './admin-auth.service.js';
import {
  clearStaffRefreshCookie,
  readStaffRefreshCookie,
  setStaffRefreshCookie,
} from './admin-auth.session.js';
import {
  acknowledged,
  adminMe,
  forgotPasswordBody,
  loginBody,
  loginResult,
  resetPasswordBody,
  sessionIdParam,
  staffSessionTokens,
  staffSessionView,
  stepUpBody,
  twoFactorEnabled,
  twoFactorEnrolBody,
  twoFactorSetup,
  twoFactorSetupBody,
  twoFactorVerifyBody,
} from './admin-auth.schemas.js';

/**
 * Staff authentication.
 *
 * Everything under `/v1/admin/auth/` is `auth: 'public'` by necessity — you
 * cannot present a staff token before you have one — which is also why
 * `defineRoute` exempts that prefix from its "admin routes must declare a
 * permission" rule. The routes that are NOT under it (`/v1/admin/me`,
 * `/v1/admin/sessions`) declare `dashboard:view`, the grant every one of the
 * eleven roles holds.
 *
 * The refresh token lives in an httpOnly cookie scoped to `/v1/admin/auth`, so
 * it is not attached to the ~90 other admin requests and is unreachable from JS.
 * The access token is returned in the body for the console to hold in memory.
 */
export const adminAuthRouter: Router = Router();

const metaOf = (req: Request, deviceLabel?: string  ): adminAuth.RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  deviceLabel: deviceLabel ?? null,
});

defineRoute(adminAuthRouter, {
  method: 'post',
  path: '/v1/admin/auth/login',
  surface: 'admin',
  operationId: 'adminLogin',
  summary: 'Sign in to the admin console',
  description:
    'Backs `/login`. A correct password does NOT necessarily produce a session — read `status`:\n\n' +
    '- `authenticated` — a read-only role, or 2FA already satisfied. `tokens` is populated and the ' +
    'refresh cookie is set.\n' +
    '- `mfa_required` — an authenticator is enrolled. Route to `/two-factor` and post the ' +
    '`challengeToken` with the six-digit code.\n' +
    '- `enrolment_required` — **the role can change data and has no second factor.** No session is ' +
    'issued at all. Route to `/two-factor` in enrolment mode: `POST /2fa/setup` for the QR, then ' +
    '`POST /2fa/enable`.\n\n' +
    'An unknown email, a wrong password and an account with no password set are one identical 401 ' +
    'that costs the same wall-clock time, because response latency is otherwise an account-enumeration ' +
    'oracle. Five failures lock the account for fifteen minutes.',
  tags: ['Admin auth'],
  auth: 'public',
  rateLimit: 'auth',
  request: { body: loginBody },
  responses: {
    200: { description: 'Signed in, or told which second-factor step comes next.', schema: loginResult },
    401: { description: 'Bad credentials, or the account is temporarily locked.' },
    403: { description: 'The credentials were right but the account is suspended or still invited.' },
  },
  handler: async ({ body, req, res }) => {
    const { result, refreshToken } = await adminAuth.login(body, metaOf(req, body.deviceLabel));
    if (refreshToken) setStaffRefreshCookie(res, refreshToken);
    return ok(result);
  },
});

defineRoute(adminAuthRouter, {
  method: 'post',
  path: '/v1/admin/auth/2fa/setup',
  surface: 'admin',
  operationId: 'adminStartTwoFactorSetup',
  summary: 'Begin authenticator enrolment',
  description:
    'Returns a fresh base32 secret and its `otpauth://` URI for the QR code. The secret is stored ' +
    'against the account immediately but `mfaEnabled` stays false, so a half-finished enrolment cannot ' +
    'be used to sign in — only `POST /2fa/enable`, which requires a code generated from this secret, ' +
    'completes it. Calling this again replaces the pending secret.',
  tags: ['Admin auth'],
  auth: 'public',
  rateLimit: 'auth',
  request: { body: twoFactorSetupBody },
  responses: {
    200: { description: 'The secret and QR payload. Shown once.', schema: twoFactorSetup },
    401: { description: 'The challenge token is missing, expired or malformed.' },
    422: { description: 'This account already has an authenticator.' },
  },
  handler: async ({ body }) => ok(await adminAuth.startTwoFactorSetup(body.challengeToken)),
});

defineRoute(adminAuthRouter, {
  method: 'post',
  path: '/v1/admin/auth/2fa/enable',
  surface: 'admin',
  operationId: 'adminEnableTwoFactor',
  summary: 'Finish authenticator enrolment and sign in',
  description:
    'Verifies a code against the pending secret, flips `mfaEnabled`, issues ten single-use recovery ' +
    'codes and completes the sign-in in one call. **The recovery codes are returned exactly once** — ' +
    'only their sha256 digests are stored, so there is no endpoint that can show them again.',
  tags: ['Admin auth'],
  auth: 'public',
  rateLimit: 'auth',
  request: { body: twoFactorEnrolBody },
  responses: {
    201: { description: 'Enrolled and signed in. Store the recovery codes now.', schema: twoFactorEnabled },
    401: { description: 'The challenge token or the code is not valid.' },
    422: { description: 'No pending secret — call `/2fa/setup` first.' },
  },
  handler: async ({ body, req, res }) => {
    const { result, refreshToken } = await adminAuth.enableTwoFactor(body, metaOf(req, body.deviceLabel));
    if (refreshToken) setStaffRefreshCookie(res, refreshToken);
    return created(result);
  },
});

defineRoute(adminAuthRouter, {
  method: 'post',
  path: '/v1/admin/auth/2fa/verify',
  surface: 'admin',
  operationId: 'adminVerifyTwoFactor',
  summary: 'Complete sign-in with the second factor',
  description:
    'Backs `/two-factor`. Send exactly one of `code` (six digits from the app) or `recoveryCode` ' +
    '(single-use; the digest is deleted whether or not anything later fails). A wrong value counts ' +
    'towards the same five-attempt lockout as a wrong password.\n\n' +
    '`trustDevice` is accepted so the console’s checkbox has somewhere to go, but it does not mint a ' +
    '2FA bypass cookie — skipping the second factor for thirty days on a device is precisely the ' +
    'exposure the second factor exists to remove.',
  tags: ['Admin auth'],
  auth: 'public',
  rateLimit: 'auth',
  request: { body: twoFactorVerifyBody },
  responses: {
    200: { description: 'Signed in.', schema: loginResult },
    401: { description: 'The challenge token, code or recovery code is not valid.' },
    422: { description: 'This account has no authenticator — enrol instead.' },
  },
  handler: async ({ body, req, res }) => {
    const { result, refreshToken } = await adminAuth.verifyTwoFactor(body, metaOf(req, body.deviceLabel));
    setStaffRefreshCookie(res, refreshToken);
    return ok(result);
  },
});

defineRoute(adminAuthRouter, {
  method: 'post',
  path: '/v1/admin/auth/refresh',
  surface: 'admin',
  operationId: 'adminRefreshSession',
  summary: 'Exchange the refresh cookie for a new access token',
  description:
    'Reads the httpOnly `ach_art` cookie — nothing in the body. Rotates the stored hash, so the ' +
    'presented token is dead the moment this returns, and re-reads the role’s grants from ' +
    '`role_permissions`, which is what makes a revoked permission take effect within one ten-minute ' +
    'access-token lifetime instead of at the next sign-in. A token that matches no live row is a flat ' +
    '401; the console should route to `/session-expired`.',
  tags: ['Admin auth'],
  auth: 'public',
  rateLimit: 'auth',
  responses: {
    200: { description: 'A new access token, and a rotated refresh cookie.', schema: staffSessionTokens },
    401: { description: 'No cookie, or it is expired, revoked or unknown.' },
  },
  handler: async ({ req, res }) => {
    const { tokens, refreshToken } = await adminAuth.refresh(readStaffRefreshCookie(req), metaOf(req));
    setStaffRefreshCookie(res, refreshToken);
    return ok(tokens);
  },
});

defineRoute(adminAuthRouter, {
  method: 'post',
  path: '/v1/admin/auth/logout',
  surface: 'admin',
  operationId: 'adminLogout',
  summary: 'Sign out of this session',
  description:
    'Revokes the session row, adds it to the Redis denylist so the outstanding access token stops ' +
    'working immediately rather than at expiry, clears any step-up window and clears the cookie. ' +
    'Deliberately 204 whether or not a session was found — sign-out must never fail.',
  tags: ['Admin auth'],
  auth: 'public',
  skipAudit: true,
  responses: {
    204: { description: 'Signed out.' },
  },
  handler: async ({ req, res }) => {
    const auth = req.auth?.kind === 'staff' ? req.auth : undefined;
    await adminAuth.logout(readStaffRefreshCookie(req), auth);
    clearStaffRefreshCookie(res);
    return noContent();
  },
});

defineRoute(adminAuthRouter, {
  method: 'post',
  path: '/v1/admin/auth/password/forgot',
  surface: 'admin',
  operationId: 'adminForgotPassword',
  summary: 'Request a password-reset token',
  description:
    'Always 200 with the same body, whether or not the address belongs to an account — otherwise this ' +
    'endpoint is a staff-directory oracle. The token is 256 random bits, valid for thirty minutes, ' +
    'single-use, and only its argon2id hash is stored (in `otp_challenges`, reusing that table’s ' +
    'expiry and attempt semantics rather than inventing new ones).',
  tags: ['Admin auth'],
  auth: 'public',
  rateLimit: 'otp',
  request: { body: forgotPasswordBody },
  responses: {
    200: { description: 'Accepted. Says nothing about whether the account exists.', schema: acknowledged },
  },
  handler: async ({ body }) => {
    await adminAuth.forgotPassword(body.email);
    return ok({ ok: true as const });
  },
});

defineRoute(adminAuthRouter, {
  method: 'post',
  path: '/v1/admin/auth/password/reset',
  surface: 'admin',
  operationId: 'adminResetPassword',
  summary: 'Set a new password with a reset token',
  description:
    'Backs `/reset-password`, which today does not read a token from the URL at all — it must, and ' +
    'this endpoint requires it alongside the email. On success the token is consumed, an `invited` ' +
    'account becomes `active`, the lockout counter is cleared, and **every other session is revoked**: ' +
    'a reset is what you do when you think someone else has your credentials.',
  tags: ['Admin auth'],
  auth: 'public',
  rateLimit: 'auth',
  request: { body: resetPasswordBody },
  responses: {
    200: { description: 'The password was changed. Sign in again.', schema: acknowledged },
    422: { description: 'The token is unknown, expired, already used or tried too many times.' },
  },
  handler: async ({ body }) => {
    await adminAuth.resetPassword(body);
    return ok({ ok: true as const });
  },
});

defineRoute(adminAuthRouter, {
  method: 'post',
  path: '/v1/admin/auth/step-up',
  surface: 'admin',
  operationId: 'adminStepUpReauth',
  summary: 'Re-enter your password to unlock money movement',
  description:
    'Opens a five-minute window on the CURRENT session. `POST /v1/admin/orders/{orderId}/refund` ' +
    'requires it: ten minutes of access-token life is a long time for an unattended laptop and a ' +
    'refund is irreversible. The window lives in Redis, not in a token claim, so signing out or ' +
    'revoking the session ends it instantly. `GET /v1/admin/me` reports `stepUpActive`.',
  tags: ['Admin auth'],
  auth: 'staff',
  rateLimit: 'auth',
  request: { body: stepUpBody },
  responses: {
    200: {
      description: 'Step-up granted.',
      schema: z.object({
        expiresInSeconds: z.number().int().describe('How long the window lasts, in seconds.'),
      }),
    },
    401: { description: 'The password was wrong. This counts towards the lockout.' },
  },
  handler: async ({ body, auth }) => ok(await adminAuth.stepUp(auth, body.password)),
});

defineRoute(adminAuthRouter, {
  method: 'post',
  path: '/v1/admin/auth/2fa/recovery-codes',
  surface: 'admin',
  operationId: 'adminRegenerateRecoveryCodes',
  summary: 'Reissue the ten recovery codes',
  description:
    'Discards every unused code and returns ten new ones, shown once. Requires a live step-up ' +
    '(`POST /v1/admin/auth/step-up`) — without that, anyone who found an open console could mint ' +
    'themselves a permanent second-factor bypass.',
  tags: ['Admin auth'],
  auth: 'staff',
  rateLimit: 'auth',
  responses: {
    201: { description: 'Ten new codes. Store them now.', schema: twoFactorEnabled.pick({ recoveryCodes: true }) },
    403: { description: 'No recent step-up.' },
    422: { description: 'This account has no authenticator enrolled.' },
  },
  handler: async ({ auth }) => created(await adminAuth.regenerateRecoveryCodes(auth)),
});

/* ------------------------------------------------- outside /admin/auth/ */

defineRoute(adminAuthRouter, {
  method: 'get',
  path: '/v1/admin/me',
  surface: 'admin',
  operationId: 'getAdminMe',
  summary: 'The signed-in staff member',
  description:
    'Everything the console shell needs on boot: identity, role, the flat `module:action` grant list, ' +
    'the modules to render in the nav, warehouse scope (an EMPTY array means every warehouse), whether ' +
    '2FA is enrolled and whether this role is required to have it. The grant list is for optimistic ' +
    'UI only — the server re-checks every call, so hiding a button is a convenience, not a control.',
  tags: ['Admin auth'],
  auth: 'staff',
  // Genuinely open to every authenticated staff member: all eleven roles hold
  // `dashboard:view`, and a session that cannot read its own identity is useless.
  permission: { module: 'dashboard', action: 'view' },
  responses: {
    200: { description: 'The current staff member.', schema: adminMe },
  },
  handler: async ({ auth }) => ok(await adminAuth.me(auth)),
});

defineRoute(adminAuthRouter, {
  method: 'get',
  path: '/v1/admin/sessions',
  surface: 'admin',
  operationId: 'listMyStaffSessions',
  summary: 'My active sessions',
  description:
    'Backs the sessions table on `/profile`. Only your own sessions — signing another staff member ' +
    'out is a `settings` action, not self-service.',
  tags: ['Admin auth'],
  auth: 'staff',
  permission: { module: 'dashboard', action: 'view' },
  responses: {
    200: { description: 'Live sessions, most recently used first.', schema: z.array(staffSessionView) },
  },
  handler: async ({ auth }) => ok(await adminAuth.listSessions(auth)),
});

defineRoute(adminAuthRouter, {
  method: 'delete',
  path: '/v1/admin/sessions/:sessionId',
  surface: 'admin',
  operationId: 'revokeMyStaffSession',
  summary: 'Revoke one of my sessions',
  description:
    'Revokes the row and denylists the session id, so the access token issued from it stops working ' +
    'on the next request rather than at expiry. A session id belonging to someone else returns 404, ' +
    'not 403 — confirming it exists is itself a leak.',
  tags: ['Admin auth'],
  auth: 'staff',
  permission: { module: 'dashboard', action: 'view' },
  request: { params: sessionIdParam },
  responses: {
    204: { description: 'Revoked.' },
    404: { description: 'No such session, or it is not yours.' },
  },
  handler: async ({ params, auth }) => {
    await adminAuth.revokeOwnSession(auth, params.sessionId);
    return noContent();
  },
});
