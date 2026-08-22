/**
 * Inbound Razorpay webhooks — the source of truth for payment state.
 *
 * The storefront's optimistic `placeOrder()` marks an order paid in the browser
 * (`checkout.tsx:91-125`). Nothing here trusts anything a browser said. An order
 * becomes paid when Razorpay says so, either through this webhook or through the
 * hand-back verification, which reaches the same idempotent code path.
 *
 * Replay safety, in three parts:
 *
 *  1. **Authenticity first.** The signature is checked against the RAW request
 *     bytes before a single row is written, so an unauthenticated caller cannot
 *     even fill the event table.
 *  2. **Persist by event id, then act.** `payment_events (gateway,
 *     gateway_event_id)` is UNIQUE, and the INSERT is the claim. Five deliveries
 *     of the same event produce one row and one state change.
 *  3. **The apply functions are independently idempotent.** Even if the claim
 *     were bypassed, capture is keyed on `gateway_payment_id` and refunds on
 *     `gateway_refund_id`, so the second attempt finds the work already done.
 *
 * A delivery whose PROCESSING fails is left with `processed_at` NULL, so
 * Razorpay's next retry re-runs it rather than being waved through as a
 * duplicate — that distinction is the difference between "at least once" and
 * "at most once", and only one of them is safe here.
 */

import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { BadRequestError } from '../../lib/errors.js';
import * as payments from '../payments/payments.service.js';
import { verifyWebhookSignature } from '../payments/payments.razorpay.js';
import * as repo from './webhooks.repository.js';
import type { GatewayEntity, RazorpayWebhookBody } from './webhooks.schemas.js';

const GATEWAY = 'razorpay';

/**
 * Razorpay sends `x-razorpay-event-id`, and its retries reuse it. When it is
 * absent (older integrations, replayed captures from the dashboard) a hash of
 * the exact body is a sound substitute: the same delivery hashes to the same
 * key, so the uniqueness guarantee is preserved.
 */
export function eventIdFor(header: string | undefined, rawBody: Buffer | string | undefined): string {
  const trimmed = header?.trim();
  if (trimmed) return trimmed;
  return `sha256:${createHash('sha256').update(rawBody ?? '').digest('hex')}`;
}

const entityOf = (body: RazorpayWebhookBody, key: 'payment' | 'refund' | 'order'): GatewayEntity | null =>
  body.payload?.[key]?.entity ?? null;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export type WebhookResult = { received: true; duplicate: boolean };

export async function handleRazorpayWebhook(input: {
  signature: string | undefined;
  eventIdHeader: string | undefined;
  rawBody: Buffer | undefined;
  body: RazorpayWebhookBody;
}): Promise<WebhookResult> {
  // Signed over the bytes as received. Re-serialising the parsed JSON changes
  // whitespace, unicode escapes and number formatting, and every check then
  // fails in a way that looks exactly like a wrong secret.
  if (!verifyWebhookSignature(input.rawBody, input.signature, env.RAZORPAY_WEBHOOK_SECRET)) {
    logger.warn({ event: input.body.event }, 'razorpay webhook signature verification failed');
    // Not persisted: an unauthenticated caller must not be able to write rows.
    throw new BadRequestError('Webhook signature verification failed.');
  }

  const gatewayEventId = eventIdFor(input.eventIdHeader, input.rawBody);

  const claim = await repo.claimEvent({
    gateway: GATEWAY,
    gatewayEventId,
    eventType: input.body.event,
    signatureValid: true,
    payload: input.body,
  });

  if (claim.alreadyProcessed) {
    return { received: true, duplicate: true };
  }

  try {
    const outcome = await dispatch(input.body);

    if (outcome.deferred) {
      /*
       * Authentic, but not applicable yet — a `refund.processed` that overtook
       * its `payment.captured`, or a capture for a gateway order this system
       * never created.
       *
       * Answered 200 so Razorpay stops retrying an event that a retry cannot
       * fix, but deliberately NOT marked processed: the row stays in
       * `idx_payment_events_unprocessed` with the reason on it, which is the
       * difference between "money moved and someone will see it" and "money
       * moved and the only trace is a log line nobody greps".
       */
      await repo.markFailed(claim.id, outcome.deferred);
      logger.warn(
        { gatewayEventId, event: input.body.event, reason: outcome.deferred },
        'razorpay webhook accepted but left unprocessed for reconciliation',
      );
      return { received: true, duplicate: false };
    }

    await repo.markProcessed(claim.id, outcome);
    return { received: true, duplicate: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.markFailed(claim.id, message);
    logger.error({ err, gatewayEventId, event: input.body.event }, 'razorpay webhook processing failed');
    // Rethrown on purpose: a 5xx makes Razorpay retry, and the event row is
    // still unprocessed so that retry does real work instead of being skipped.
    throw err;
  }
}

async function dispatch(body: RazorpayWebhookBody): Promise<payments.ApplyOutcome> {
  const payment = entityOf(body, 'payment');
  const refund = entityOf(body, 'refund');

  switch (body.event) {
    case 'payment.captured': {
      if (!payment) return unhandled('payment.captured arrived without a payment entity');
      return payments.applyPaymentCaptured({
        gatewayPaymentId: payment.id,
        gatewayOrderId: asString(payment.order_id),
        // A capture with no amount is a malformed payload, not a free order.
        // `applyPaymentCaptured` rejects any non-positive amount and defers the
        // event rather than writing a zero-value payment row.
        amountPaise: payment.amount ?? 0,
        method: asString(payment.method),
        raw: payment,
      });
    }

    case 'payment.failed': {
      if (!payment) return unhandled('payment.failed arrived without a payment entity');
      return payments.applyPaymentFailed({
        gatewayPaymentId: payment.id,
        gatewayOrderId: asString(payment.order_id),
        method: asString(payment.method),
        errorCode: asString(payment.error_code),
        errorDescription: asString(payment.error_description),
        raw: payment,
      });
    }

    case 'refund.processed': {
      if (!refund) return unhandled('refund.processed arrived without a refund entity');
      const paymentId = asString(refund.payment_id);
      if (!paymentId) return unhandled('refund.processed carried no payment_id');
      return payments.applyRefundProcessed({
        gatewayRefundId: refund.id,
        gatewayPaymentId: paymentId,
        amountPaise: refund.amount ?? 0,
        raw: refund,
      });
    }

    case 'refund.failed': {
      if (!refund) return unhandled('refund.failed arrived without a refund entity');
      return payments.applyRefundFailed({ gatewayRefundId: refund.id, raw: refund });
    }

    /*
     * Deliberately acknowledged without acting.
     *
     * `payment.authorized` is superseded by `payment.captured` (orders are created
     * with `payment_capture: true`, so authorisation is never the terminal state).
     * `order.paid` carries no information the capture event did not. Acting on
     * either would mean crediting the same money from two events.
     */
    case 'payment.authorized':
    case 'order.paid':
    case 'refund.created':
      return { orderId: null, paymentId: null, changed: false };

    default:
      // Unknown event types are acknowledged, never rejected: a 4xx would make
      // Razorpay retry an event this API will never understand, forever.
      logger.info({ event: body.event }, 'razorpay webhook event type not handled');
      return { orderId: null, paymentId: null, changed: false };
  }
}

function unhandled(reason: string): payments.ApplyOutcome {
  logger.warn({ reason }, 'razorpay webhook payload was missing an expected entity');
  // Deferred, not processed: an event whose entity is missing is malformed, and
  // a malformed money event is exactly what a human should look at.
  return { orderId: null, paymentId: null, changed: false, deferred: reason };
}
