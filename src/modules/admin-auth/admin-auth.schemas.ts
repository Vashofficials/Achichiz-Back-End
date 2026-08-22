/**
 * Staff auth contracts.
 *
 * These back the seven auth-flow shells in the admin console (02_admin_api.md
 * §3.10): /login, /otp, /two-factor, /forgot-password, /reset-password,
 * /session-expired and /unauthorized.
 */

import { z } from 'zod';
import { MODULES, ACTIONS } from '../../lib/rbac-matrix.js';

export const staffEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254)
  .describe('Work email. Matching is case-insensitive — the column is CITEXT.');

/**
 * Deliberately weak at the edge: length only.
 *
 * A composition rule enforced here would reject a correct password on the LOGIN
 * form the day the policy changes, locking out every account that predates it.
 * Strength is enforced where a password is *set*, not where it is presented.
 */
export const loginBody = z.object({
  email: staffEmail,
  password: z.string().min(1).max(200).describe('The account password. Never logged, never audited.'),
  deviceLabel: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe('Human label for this device, e.g. `MacBook Pro · Chrome`. Shown on the sessions screen.'),
});

/** Enforced only when a password is created or changed. */
export const newPassword = z
  .string()
  .min(12, 'A staff password must be at least 12 characters.')
  .max(200)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v), {
    message: 'Use upper case, lower case and a digit.',
  })
  .describe('At least 12 characters with upper case, lower case and a digit.');

export const totpCode = z
  .string()
  .trim()
  .regex(/^[0-9]{6}$/, 'An authenticator code is six digits.')
  .describe('The six-digit code from the authenticator app.');

export const twoFactorVerifyBody = z
  .object({
    challengeToken: z
      .string()
      .min(10)
      .describe('The `challengeToken` returned by `POST /v1/admin/auth/login`. Valid for five minutes.'),
    code: totpCode.optional(),
    recoveryCode: z
      .string()
      .trim()
      .min(6)
      .max(24)
      .optional()
      .describe('A one-time recovery code, if the authenticator is unavailable. Consumed on use.'),
    trustDevice: z
      .boolean()
      .default(false)
      .describe(
        'Accepted for the console’s “trust this device” checkbox. It currently only lengthens the ' +
          'device label — no 2FA bypass cookie is minted, because a bypass is exactly the thing the ' +
          'second factor exists to prevent.',
      ),
    deviceLabel: z.string().trim().max(80).optional().describe('Human label for this device.'),
  })
  .refine((b) => Boolean(b.code) !== Boolean(b.recoveryCode), {
    message: 'Send exactly one of `code` or `recoveryCode`.',
    path: ['code'],
  });

export const twoFactorEnrolBody = z.object({
  challengeToken: z
    .string()
    .min(10)
    .describe('The enrolment `challengeToken` from login. Required — enrolment is part of signing in.'),
  code: totpCode.describe('A code from the app, proving the secret was stored correctly.'),
  deviceLabel: z.string().trim().max(80).optional().describe('Human label for this device.'),
});

export const twoFactorSetupBody = z.object({
  challengeToken: z
    .string()
    .min(10)
    .describe('The enrolment `challengeToken` from login.'),
});

export const forgotPasswordBody = z.object({
  email: staffEmail,
});

export const resetPasswordBody = z.object({
  email: staffEmail,
  token: z
    .string()
    .trim()
    .min(20)
    .max(200)
    .describe('The single-use token from the reset email. Only its argon2id hash is stored.'),
  newPassword,
});

export const stepUpBody = z.object({
  password: z.string().min(1).max(200).describe('The current account password, re-entered.'),
});

export const sessionIdParam = z.object({
  sessionId: z.uuid().describe('Session id from `GET /v1/admin/sessions`.'),
});

/* -------------------------------------------------------------- responses */

export const staffSessionTokens = z.object({
  accessToken: z
    .string()
    .describe('Bearer token for `Authorization`. Ten minutes — the console refreshes silently.'),
  expiresInSeconds: z.number().int().describe('Access-token lifetime in seconds.'),
  sessionId: z.uuid().describe('The session this token belongs to. Revoking it kills the lineage.'),
});

export const loginResult = z.object({
  status: z
    .enum(['authenticated', 'mfa_required', 'enrolment_required'])
    .describe(
      '`authenticated` → tokens are present. `mfa_required` → route to /two-factor. ' +
        '`enrolment_required` → the role can change data and has no second factor; route to /two-factor ' +
        'in enrolment mode. No session exists until 2FA is satisfied.',
    ),
  challengeToken: z
    .string()
    .nullable()
    .describe('Five-minute token that identifies the half-finished sign-in. Null once authenticated.'),
  tokens: staffSessionTokens.nullable().describe('Present only when `status` is `authenticated`.'),
});

export const twoFactorSetup = z.object({
  secret: z.string().describe('Base32 shared secret. Shown once, for manual entry.'),
  otpauthUri: z.string().describe('`otpauth://totp/...` — render this as the QR code.'),
});

export const twoFactorEnabled = z.object({
  recoveryCodes: z
    .array(z.string())
    .describe('Ten single-use codes. Shown ONCE — only sha256 digests are stored server-side.'),
  tokens: staffSessionTokens.nullable().describe('A session, when enrolment completed a sign-in.'),
});

export const adminMe = z.object({
  id: z.uuid().describe('Staff user id.'),
  email: z.string().describe('Work email.'),
  fullName: z.string().describe('Display name.'),
  avatarInitials: z.string().nullable().describe('Generated in the database from the full name.'),
  role: z.object({
    key: z.string().describe('`operations_manager` — stable machine key.'),
    name: z.string().describe('`Operations Manager` — display name.'),
  }),
  permissions: z
    .array(z.string())
    .describe('`module:action` grants, e.g. `orders:refund`. The console mirrors these for optimistic UI only.'),
  modules: z
    .array(z.enum(MODULES))
    .describe('Modules with at least one grant — drives which nav groups render.'),
  actions: z.array(z.enum(ACTIONS)).describe('The nine action keys, for reference.'),
  warehouseIds: z
    .array(z.uuid())
    .describe('Warehouse scope. An EMPTY array means every warehouse, matching the schema.'),
  mfaEnabled: z.boolean().describe('True when an authenticator is enrolled.'),
  mfaRequired: z.boolean().describe('True when this role is write-capable and therefore must carry 2FA.'),
  stepUpActive: z.boolean().describe('True while a recent re-auth still satisfies refund step-up.'),
  sessionId: z.uuid().describe('The current session id.'),
  lastActiveAt: z.string().nullable().describe('ISO-8601 timestamp of the last authenticated request.'),
});

export const staffSessionView = z.object({
  id: z.uuid().describe('Session id.'),
  deviceLabel: z.string().nullable().describe('Human device label supplied at sign-in.'),
  userAgent: z.string().nullable().describe('Raw user agent.'),
  ip: z.string().nullable().describe('Originating IP.'),
  locationLabel: z.string().nullable().describe('Coarse location, when resolved.'),
  issuedAt: z.string().describe('ISO-8601 sign-in timestamp.'),
  lastActiveAt: z.string().describe('ISO-8601 timestamp of the last refresh.'),
  expiresAt: z.string().describe('ISO-8601 expiry of the refresh lineage.'),
  isCurrent: z.boolean().describe('True for the session making this request.'),
});

export const acknowledged = z.object({
  ok: z.literal(true).describe('Always true. The response is deliberately uninformative.'),
});

export type LoginResultResponse = z.infer<typeof loginResult>;
export type AdminMeResponse = z.infer<typeof adminMe>;
export type StaffSessionViewResponse = z.infer<typeof staffSessionView>;
export type TwoFactorSetupResponse = z.infer<typeof twoFactorSetup>;
export type TwoFactorEnabledResponse = z.infer<typeof twoFactorEnabled>;
export type StaffSessionTokens = z.infer<typeof staffSessionTokens>;
