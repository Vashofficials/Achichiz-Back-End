import { createTransport, type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { UpstreamError } from '../../lib/errors.js';

/**
 * Transactional email, behind a local interface.
 *
 * Delivery is Gmail / Google Workspace over SMTP. SES was the original plan and
 * sat unimplemented for the whole life of the project, which meant every
 * password reset and staff invite produced a valid token and silently sent
 * nothing — the flows looked fine because callers swallow send failures on
 * purpose, so an outage cannot reveal which accounts exist.
 *
 * The vendor stays behind this interface so that swap is a one-line change in
 * `createEmailSender`, and so tests can substitute a fake with `setEmailSender`
 * rather than talking to a mail server.
 *
 * Marketing email must NOT go through this sender. A campaign complaint spike on
 * a shared sender poisons order-confirmation deliverability; keep it on a
 * separate subdomain with a separate reputation.
 */

export type EmailAddress = string;

export type EmailMessage = {
  to: EmailAddress | EmailAddress[];
  subject: string;
  /** Plain-text body. Always populate it — some clients render nothing else. */
  text: string;
  html?: string;
  replyTo?: EmailAddress;
  /** Overrides `EMAIL_FROM`. Use for the leads inbox sender, not for marketing. */
  from?: EmailAddress;
};

export type EmailResult = {
  delivered: boolean;
  provider: 'smtp' | 'ses' | 'dev-noop';
  providerMessageId: string | null;
};

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailResult>;
}

/** `arjun.mehta@example.com` → `a•••••a@example.com`. */
export const maskEmail = (email: string): string => {
  const at = email.indexOf('@');
  if (at < 1) return '•••';
  const local = email.slice(0, at);
  const head = local.slice(0, 1);
  const tail = local.length > 1 ? local.slice(-1) : '';
  return `${head}•••••${tail}${email.slice(at)}`;
};

const recipients = (to: EmailMessage['to']): string[] => (Array.isArray(to) ? to : [to]);

/** Built once and reused; see createSmtpEmailSender. */
let transporter: Transporter | null = null;

/**
 * Development / test implementation. Logs the subject and a masked recipient.
 *
 * The body is logged at debug level only: password-reset emails carry a
 * single-use token, and a token in a log sink is a token an operator can use.
 */
export function createDevEmailSender(): EmailSender {
  return {
    send(message: EmailMessage): Promise<EmailResult> {
      const to = recipients(message.to).map(maskEmail);
      logger.info(
        { channel: 'email', provider: 'dev-noop', to, subject: message.subject },
        'Email not sent (dev no-op sender)',
      );
      logger.debug({ to, subject: message.subject, body: message.text }, 'dev email body');
      return Promise.resolve({ delivered: true, provider: 'dev-noop', providerMessageId: null });
    },
  };
}

/**
 * Gmail / Google Workspace over SMTP — the production sender.
 *
 * Chosen over SES by the project owner. Gmail's SMTP endpoint needs no vendor
 * onboarding, no production-access request and no DKIM lead time, which is what
 * kept SES a stub for so long.
 *
 * Auth is an APP PASSWORD, not the account password: Google rejects plain
 * passwords for SMTP, and an app password is independently revocable. It is
 * read from the environment and never logged — `maskEmail` is applied to
 * recipients for the same reason.
 *
 * The transporter is created ONCE and reused. Nodemailer pools connections, and
 * building one per send would open a fresh TLS handshake for every password
 * reset and hit Gmail's connection limits under any real load.
 *
 * Gmail sends AS the authenticated mailbox. A `from` that is not that mailbox
 * (or one of its verified aliases) is silently rewritten by Google, so
 * `EMAIL_FROM` must match `SMTP_USER` or an alias it owns.
 */
function smtpTransport(): Transporter {
  transporter ??= createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is implicit TLS; 587 upgrades with STARTTLS. Both are encrypted —
    // getting this backwards is the usual cause of a silent hang on connect.
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  });
  return transporter;
}

export function createSmtpEmailSender(): EmailSender {
  return {
    async send(message: EmailMessage): Promise<EmailResult> {
      const to = recipients(message.to);
      try {
        // nodemailer types sendMail's result as `any`. Narrowed to the one
        // field we read, rather than letting `any` leak into the return value.
        const info = (await smtpTransport().sendMail({
          from: message.from ?? defaultFrom(),
          to,
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        })) as { messageId?: string };
        logger.info(
          { channel: 'email', provider: 'smtp', to: to.map(maskEmail), subject: message.subject, messageId: info.messageId },
          'email sent',
        );
        return { delivered: true, provider: 'smtp', providerMessageId: info.messageId ?? null };
      } catch (err) {
        // Logged with the recipient masked, then rethrown: callers decide whether
        // a send failure is fatal. The password-reset flow deliberately swallows
        // it so a mail outage cannot reveal which accounts exist.
        logger.error(
          { err, channel: 'email', provider: 'smtp', to: to.map(maskEmail), subject: message.subject },
          'email send failed',
        );
        throw new UpstreamError('Email could not be sent.', {
          context: { provider: 'smtp', subject: message.subject },
          cause: err,
        });
      }
    },
  };
}

/**
 * SES — never implemented, and now superseded by SMTP above.
 *
 * Kept only so an old `EMAIL_PROVIDER=ses` cannot silently fall through to the
 * dev no-op and drop mail on the floor. It fails loudly instead.
 */
export function createSesEmailSender(): EmailSender {
  return {
    send(message: EmailMessage): Promise<EmailResult> {
      logger.error(
        { to: recipients(message.to).map(maskEmail), subject: message.subject },
        'SES sender is not implemented — no email was sent',
      );
      return Promise.reject(
        new UpstreamError('Email delivery is not configured.', {
          context: { provider: 'ses', subject: message.subject },
        }),
      );
    },
  };
}

/**
 * SMTP credentials decide it, NOT `NODE_ENV`.
 *
 * The old rule keyed off `AWS_ACCESS_KEY_ID`, so having S3 credentials — needed
 * for media uploads, nothing to do with mail — selected an unimplemented SES
 * sender that rejected every send. The best-looking configuration delivered
 * nothing, and the callers' deliberate swallow hid it.
 *
 * Keying off the mail credentials themselves removes that class of mistake: the
 * sender that is configured is the sender that runs.
 */
function createEmailSender(): EmailSender {
  if (env.SMTP_USER && env.SMTP_PASSWORD) {
    logger.info(
      { provider: 'smtp', host: env.SMTP_HOST, port: env.SMTP_PORT, from: env.EMAIL_FROM },
      'email delivery enabled over SMTP',
    );
    return createSmtpEmailSender();
  }
  if (env.isProduction) {
    logger.error(
      'EMAIL IS NOT DELIVERED: SMTP_USER / SMTP_PASSWORD are unset in production. Password-reset ' +
        'and staff-invite emails will be generated and logged, but never sent.',
    );
  }
  return createDevEmailSender();
}

let sender: EmailSender = createEmailSender();

/** The process-wide sender. Swap in a fake with `setEmailSender()` in tests. */
export const emailSender: EmailSender = {
  send: (message) => sender.send(message),
};

/** Test seam. Pass `null` to restore the environment-selected sender. */
export function setEmailSender(next: EmailSender | null): void {
  sender = next ?? createEmailSender();
}

/** The default `From`, so callers do not each reach into env. */
export const defaultFrom = (): string => env.EMAIL_FROM;
