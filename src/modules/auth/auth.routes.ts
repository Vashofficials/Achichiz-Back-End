import { Router } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { accepted, created, noContent, ok } from '../../lib/http.js';
import * as auth from './auth.service.js';
import * as firebaseAuth from './firebase-auth.service.js';
import {
  acceptedResponse,
  authSession,
  customerSummary,
  firebaseSession,
  firebaseSignInBody,
  forgotPasswordBody,
  loginBody,
  okStatusResponse,
  otpRequestBody,
  otpVerifyBody,
  resetPasswordBody,
  signupBody,
} from './auth.schemas.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-token.js';

/**
 * Customer authentication.
 *
 * Everything here is `auth: 'public'` except `GET /v1/auth/me`, which is the one
 * operation that by definition needs a token to answer at all. `logout` and
 * `logout-everywhere` are public on purpose: they are authenticated by the
 * refresh **cookie**, which is a credential in its own right and — unlike the
 * 15-minute access token — is still valid when a customer comes back to sign out
 * an hour later.
 *
 * ## The refresh cookie
 *
 * Successful sign-in sets `ach_rt`: httpOnly, `SameSite=Lax`, `Secure` outside
 * development, scoped to `Path=/v1/auth`. It is **not** echoed in the response
 * body, and there is no endpoint that will read it back to you. That is the whole
 * point — a token JavaScript can read is a token XSS can steal, which is the
 * standing weakness in the storefront's current Supabase-token-in-`localStorage`
 * arrangement.
 *
 * The access token in the body is short-lived and belongs in memory only.
 */
export const authRouter: Router = Router();

const CREDENTIAL_NOTE =
  'Rate-limited to 10 attempts per 15 minutes per IP. ' +
  'Failure responses are deliberately identical whether or not an account exists.';

const COOKIE_NOTE =
  'On success a rotating opaque refresh token is set as the httpOnly `ach_rt` cookie ' +
  '(`Path=/v1/auth`). Send credentialed requests (`fetch(..., { credentials: "include" })`) so it ' +
  'travels. It is never present in the response body.';

defineRoute(authRouter, {
  method: 'post',
  path: '/v1/auth/signup',
  surface: 'storefront',
  operationId: 'signup',
  summary: 'Create a customer account',
  description:
    'Creates the account, signs it in and folds any guest cart into it in one call. ' +
    '`marketingOptIn` defaults to **false** and is never inferred — a granted consent is recorded ' +
    'with its timestamp and source, which is what makes it defensible under the DPDP Act. ' +
    'An email or mobile already in use returns 409 rather than failing silently. ' +
    `${COOKIE_NOTE} ${CREDENTIAL_NOTE}`,
  tags: ['Auth'],
  auth: 'public',
  rateLimit: 'auth',
  request: { body: signupBody },
  responses: {
    201: { description: 'Account created and signed in.', schema: authSession },
    409: { description: 'That email address or mobile number already has an account.' },
  },
  handler: async ({ body, req, res }) => {
    const issued = await auth.signup(
      { ...body, cartToken: auth.cartTokenOf(req, body.cartToken) },
      auth.requestFingerprint(req),
    );
    setRefreshCookie(res, issued.refreshToken);
    return created(issued.session);
  },
});

defineRoute(authRouter, {
  method: 'post',
  path: '/v1/auth/login',
  surface: 'storefront',
  operationId: 'login',
  summary: 'Sign in with email and password',
  description:
    'The secondary login path — mobile + OTP is primary for Indian D2C, and this exists for corporate ' +
    'buyers and for accounts migrated from Supabase Auth. Those migrated accounts keep their original ' +
    'bcrypt password: it is verified as bcrypt and transparently re-hashed to argon2id on this login, ' +
    'so **no migrated customer is ever forced to reset**. ' +
    'Any failure — unknown address, wrong password, OTP-only account, blocked account — returns the ' +
    'same 401 with the same message, and costs the same amount of time. ' +
    `${COOKIE_NOTE} ${CREDENTIAL_NOTE}`,
  tags: ['Auth'],
  auth: 'public',
  rateLimit: 'auth',
  request: { body: loginBody },
  responses: {
    200: { description: 'Signed in.', schema: authSession },
    401: { description: 'Those credentials are not valid. The body never says which part was wrong.' },
  },
  handler: async ({ body, req, res }) => {
    const issued = await auth.login(
      { ...body, cartToken: auth.cartTokenOf(req, body.cartToken) },
      auth.requestFingerprint(req),
    );
    setRefreshCookie(res, issued.refreshToken);
    return ok(issued.session);
  },
});

defineRoute(authRouter, {
  method: 'post',
  path: '/v1/auth/otp/request',
  surface: 'storefront',
  operationId: 'requestLoginOtp',
  summary: 'Send a login OTP to a mobile number',
  description:
    'The primary login path. A six-digit code, valid for five minutes, argon2id-hashed at rest, five ' +
    'verification attempts, three sends per hour per number on top of the IP rate limit. ' +
    '\n\n' +
    'The response is `{ "status": "sent" }` **always** — for a number with an account, a number without ' +
    'one, and a number that has hit its send throttle. There is no signup step: verifying a code on an ' +
    'unknown number creates the account. ' +
    '\n\n' +
    'Delivery goes through MSG91, which requires a TRAI DLT-registered template; until that paperwork ' +
    'clears the dev sender logs the code instead of sending it.',
  tags: ['Auth'],
  auth: 'public',
  rateLimit: 'otp',
  request: { body: otpRequestBody },
  responses: {
    202: { description: 'A code has been sent, if that number was eligible for one.', schema: acceptedResponse },
    429: { description: 'Too many OTP requests from this IP.' },
  },
  handler: async ({ body }) => {
    await auth.requestLoginOtp(body.mobile);
    return accepted({ status: 'sent' });
  },
});

defineRoute(authRouter, {
  method: 'post',
  path: '/v1/auth/otp/verify',
  surface: 'storefront',
  operationId: 'verifyLoginOtp',
  summary: 'Verify a login OTP and sign in',
  description:
    'Verifies the newest unconsumed code for that number. A correct code signs the customer in, marks ' +
    'the mobile verified, and — when the number has no account yet — creates one on the spot with ' +
    '`fullName` if supplied. The code is single-use: it is consumed before the session is issued. ' +
    '\n\n' +
    'Wrong codes increment an attempt counter and burn the challenge after five. Expired, exhausted and ' +
    'simply-wrong all return 422 `otp_invalid` so the response cannot be used to probe which. ' +
    `${COOKIE_NOTE}`,
  tags: ['Auth'],
  auth: 'public',
  rateLimit: 'auth',
  request: { body: otpVerifyBody },
  responses: {
    200: { description: 'Signed in.', schema: authSession },
    422: { description: 'The code is wrong, expired, or its attempts are exhausted.' },
  },
  handler: async ({ body, req, res }) => {
    const issued = await auth.verifyLoginOtp(
      { ...body, cartToken: auth.cartTokenOf(req, body.cartToken) },
      auth.requestFingerprint(req),
    );
    setRefreshCookie(res, issued.refreshToken);
    return ok(issued.session);
  },
});

defineRoute(authRouter, {
  method: 'post',
  path: '/v1/auth/firebase',
  surface: 'storefront',
  operationId: 'signInWithFirebase',
  summary: 'Exchange a Firebase ID token for a session',
  description:
    '**The primary login path.** Firebase sends the SMS and verifies the six-digit code in the browser; ' +
    'this endpoint verifies the ID token that results and exchanges it for an Achichiz session.\n\n' +
    'The server never sees the OTP. Its expiry, attempt counter and rate limits are Google\'s, which is ' +
    'the reason for moving off MSG91 — the whole class of bugs around hashing and throttling our own ' +
    'codes goes with them.\n\n' +
    '**Client flow**\n\n' +
    '```js\n' +
    'const conf = await signInWithPhoneNumber(auth, "+91" + mobile, recaptcha);\n' +
    'const cred = await conf.confirm(code);\n' +
    'const idToken = await cred.user.getIdToken();\n' +
    'await fetch("/v1/auth/firebase", {\n' +
    '  method: "POST", credentials: "include",\n' +
    '  headers: { "Content-Type": "application/json" },\n' +
    '  body: JSON.stringify({ idToken }),\n' +
    '});\n' +
    '```\n\n' +
    '**How the account is resolved**, in order: a known `firebase_uid` signs in; otherwise a matching ' +
    'mobile links Firebase to that existing account; otherwise a matching **verified** email links; ' +
    'otherwise a new account is created. An **unverified** email never matches — Firebase will mint a ' +
    'token carrying a self-asserted address, and linking on one would let anyone who types a known ' +
    'email inherit that customer\'s orders and addresses. It falls through to creating a new account ' +
    'instead, because a duplicate is an annoyance and a takeover is not.\n\n' +
    'Every outcome — including refusals — is recorded in `customer_auth_events`.\n\n' +
    'The returned `accessToken` is what every other endpoint accepts. A Firebase token is accepted ' +
    'here and nowhere else. ' +
    `${COOKIE_NOTE}`,
  tags: ['Auth'],
  auth: 'public',
  rateLimit: 'auth',
  request: { body: firebaseSignInBody },
  responses: {
    200: { description: 'Signed in.', schema: firebaseSession },
    401: {
      description:
        'The Firebase token is expired, revoked or malformed — one message for all three, the detail ' +
        'is in the stable `code`. Also returned for a suspended account.',
    },
    422: {
      description:
        'The token is valid but unusable: no phone or email (`firebase_no_identifier`), a non-Indian ' +
        'number (`firebase_unusable_phone`), or the number already belongs to a different sign-in ' +
        '(`firebase_uid_conflict`).',
    },
  },
  handler: async ({ body, req, res }) => {
    const result = await firebaseAuth.resolveFirebaseSignIn(
      body.idToken,
      firebaseAuth.fingerprintOf(req),
    );
    const issued = await auth.issueSessionForCustomer(
      result.customer,
      auth.cartTokenOf(req, body.cartToken),
      auth.requestFingerprint(req),
    );
    setRefreshCookie(res, issued.refreshToken);
    return ok({
      ...issued.session,
      isNewAccount: result.isNewAccount,
      linkedExistingAccount: result.outcome === 'linked',
    });
  },
});

defineRoute(authRouter, {
  method: 'post',
  path: '/v1/auth/refresh',
  surface: 'storefront',
  operationId: 'refreshSession',
  summary: 'Exchange the refresh cookie for a new access token',
  description:
    'Reads the `ach_rt` cookie, issues a new access token, and **rotates the refresh token** — the old ' +
    'one stops working the instant this returns. There is no request body; the token is not accepted ' +
    'anywhere a script could have put it.' +
    '\n\n' +
    '**Reuse detection.** Presenting a refresh token that has already been exchanged means two parties ' +
    'hold that session, so the entire session family is revoked immediately — in the database and on ' +
    'the Redis access-token denylist — a security event is logged, and the customer must sign in again. ' +
    'A client that retries a refresh whose response it lost will trip this; that is the accepted cost ' +
    'of rotation being worth anything at all.' +
    '\n\n' +
    'Call it on a timer slightly inside `expiresIn`, and once on a 401.',
  tags: ['Auth'],
  auth: 'public',
  // NOT the `auth` limiter (10 per 15 min per IP): a legitimate SPA refreshes
  // every ~14 minutes, and a household or office behind one NAT would exhaust
  // that budget while doing nothing wrong. `default` is 120/min, which still
  // stops a replay flood.
  rateLimit: 'default',
  responses: {
    200: { description: 'A new access token, and a rotated refresh cookie.', schema: authSession },
    401: { description: 'No cookie, an expired session, or a token that had already been spent.' },
  },
  handler: async ({ req, res }) => {
    const issued = await auth.refresh(readRefreshCookie(req), auth.requestFingerprint(req));
    setRefreshCookie(res, issued.refreshToken);
    return ok(issued.session);
  },
});

defineRoute(authRouter, {
  method: 'post',
  path: '/v1/auth/logout',
  surface: 'storefront',
  operationId: 'logout',
  summary: 'Sign out of this device',
  description:
    'Revokes the session behind the `ach_rt` cookie and clears it. The outstanding access token is ' +
    'denylisted, so it stops working immediately rather than at its next expiry. ' +
    'Idempotent and always 204 — a missing or unknown cookie is not an error, and reporting one would ' +
    'tell a caller whether the token it holds is real.',
  tags: ['Auth'],
  auth: 'public',
  rateLimit: 'default',
  responses: {
    204: { description: 'Signed out.' },
    429: { description: 'Too many requests.' },
  },
  handler: async ({ req, res }) => {
    await auth.logout(readRefreshCookie(req));
    clearRefreshCookie(res);
    return noContent();
  },
});

defineRoute(authRouter, {
  method: 'post',
  path: '/v1/auth/logout-all',
  surface: 'storefront',
  operationId: 'logoutEverywhere',
  summary: 'Sign out of every device',
  description:
    'Revokes every live session for the customer identified by the `ach_rt` cookie, denylists all of ' +
    'their access tokens, and clears this device’s cookie. Use it from the “sign out everywhere” ' +
    'control, and after any credential scare. ' +
    'Authenticated by the refresh cookie rather than a Bearer token, because the access token has ' +
    'usually expired by the time somebody reaches for this.',
  tags: ['Auth'],
  auth: 'public',
  rateLimit: 'default',
  responses: {
    204: { description: 'Every session revoked.' },
    429: { description: 'Too many requests.' },
  },
  handler: async ({ req, res }) => {
    await auth.logoutEverywhere(readRefreshCookie(req));
    clearRefreshCookie(res);
    return noContent();
  },
});

defineRoute(authRouter, {
  method: 'post',
  path: '/v1/auth/forgot-password',
  surface: 'storefront',
  operationId: 'requestPasswordReset',
  summary: 'Request a password-reset email',
  description:
    'Always returns `{ "status": "sent" }`, for a known address and an unknown one alike. Anything else ' +
    'turns this endpoint into a free customer-list validator. ' +
    '\n\n' +
    'When the address does have an account, a single-use token valid for 30 minutes is emailed. Only an ' +
    'argon2id hash of it is stored, so a database dump yields no usable reset links. ' +
    `${CREDENTIAL_NOTE}`,
  tags: ['Auth'],
  auth: 'public',
  rateLimit: 'auth',
  request: { body: forgotPasswordBody },
  responses: {
    202: { description: 'An email has been sent, if that address has an account.', schema: acceptedResponse },
    429: { description: 'Too many requests from this IP.' },
  },
  handler: async ({ body }) => {
    await auth.forgotPassword(body.email);
    return accepted({ status: 'sent' });
  },
});

defineRoute(authRouter, {
  method: 'post',
  path: '/v1/auth/reset-password',
  surface: 'storefront',
  operationId: 'resetPassword',
  summary: 'Complete a password reset',
  description:
    'Consumes the emailed token and sets the new password (argon2id). The token carries its own ' +
    'challenge id, so no email address is re-submitted here. ' +
    '\n\n' +
    '**Every session is revoked**, on every device. If the reset was prompted by a leak, leaving the ' +
    'attacker’s refresh token alive would make the reset decorative. The customer signs in again ' +
    'afterwards. Completing a reset also marks the email address verified — the loop proves the mailbox.',
  tags: ['Auth'],
  auth: 'public',
  rateLimit: 'auth',
  request: { body: resetPasswordBody },
  responses: {
    200: { description: 'The password has been changed. Sign in again.', schema: okStatusResponse },
    422: { description: 'The token is unknown, already used, or expired.' },
  },
  handler: async ({ body, res }) => {
    await auth.resetPassword(body.token, body.password);
    clearRefreshCookie(res);
    return ok({ status: 'ok' });
  },
});

defineRoute(authRouter, {
  method: 'get',
  path: '/v1/auth/me',
  surface: 'storefront',
  operationId: 'getCurrentCustomer',
  summary: 'Who am I',
  description:
    'The signed-in customer, resolved from the access token. Replaces the storefront’s ' +
    '`supabase.auth.getSession()` polling with a single authoritative read. ' +
    '\n\n' +
    'The one endpoint in this module that requires a Bearer token — it has no other way to answer. ' +
    'A 401 here means "refresh, then retry", not "show the login page".',
  tags: ['Auth'],
  auth: 'customer',
  responses: {
    200: { description: 'The signed-in customer.', schema: customerSummary },
    401: { description: 'Missing, expired or revoked access token.' },
  },
  handler: async ({ auth: session }) => ok(await auth.currentCustomer(session.customerId)),
});
