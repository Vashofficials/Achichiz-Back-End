import { describe, expect, it, vi, afterEach } from 'vitest';
import type * as EmailModuleTypes from './index.js';

/**
 * Which sender gets picked, and what it does with a failure.
 *
 * The bug this replaces was entirely in the SELECTION: having AWS credentials —
 * for S3 media uploads, nothing to do with mail — chose an unimplemented SES
 * sender that rejected every send, and the callers' deliberate swallow meant
 * nobody found out. So the selection rules are asserted directly, including the
 * case that used to be broken.
 */

const sendMail = vi.fn();
// Typed with the options parameter so `mock.calls[0][0]` is a real tuple slot —
// without it vi.fn() infers a zero-arg signature and the assertions below
// cannot index the recorded arguments.
const createTransport = vi.fn((_options: Record<string, unknown>) => ({ sendMail }));

type EmailModule = typeof EmailModuleTypes;

async function load(overrides: Record<string, unknown>): Promise<EmailModule> {
  vi.resetModules();
  sendMail.mockReset();
  createTransport.mockClear();
  vi.doMock('nodemailer', () => ({ createTransport }));
  // The real logger builds pino from env at import time and would need the whole
  // env shape; this file is about sender selection, not logging.
  vi.doMock('../../config/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
  vi.doMock('../../config/env.js', () => ({
    env: {
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: 465,
      SMTP_USER: '',
      SMTP_PASSWORD: '',
      EMAIL_FROM: 'Achichiz <founder@achichiz.in>',
      isProduction: false,
      ...overrides,
    },
  }));
  return import('./index.js');
}

const CONFIGURED = { SMTP_USER: 'founder@achichiz.in', SMTP_PASSWORD: 'app-password', isProduction: true };

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('nodemailer');
  vi.doUnmock('../../config/logger.js');
  vi.doUnmock('../../config/env.js');
});

describe('sender selection', () => {
  it('uses SMTP when the mail credentials are set', async () => {
    const { emailSender } = await load(CONFIGURED);
    sendMail.mockResolvedValue({ messageId: '<abc@gmail>' });

    const result = await emailSender.send({ to: 'a@b.co', subject: 's', text: 't' });
    expect(result.provider).toBe('smtp');
    expect(result.delivered).toBe(true);
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('does NOT deliver when SMTP is unconfigured, even in production', async () => {
    const { emailSender } = await load({ isProduction: true });
    const result = await emailSender.send({ to: 'a@b.co', subject: 's', text: 't' });

    expect(result.provider).toBe('dev-noop');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('AWS credentials no longer influence the choice — that was the whole bug', async () => {
    // S3 keys exist for media uploads. They must not select a mail sender.
    const { emailSender } = await load({ isProduction: true, AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE' });
    const result = await emailSender.send({ to: 'a@b.co', subject: 's', text: 't' });

    expect(result.provider).toBe('dev-noop');
  });
});

describe('smtp sender', () => {
  it('builds ONE transporter and reuses it across sends', async () => {
    const { emailSender } = await load(CONFIGURED);
    sendMail.mockResolvedValue({ messageId: '<x>' });

    await emailSender.send({ to: 'a@b.co', subject: 's', text: 't' });
    await emailSender.send({ to: 'c@d.co', subject: 's', text: 't' });

    // A transporter per send opens a TLS handshake per password reset.
    expect(createTransport).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('uses implicit TLS on 465 and STARTTLS on 587', async () => {
    // `load` resets sendMail, so arm it AFTER each load or the send throws on
    // reading messageId off undefined.
    const on = async (port: number): Promise<unknown> => {
      const { emailSender } = await load({ ...CONFIGURED, SMTP_PORT: port });
      sendMail.mockResolvedValue({ messageId: '<x>' });
      await emailSender.send({ to: 'a@b.co', subject: 's', text: 't' });
      return createTransport.mock.calls[0]?.[0];
    };

    expect(await on(465)).toMatchObject({ port: 465, secure: true });
    expect(await on(587)).toMatchObject({ port: 587, secure: false });
  });

  it('falls back to EMAIL_FROM but lets a caller override it', async () => {
    const { emailSender } = await load(CONFIGURED);
    sendMail.mockResolvedValue({ messageId: '<x>' });

    await emailSender.send({ to: 'a@b.co', subject: 's', text: 't' });
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({ from: 'Achichiz <founder@achichiz.in>' });

    await emailSender.send({ to: 'a@b.co', subject: 's', text: 't', from: 'leads@achichiz.in' });
    expect(sendMail.mock.calls[1]?.[0]).toMatchObject({ from: 'leads@achichiz.in' });
  });

  it('rethrows a send failure so callers can decide, rather than reporting success', async () => {
    const { emailSender } = await load(CONFIGURED);
    sendMail.mockRejectedValue(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }));

    await expect(emailSender.send({ to: 'a@b.co', subject: 's', text: 't' })).rejects.toThrow(
      /Email could not be sent/,
    );
  });

  it('preserves the underlying error as `cause`, which the diagnostic reads', async () => {
    const { emailSender } = await load(CONFIGURED);
    const original = Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
    sendMail.mockRejectedValue(original);

    const err = await emailSender.send({ to: 'a@b.co', subject: 's', text: 't' }).catch((e: unknown) => e);
    expect((err as { cause?: unknown }).cause).toBe(original);
  });
});

describe('maskEmail', () => {
  it('hides the local part in logs', async () => {
    const { maskEmail } = await load({});
    expect(maskEmail('arjun.mehta@example.com')).toBe('a•••••a@example.com');
    expect(maskEmail('not-an-email')).toBe('•••');
  });
});
