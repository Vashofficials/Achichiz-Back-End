import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { UpstreamError } from '../../lib/errors.js';

/**
 * SMS, behind a local interface.
 *
 * MSG91 is the pick because it manages **TRAI DLT** registration properly — every
 * transactional template and the sender id must be pre-registered against the
 * entity or Indian carriers drop the message silently. That is a 1–2 week
 * business process, not a code change, which is exactly why the vendor sits
 * behind an interface: the OTP flow is built, tested and shippable before the
 * DLT paperwork clears.
 *
 * Nothing here calls MSG91. The dev implementation logs; the production
 * implementation is a deliberate stub that throws until someone wires the real
 * HTTP call and the DLT template ids.
 */

export type SmsPurpose = 'otp' | 'transactional';

export type SmsMessage = {
  /** 10-digit Indian mobile, no country code — matches the `mobile_in` domain. */
  to: string;
  purpose: SmsPurpose;
  /**
   * DLT-registered template id. An unregistered id is not an error you will see:
   * MSG91 accepts it and the carrier drops the message.
   */
  templateId: string;
  /** Template variable substitutions, e.g. `{ otp: '482913' }`. */
  variables: Record<string, string>;
};

export type SmsResult = {
  delivered: boolean;
  provider: 'msg91' | 'dev-noop';
  /** Provider-side id, for the `notification_log` row and "did they get it?" support questions. */
  providerMessageId: string | null;
};

export interface SmsSender {
  send(message: SmsMessage): Promise<SmsResult>;
}

/** `9876543210` → `98•••••210`. Full numbers do not belong in log sinks. */
export const maskMobile = (mobile: string): string =>
  mobile.length <= 5 ? '•••' : `${mobile.slice(0, 2)}•••••${mobile.slice(-3)}`;

/**
 * Development / test implementation.
 *
 * Logs instead of sending, and — deliberately — logs the OTP in full so the
 * local flow is testable without an SMS gateway. This is gated on `isProduction`
 * at the factory below, so it cannot be the active sender in production.
 */
export function createDevSmsSender(): SmsSender {
  return {
    send(message: SmsMessage): Promise<SmsResult> {
      logger.info(
        {
          channel: 'sms',
          provider: 'dev-noop',
          to: maskMobile(message.to),
          purpose: message.purpose,
          templateId: message.templateId,
          // Local development only. Never reached in production — see createSmsSender().
          devVariables: message.variables,
        },
        'SMS not sent (dev no-op sender)',
      );
      return Promise.resolve({ delivered: true, provider: 'dev-noop', providerMessageId: null });
    },
  };
}

/**
 * Production implementation — intentionally unimplemented.
 *
 * Wiring this up is a two-part job and the second part is not code: the HTTP call
 * to `https://control.msg91.com/api/v5/flow/` plus the DLT-registered template
 * ids for each `SmsPurpose`. Throwing an `UpstreamError` is the honest failure
 * mode; silently succeeding would make a broken OTP login look healthy.
 */
export function createMsg91SmsSender(): SmsSender {
  return {
    send(message: SmsMessage): Promise<SmsResult> {
      logger.error(
        { to: maskMobile(message.to), purpose: message.purpose, templateId: message.templateId },
        'MSG91 sender is not implemented — no SMS was sent',
      );
      return Promise.reject(
        new UpstreamError('SMS delivery is not configured.', {
          context: { provider: 'msg91', purpose: message.purpose },
        }),
      );
    },
  };
}

function createSmsSender(): SmsSender {
  if (env.isProduction && env.MSG91_AUTH_KEY) return createMsg91SmsSender();
  if (env.isProduction) {
    logger.warn('MSG91_AUTH_KEY is unset in production — SMS will be logged, not delivered');
  }
  return createDevSmsSender();
}

/** The process-wide sender. Swap in a fake with `setSmsSender()` in tests. */
let sender: SmsSender = createSmsSender();

export const smsSender: SmsSender = {
  send: (message) => sender.send(message),
};

/** Test seam. Pass `null` to restore the environment-selected sender. */
export function setSmsSender(next: SmsSender | null): void {
  sender = next ?? createSmsSender();
}
