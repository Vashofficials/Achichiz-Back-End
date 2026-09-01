import { env } from '../../config/env.js';

/**
 * The URL a staff member follows to set a password.
 *
 * One builder for both the password reset and the invite, because they land on
 * the SAME page: `resetPassword` flips an `invited` account to `active` the
 * moment it has a password, so "accept your invite" and "reset your password"
 * are the same operation with different copy.
 *
 * The panel reads `token` and `email` from the query string and renders
 * "This reset link is missing its token" without them, so both are required —
 * emailing the bare token, which is what used to happen, gave the recipient a
 * random string and nowhere to put it.
 *
 * `encodeURIComponent` on both: the token is base64url (safe by construction,
 * encoded anyway so a future change of encoding cannot silently break it) and
 * an email address can legally contain `+` and `&`.
 */
export function resetLink(email: string, token: string): string {
  const query = new URLSearchParams({ token, email });
  return `${env.ADMIN_PANEL_URL}/reset-password?${query.toString()}`;
}
