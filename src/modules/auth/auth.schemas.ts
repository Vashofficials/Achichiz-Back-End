/**
 * Customer authentication contracts.
 *
 * Two deliberate absences, both security decisions rather than oversights:
 *
 *  1. **No `refreshToken` field appears in any response.** 04_architecture.md
 *     §3.1 delivers the refresh token as an httpOnly `ach_rt` cookie, and the
 *     whole point of httpOnly is that JavaScript never sees it. Echoing it in the
 *     JSON body as well would hand it straight back to the XSS the cookie exists
 *     to survive — that is precisely the mistake the storefront makes today,
 *     keeping a Supabase token in `localStorage` (01_storefront_api.md §4).
 *  2. **No response distinguishes "no such account" from "wrong credential".**
 *     `login`, `forgotPassword` and `requestOtp` return byte-identical bodies
 *     either way, and the service burns the same CPU on both paths so latency is
 *     not an oracle either.
 */

import { z } from 'zod';

/* ------------------------------------------------------- shared primitives */

/** DB DOMAIN `mobile_in`. Ten digits, 6-9 leading, no country code. */
export const MOBILE_IN = /^[6-9][0-9]{9}$/;

export const mobile = z
  .string()
  .regex(MOBILE_IN, 'An Indian mobile number is ten digits starting 6-9.')
  .describe('Ten-digit Indian mobile number without the country code, e.g. `9820012345`.');

export const email = z
  .email()
  .max(255)
  .describe('Email address. Stored CITEXT, so lookups and uniqueness are case-insensitive.');

/**
 * 10-character minimum, no composition rules.
 *
 * NIST SP 800-63B §5.1.1.2 is explicit that composition rules ("one symbol, one
 * digit") push users towards predictable substitutions and are counter-
 * productive. Length is the control that actually works, and argon2id
 * (`auth/password.ts`) is what makes the remaining search space expensive.
 */
export const password = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(256, 'Passwords longer than 256 characters are rejected to bound hashing cost.')
  .describe('Plaintext password, 10–256 characters. Hashed with argon2id (m=19456, t=2, p=1) at rest.');

export const otpCode = z
  .string()
  .regex(/^[0-9]{6}$/, 'The code is six digits.')
  .describe('The six-digit code from the SMS. Five wrong attempts burn the challenge.');

/**
 * Marketing consent. **Defaults to false, always** (03_schema.md assumption A10).
 *
 * A pre-ticked box is not consent under the DPDP Act, and a default of `true`
 * here would silently opt in every account created by the storefront's signup
 * form. The grant is recorded with a timestamp and a source in `activity_logs`
 * so the consent is evidenced rather than merely asserted.
 */
export const marketingOptIn = z
  .boolean()
  .default(false)
  .describe(
    'Opt in to marketing email/SMS. Defaults to **false** — consent is never pre-ticked (DPDP). ' +
      'Granting it writes a timestamped consent record.',
  );

/** Present on every login-shaped request so the guest basket survives sign-in. */
export const cartTokenField = z
  .string()
  .min(8)
  .max(255)
  .optional()
  .describe(
    'The guest cart handle to fold into the account on success. May also be sent as the ' +
      '`X-Cart-Token` header, which wins when both are present. Merge failures never fail the login.',
  );

/* ------------------------------------------------------------- requests */

export const signupBody = z.object({
  fullName: z.string().trim().min(2).max(120).describe('The customer’s name, as they want it on a parcel.'),
  email,
  mobile: mobile.optional().describe('Optional at signup; required before an order can be delivered.'),
  password,
  marketingOptIn,
  cartToken: cartTokenField,
});

export const loginBody = z.object({
  emailOrMobile: z.union([email, mobile]).describe('Email address or mobile number.'),
  password: z.string().min(1).max(256).describe('The plaintext password. Never logged — see `config/logger.ts` redaction.'),
  cartToken: cartTokenField,
});



export const forgotPasswordBody = z.object({
  email,
});

export const resetPasswordBody = z.object({
  token: z
    .string()
    .min(20)
    .max(400)
    .describe(
      'The single-use `oobCode` from the reset email. Firebase issues and stores it, so nothing ' +
        'reset-related lives in our database and a dump yields no usable reset link. Pass it ' +
        'through verbatim — the storefront reads it from the `?oobCode=` query parameter.',
    ),
  password,
});

/* ------------------------------------------------------------- responses */

export const customerSummary = z.object({
  id: z.uuid().describe('`customers.id`. This is the subject of every customer access token.'),
  fullName: z.string().nullable().describe('Display name, or null if never supplied.'),
  email: z.string().nullable().describe('Email address, or null on a mobile-only (OTP) account.'),
  mobile: z.string().nullable().describe('Ten-digit mobile, or null on an email-only account.'),
  emailVerified: z.boolean().describe('True once the address has been proven — today, by completing a password reset.'),
  mobileVerified: z.boolean().describe('True once an OTP for this number has been verified.'),
  marketingOptIn: z.boolean().describe('Marketing consent. False unless explicitly granted.'),
  whatsappOptIn: z.boolean().describe('WhatsApp messaging consent. False unless explicitly granted.'),
  hasPassword: z.boolean().describe('False on an OTP-only account — the storefront should offer “set a password”.'),
  createdAt: z.string().describe('ISO-8601 timestamp of account creation.'),
});

export const authSession = z.object({
  accessToken: z
    .string()
    .describe(
      'HS256 JWT, audience `customer`. Send it as `Authorization: Bearer <token>`. **Keep it in memory ' +
        'only** — never `localStorage`, which is XSS-lootable.',
    ),
  tokenType: z.literal('Bearer').describe('Always `Bearer`.'),
  expiresIn: z
    .number()
    .int()
    .describe('Seconds until `accessToken` expires. Refresh before it does via `POST /v1/auth/refresh`.'),
  customer: customerSummary.describe('The signed-in customer.'),
});

/* ---------------------------------------------------------- firebase auth */

export const firebaseSignInBody = z.object({
  idToken: z
    .string()
    .min(100)
    .max(4_096)
    .describe(
      'The Firebase ID token, from `await userCredential.user.getIdToken()` after ' +
        '`signInWithPhoneNumber(...).confirm(code)` completes on the client.\n\n' +
        'This is NOT the six-digit SMS code and never should be — the code is verified by Firebase, in ' +
        'the browser, and the server never sees it. Sending the raw code here would mean re-implementing ' +
        'the verification we moved to Firebase to be rid of.\n\n' +
        'Single use: exchange it once for an Achichiz session, then send the returned `accessToken` to ' +
        'every other endpoint. Firebase tokens are not accepted anywhere else in this API.',
    ),
  cartToken: cartTokenField,
});

export const firebaseSession = authSession.extend({
  isNewAccount: z
    .boolean()
    .describe(
      'True when this sign-in created the account. Route to onboarding on `true` — it is the only ' +
        'reliable signal, because a Firebase phone sign-in has no separate signup step.',
    ),
  linkedExistingAccount: z
    .boolean()
    .describe(
      'True when an existing customer gained Firebase as a new credential — someone who signed up by ' +
        'password or MSG91 OTP and has now used Firebase for the first time. Their orders and addresses ' +
        'are intact; nothing was migrated.',
    ),
});

export const acceptedResponse = z.object({
  status: z
    .literal('sent')
    .describe(
      'Always `sent`, whether or not an account exists for the address or number supplied. ' +
        'This endpoint is deliberately not an account-existence oracle.',
    ),
});

export const okStatusResponse = z.object({
  status: z.literal('ok').describe('The operation completed.'),
});

export type SignupBody = z.infer<typeof signupBody>;
export type LoginBody = z.infer<typeof loginBody>;

export type CustomerSummary = z.infer<typeof customerSummary>;
export type AuthSession = z.infer<typeof authSession>;
