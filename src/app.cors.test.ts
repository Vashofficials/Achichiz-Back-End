import { describe, expect, it } from 'vitest';
import { CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS } from './app.js';

/**
 * A guard for the one CORS mistake that cannot be caught anywhere else.
 *
 * `X-Cart-Token` identifies the anonymous basket, and the storefront sets it on
 * every cart request. It was absent from `allowedHeaders`, so browsers refused
 * to send those requests at all — no guest could add anything to a cart on the
 * live site.
 *
 * Nothing detected it. curl does not preflight, so every manual check passed.
 * The server-side tests drive the app directly, so they passed too. The failure
 * existed only in a browser, and only for a header the server never sees
 * because the browser declines to send it. That is the trap this file exists to
 * close: the list below is what the CLIENT sends, and it is asserted against
 * what the SERVER permits.
 *
 * When the storefront starts sending a new header, add it here first — the test
 * fails, and the reason it fails is written down.
 */

/**
 * Headers `Fron-End/src/api/client.ts` can attach to a request.
 *
 * Kept as a literal rather than imported: the two repositories deploy
 * separately, and the point is to state the contract the API promises to
 * browsers, not to mirror whatever the client happens to do this week.
 */
const HEADERS_THE_STOREFRONT_SENDS = [
  // Every JSON request body.
  'Content-Type',
  // Bearer access token on authenticated calls.
  'Authorization',
  // Money-moving POSTs, replayed on retry.
  'Idempotency-Key',
  // The anonymous cart handle. Omitting this breaks the basket entirely.
  'X-Cart-Token',
] as const;

const lower = (xs: readonly string[]): string[] => xs.map((h) => h.toLowerCase());

describe('CORS header contract', () => {
  it('permits every header the storefront client sends', () => {
    const permitted = lower(CORS_ALLOWED_HEADERS);
    const missing = HEADERS_THE_STOREFRONT_SENDS.filter((h) => !permitted.includes(h.toLowerCase()));

    expect(
      missing,
      `These headers are sent by the storefront but not allowed by CORS, so browsers ` +
        `will block the whole request: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('permits X-Cart-Token, without which the guest basket cannot work', () => {
    expect(lower(CORS_ALLOWED_HEADERS)).toContain('x-cart-token');
  });

  it('exposes X-Request-Id so a customer can quote it to support', () => {
    expect(lower(CORS_EXPOSED_HEADERS)).toContain('x-request-id');
  });

  it('does not allow a wildcard, which credentials mode forbids anyway', () => {
    // `credentials: true` plus `*` is rejected by every browser, and would be a
    // silent, total CORS failure rather than a loud configuration error.
    expect(CORS_ALLOWED_HEADERS as readonly string[]).not.toContain('*');
  });
});
