import { Router, type Request } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok } from '../../lib/http.js';
import * as webhooks from './webhooks.service.js';
import { razorpayWebhookBody, webhookAck } from './webhooks.schemas.js';

/**
 * Server-to-server webhooks.
 *
 * The path MUST stay under `/v1/webhooks` — `app.ts` mounts `express.raw()`
 * there and stashes the untouched bytes on `req.rawBody` before the JSON parser
 * runs. That buffer is what the signature is computed over; the parsed body is
 * only used to decide what the event means.
 */
export const webhooksRouter: Router = Router();

const headerOf = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

defineRoute(webhooksRouter, {
  method: 'post',
  path: '/v1/webhooks/razorpay',
  surface: 'storefront',
  operationId: 'razorpayWebhook',
  summary: 'Razorpay payment webhook',
  description:
    'The authoritative source of payment state. Configure it in the Razorpay dashboard for ' +
    '`payment.captured`, `payment.failed`, `refund.processed` and `refund.failed`.' +
    '\n\n' +
    '**Authentication is the `X-Razorpay-Signature` header**, an HMAC-SHA256 of the raw request body ' +
    'keyed with the webhook secret — a different secret from the API key secret. It is computed over ' +
    'the exact bytes received, never over re-serialised JSON, and compared in constant time. A ' +
    'signature that does not verify returns 400 and writes nothing at all, so an unauthenticated ' +
    'caller cannot even fill the event table.' +
    '\n\n' +
    '**Replay-safe.** Every delivery is persisted by its `X-Razorpay-Event-Id` (falling back to a hash ' +
    'of the body) into `payment_events`, whose `(gateway, event_id)` uniqueness is the idempotency ' +
    'boundary — the INSERT is the claim. Five deliveries of the same event produce exactly one state ' +
    'change; the rest return `duplicate: true`. Underneath that, capture is keyed on the Razorpay ' +
    'payment id and refunds on the Razorpay refund id, so even a bypassed claim cannot double-credit ' +
    'an order.' +
    '\n\n' +
    'A delivery whose processing throws is left unprocessed and answered with 5xx, so Razorpay’s retry ' +
    'does real work rather than being waved through as a duplicate. Unknown event types are ' +
    'acknowledged with 200 — a 4xx would make Razorpay retry something this API will never understand.',
  tags: ['Webhooks'],
  auth: 'public',
  rateLimit: 'webhook',
  request: { body: razorpayWebhookBody },
  responses: {
    200: { description: 'Received. `duplicate` is true when the event had already been processed.', schema: webhookAck },
    400: { description: 'The signature header is missing or does not verify.' },
  },
  handler: async ({ body, req }) =>
    ok(
      await webhooks.handleRazorpayWebhook({
        signature: headerOf(req, 'x-razorpay-signature'),
        eventIdHeader: headerOf(req, 'x-razorpay-event-id'),
        rawBody: req.rawBody,
        body,
      }),
    ),
});
