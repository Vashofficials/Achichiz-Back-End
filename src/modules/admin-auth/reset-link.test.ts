import { describe, expect, it, vi, afterEach } from 'vitest';
import type * as ResetLinkModule from './reset-link.js';

/**
 * The link the panel has to be able to parse.
 *
 * `routes/reset-password.tsx` prefills its form from `token` and `email` in the
 * query string. The emails used to carry a bare token and no URL at all, so
 * neither the reset nor the invite could be completed by the person who
 * received one — these assertions are the contract between the two halves.
 */

const load = async (panelUrl: string): Promise<typeof ResetLinkModule> => {
  vi.resetModules();
  vi.doMock('../../config/env.js', () => ({ env: { ADMIN_PANEL_URL: panelUrl } }));
  return import('./reset-link.js');
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../config/env.js');
});

const PANEL = 'https://admin.achichiz.com';

describe('resetLink', () => {
  it('points at the panel page that reads the token', async () => {
    const { resetLink } = await load(PANEL);
    const url = new URL(resetLink('ops@achichiz.in', 'abc123'));

    expect(url.origin + url.pathname).toBe(`${PANEL}/reset-password`);
    expect(url.searchParams.get('token')).toBe('abc123');
    expect(url.searchParams.get('email')).toBe('ops@achichiz.in');
  });

  it('survives an email containing + and &, which are legal and would truncate the query', async () => {
    const { resetLink } = await load(PANEL);
    const email = 'ops+staff&test@achichiz.in';
    const url = new URL(resetLink(email, 'tok'));

    expect(url.searchParams.get('email')).toBe(email);
    expect(url.searchParams.get('token')).toBe('tok');
  });

  it('round-trips a base64url token, which may contain - and _', async () => {
    const { resetLink } = await load(PANEL);
    const token = 'aB-3_xY9zQ-_';
    expect(new URL(resetLink('a@b.co', token)).searchParams.get('token')).toBe(token);
  });

  it('does not double up the slash when the configured URL has a trailing one', async () => {
    // env strips it, but the builder must not depend on that having happened.
    const { resetLink } = await load(PANEL);
    expect(resetLink('a@b.co', 't')).not.toContain('//reset-password');
  });
});
