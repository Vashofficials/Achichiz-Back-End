import { describe, expect, it } from 'vitest';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { join } from 'node:path';
import {
  isFirebaseInitialised,
  missingCredentialsMessage,
  parseServiceAccount,
  resolveCredentialSource,
  SERVICE_ACCOUNT_FILENAME,
} from '../../config/firebase.js';
import {
  FIREBASE_TOKEN_REJECTED,
  mapFirebaseError,
  toVerifiedToken,
  verifyFirebaseIdToken,
} from './firebase-verify.js';

/**
 * Everything under test here is pure, so none of it needs a service-account key,
 * a network, or a Firebase project. That is not a convenience — the lazy
 * initialisation these tests pin down is the whole point of the module, and a
 * test that needed credentials could not check it.
 *
 * No real key material appears anywhere in this file.
 */

/** A `FirebaseAuthError`-shaped failure: an Error carrying `code`. */
const firebaseError = (code: string): Error => Object.assign(new Error(`Firebase: ${code}`), { code });

describe('mapFirebaseError — the mapping table', () => {
  it('maps an expired token to a 401 with firebase_token_expired', () => {
    const mapped = mapFirebaseError(firebaseError('auth/id-token-expired'));
    expect(mapped).not.toBeNull();
    expect(mapped?.status).toBe(401);
    expect(mapped?.code).toBe('firebase_token_expired');
  });

  it('maps a revoked token, a disabled user and a deleted user all to firebase_token_revoked', () => {
    // `checkRevoked` is what surfaces the last two: the signature is still good,
    // the account behind it is not.
    for (const code of ['auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found']) {
      expect(mapFirebaseError(firebaseError(code))?.code).toBe('firebase_token_revoked');
    }
  });

  it('maps argument-error and an invalid token to firebase_token_invalid', () => {
    // Firebase raises argument-error for malformed, wrongly signed, and
    // wrong-project tokens alike.
    for (const code of ['auth/argument-error', 'auth/invalid-id-token', 'auth/invalid-argument']) {
      expect(mapFirebaseError(firebaseError(code))?.code).toBe('firebase_token_invalid');
    }
  });

  it('maps the session-cookie twins the same way as their ID-token counterparts', () => {
    expect(mapFirebaseError(firebaseError('auth/session-cookie-expired'))?.code).toBe(
      'firebase_token_expired',
    );
    expect(mapFirebaseError(firebaseError('auth/session-cookie-revoked'))?.code).toBe(
      'firebase_token_revoked',
    );
  });

  it('reads the code off errorInfo when it is not on the error itself', () => {
    const wrapped = Object.assign(new Error('wrapped'), {
      errorInfo: { code: 'auth/id-token-expired', message: 'expired' },
    });
    expect(mapFirebaseError(wrapped)?.code).toBe('firebase_token_expired');
  });

  it('always uses status 401, never anything else', () => {
    const codes = ['auth/id-token-expired', 'auth/id-token-revoked', 'auth/argument-error'];
    expect(codes.map((c) => mapFirebaseError(firebaseError(c))?.status)).toEqual([401, 401, 401]);
  });
});

describe('mapFirebaseError — the passthrough that matters', () => {
  /**
   * A Google outage, an expired service-account key or a clock skew is OUR
   * failure. Folding it into a 401 tells a customer their credentials are wrong
   * and sends them to reset a password that was never the problem — and it hides
   * the outage behind a wall of ordinary-looking auth failures.
   */
  it('returns null for an unrecognised Firebase code, so the caller rethrows', () => {
    for (const code of [
      'auth/internal-error',
      'auth/network-request-failed',
      'auth/insufficient-permission',
      'auth/project-not-found',
      'app/invalid-credential',
    ]) {
      expect(mapFirebaseError(firebaseError(code))).toBeNull();
    }
  });

  it('returns null for an error carrying no code at all', () => {
    expect(mapFirebaseError(new Error('ECONNRESET'))).toBeNull();
    expect(mapFirebaseError(Object.assign(new Error('x'), { code: 500 }))).toBeNull();
  });

  it('returns null for non-error values rather than throwing on them', () => {
    for (const value of [null, undefined, 'auth/id-token-expired', 42, {}, []]) {
      expect(mapFirebaseError(value)).toBeNull();
    }
  });

  it('does not match a known code appearing as a substring', () => {
    expect(mapFirebaseError(firebaseError('x-auth/id-token-expired'))).toBeNull();
  });
});

describe('mapFirebaseError — one message, many codes', () => {
  const cases = [
    ['auth/id-token-expired', 'firebase_token_expired'],
    ['auth/id-token-revoked', 'firebase_token_revoked'],
    ['auth/user-disabled', 'firebase_token_revoked'],
    ['auth/argument-error', 'firebase_token_invalid'],
  ] as const;

  it('gives every rejection the identical user-visible message', () => {
    // This endpoint is unauthenticated. A body that says "expired" rather than
    // "invalid" is a free oracle for anyone replaying captured tokens.
    const messages = new Set(cases.map(([code]) => mapFirebaseError(firebaseError(code))?.message));
    expect(messages.size).toBe(1);
    expect([...messages][0]).toBe(FIREBASE_TOKEN_REJECTED);
  });

  it('still distinguishes them by stable code, for logs and for the frontend', () => {
    for (const [firebaseCode, ourCode] of cases) {
      expect(mapFirebaseError(firebaseError(firebaseCode))?.code).toBe(ourCode);
    }
    const distinct = new Set(cases.map(([code]) => mapFirebaseError(firebaseError(code))?.code));
    expect(distinct.size).toBe(3);
  });

  it('never leaks the Firebase code or message into the client-visible text', () => {
    const mapped = mapFirebaseError(firebaseError('auth/id-token-expired'));
    expect(mapped?.message).not.toContain('auth/');
    expect(mapped?.message).not.toContain('expired');
  });
});

describe('resolveCredentialSource — precedence', () => {
  const CWD = '/srv/achichiz';
  const cwdFile = join(CWD, SERVICE_ACCOUNT_FILENAME);

  it('prefers the inline JSON variable — the deploy needs no file', () => {
    const source = resolveCredentialSource(
      {
        FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"achichiz-in"}',
        FIREBASE_SERVICE_ACCOUNT_PATH: '/etc/secrets/key.json',
      },
      true,
      CWD,
    );
    expect(source).toEqual({
      kind: 'inline',
      origin: 'FIREBASE_SERVICE_ACCOUNT_JSON',
      json: '{"project_id":"achichiz-in"}',
    });
  });

  it('falls back to the explicit path when there is no inline JSON', () => {
    const source = resolveCredentialSource({ FIREBASE_SERVICE_ACCOUNT_PATH: '/etc/secrets/key.json' }, true, CWD);
    expect(source).toEqual({
      kind: 'file',
      origin: 'FIREBASE_SERVICE_ACCOUNT_PATH',
      path: '/etc/secrets/key.json',
    });
  });

  it('falls back to the working-directory file last — current dev behaviour', () => {
    expect(resolveCredentialSource({}, true, CWD)).toEqual({ kind: 'file', origin: 'cwd', path: cwdFile });
  });

  it('reports none when nothing is configured, rather than guessing a path', () => {
    expect(resolveCredentialSource({}, false, CWD)).toEqual({ kind: 'none' });
  });

  it('treats blank and whitespace-only variables as unset', () => {
    // An empty value in a .env or a systemd unit is a variable someone meant to
    // fill in, not a credential.
    const source = resolveCredentialSource(
      { FIREBASE_SERVICE_ACCOUNT_JSON: '   ', FIREBASE_SERVICE_ACCOUNT_PATH: '' },
      false,
      CWD,
    );
    expect(source).toEqual({ kind: 'none' });
  });

  it('trims a path that arrived with stray whitespace', () => {
    const source = resolveCredentialSource({ FIREBASE_SERVICE_ACCOUNT_PATH: '  /etc/key.json  ' }, false, CWD);
    expect(source).toEqual({ kind: 'file', origin: 'FIREBASE_SERVICE_ACCOUNT_PATH', path: '/etc/key.json' });
  });
});

describe('missingCredentialsMessage', () => {
  it('names all three options and where the file would go', () => {
    const message = missingCredentialsMessage('/srv/achichiz');
    expect(message).toContain('FIREBASE_SERVICE_ACCOUNT_JSON');
    expect(message).toContain('FIREBASE_SERVICE_ACCOUNT_PATH');
    expect(message).toContain(SERVICE_ACCOUNT_FILENAME);
    expect(message).toContain('/srv/achichiz');
  });
});

describe('parseServiceAccount', () => {
  // Structurally a key, cryptographically nothing. No real credential here.
  const KEY = JSON.stringify({
    type: 'service_account',
    project_id: 'achichiz-in',
    client_email: 'sa@achichiz-in.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\\nNOTAKEY\\n-----END PRIVATE KEY-----\\n',
  });

  it('reads the three fields cert() needs', () => {
    const account = parseServiceAccount(KEY, 'FIREBASE_SERVICE_ACCOUNT_JSON');
    expect(account.projectId).toBe('achichiz-in');
    expect(account.clientEmail).toBe('sa@achichiz-in.iam.gserviceaccount.com');
  });

  it('un-escapes the newlines an environment variable mangles', () => {
    // Shells, systemd units and CI secret stores all deliver \n literally, and
    // cert() then dies with an opaque PEM error.
    expect(parseServiceAccount(KEY, 'env').privateKey).toContain('\n');
    expect(parseServiceAccount(KEY, 'env').privateKey).not.toContain('\\n');
  });

  it('names the origin, and never the contents, when the JSON is broken', () => {
    expect(() => parseServiceAccount('{not json', 'FIREBASE_SERVICE_ACCOUNT_JSON')).toThrow(
      /FIREBASE_SERVICE_ACCOUNT_JSON/,
    );
  });

  it('says which fields are missing rather than failing inside the crypto layer', () => {
    expect(() => parseServiceAccount('{"project_id":"achichiz-in"}', 'env')).toThrow(
      /client_email, private_key/,
    );
  });

  it('never echoes the private key in an error', () => {
    const partial = JSON.stringify({ private_key: 'SUPER-SECRET-VALUE' });
    expect(() => parseServiceAccount(partial, 'env')).toThrow();
    try {
      parseServiceAccount(partial, 'env');
    } catch (err) {
      expect((err as Error).message).not.toContain('SUPER-SECRET-VALUE');
    }
  });
});

describe('toVerifiedToken', () => {
  const decoded: DecodedIdToken = {
    aud: 'achichiz-in',
    auth_time: 1_700_000_000,
    exp: 1_700_003_600,
    firebase: { identities: { phone: ['+919876543210'] }, sign_in_provider: 'phone' },
    iat: 1_700_000_000,
    iss: 'https://securetoken.google.com/achichiz-in',
    phone_number: '+919876543210',
    sub: 'FIREBASEUID0000000000000001',
    uid: 'FIREBASEUID0000000000000001',
  };

  it('projects the claims we keep, converting seconds to Dates', () => {
    expect(toVerifiedToken(decoded)).toEqual({
      uid: 'FIREBASEUID0000000000000001',
      phoneNumber: '+919876543210',
      email: null,
      emailVerified: false,
      signInProvider: 'phone',
      issuedAt: new Date(1_700_000_000_000),
      expiresAt: new Date(1_700_003_600_000),
    });
  });

  it('treats a missing email_verified claim as NOT verified', () => {
    // Firebase will mint a token carrying an arbitrary unverified email. Only an
    // explicit `true` may ever be used to match an existing account.
    const withEmail: DecodedIdToken = { ...decoded, email: 'someone@example.com' };
    expect(toVerifiedToken(withEmail).emailVerified).toBe(false);
    expect(toVerifiedToken({ ...withEmail, email_verified: true }).emailVerified).toBe(true);
  });

  it('nulls a phone number that a non-phone provider does not carry', () => {
    const google: DecodedIdToken = {
      ...decoded,
      phone_number: undefined,
      firebase: { identities: {}, sign_in_provider: 'google.com' },
    };
    expect(toVerifiedToken(google).phoneNumber).toBeNull();
    expect(toVerifiedToken(google).signInProvider).toBe('google.com');
  });
});

describe('laziness — the regression this module exists to prevent', () => {
  /**
   * The old `config/firebase.ts` read the key file and called `initializeApp` at
   * module top level, so importing the route graph crashed on any machine without
   * a key — including the CI box that runs `openapi:generate`.
   */
  it('has not initialised Firebase merely by being imported', () => {
    expect(isFirebaseInitialised()).toBe(false);
  });

  it('does not initialise Firebase to map an error', () => {
    mapFirebaseError(firebaseError('auth/id-token-expired'));
    expect(isFirebaseInitialised()).toBe(false);
  });

  it('rejects a blank token without reaching Firebase at all', async () => {
    await expect(verifyFirebaseIdToken('   ')).rejects.toMatchObject({
      status: 401,
      code: 'firebase_token_invalid',
      message: FIREBASE_TOKEN_REJECTED,
    });
    expect(isFirebaseInitialised()).toBe(false);
  });
});
