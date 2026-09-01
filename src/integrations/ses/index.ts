import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { UpstreamError } from '../../lib/errors.js';

/**
 * Transactional email, behind a local interface.
 *
 * AWS SES in `ap-south-1` is the pick (cheapest at volume, Mumbai region), but
 * production access approval plus DKIM/SPF/DMARC on a dedicated
 * `notifications.achichiz.com` subdomain is roughly a week of lead time. So the
 * vendor sits behind an interface and the flows that need it — password reset,
 * lead acknowledgements, internal lead notifications — are built and tested
 * against a no-op that logs.
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
  provider: 'ses' | 'dev-noop';
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
 * Production implementation — intentionally unimplemented.
 *
 * `@aws-sdk/client-s3` is already a dependency but `@aws-sdk/client-sesv2` is
 * not, and adding it is a dependency decision for the project owner rather than
 * something to slip in here. Until then this throws rather than pretending.
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

function createEmailSender(): EmailSender {
  if (env.isProduction && env.AWS_ACCESS_KEY_ID) return createSesEmailSender();
  if (env.isProduction) {
    logger.warn('AWS credentials are unset in production — email will be logged, not delivered');
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
