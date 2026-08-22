import { Router } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok } from '../../lib/http.js';
import * as payments from './payments.service.js';
import {
  createPaymentSessionBody,
  paymentResult,
  paymentSession,
  verifyPaymentBody,
} from './payments.schemas.js';

/**
 * Razorpay, customer side.
 *
 * Two endpoints and a deliberate omission: there is no way to tell this API that
 * an order is paid. `verifyRazorpayPayment` accepts a signature, checks it, and
 * then asks Razorpay what actually happened. The webhook does the same work from
 * the other direction; whichever arrives first applies the capture and the other
 * is a no-op.
 */
export const paymentsRouter: Router = Router();

defineRoute(paymentsRouter, {
  method: 'post',
  path: '/v1/payments/razorpay/order',
  surface: 'storefront',
  operationId: 'createRazorpayOrder',
  summary: 'Create (or reuse) a Razorpay order for an existing order',
  description:
    '`POST /v1/orders` already returns a session for a prepaid order, so this is the retry path — use ' +
    'it when that response came back with `payment: null` (the gateway was unreachable at the time), ' +
    'or when the customer abandoned Checkout and came back to pay later.' +
    '\n\n' +
    'The amount is the order’s outstanding balance read from `orders.total_paise`; there is no field ' +
    'through which a client can propose one. An unconsumed session for the same amount is returned ' +
    'again rather than a second one being created, so double-tapping “Pay now” is free. ' +
    'Only `keyId` is returned — the key secret never leaves the server.',
  tags: ['Payments'],
  auth: 'customer',
  rateLimit: 'payment',
  request: { body: createPaymentSessionBody },
  responses: {
    201: { description: 'The payment session to hand to Checkout.js.', schema: paymentSession },
    404: { description: 'No such order, or it belongs to someone else.' },
    422: { description: 'The order is already paid, or has been cancelled or refunded.' },
    502: { description: 'Razorpay could not be reached. Safe to retry.' },
  },
  handler: async ({ body, auth }) =>
    created(await payments.createPaymentSession(body.orderId, auth.customerId)),
});

defineRoute(paymentsRouter, {
  method: 'post',
  path: '/v1/payments/razorpay/verify',
  surface: 'storefront',
  operationId: 'verifyRazorpayPayment',
  summary: 'Verify the Razorpay checkout hand-back',
  description:
    'Call this from the Checkout.js success handler with the three identifiers it gives you. The ' +
    'signature — `HMAC-SHA256(razorpay_order_id|razorpay_payment_id)` keyed with the API secret — is ' +
    'verified in constant time, and the Razorpay order is confirmed to belong to this order.' +
    '\n\n' +
    '**A valid signature is not proof of payment.** It proves the identifiers are genuine, nothing ' +
    'more; a signed but merely *authorised* payment has taken no money. So the payment is refetched ' +
    'from Razorpay and only a `captured` status is applied. If the webhook already applied it, this ' +
    'returns the same state without double-crediting the order.' +
    '\n\n' +
    'A failure here does not mean the payment failed — the webhook remains the source of truth and ' +
    'will confirm the order regardless of whether the browser ever came back.',
  tags: ['Payments'],
  auth: 'customer',
  rateLimit: 'payment',
  request: { body: verifyPaymentBody },
  responses: {
    200: { description: 'The order’s payment state after applying the capture.', schema: paymentResult },
    404: { description: 'No such order, or it belongs to someone else.' },
    422: {
      description:
        'The signature did not verify (`signature_invalid`), the Razorpay order belongs to a different ' +
        'order (`payment_order_mismatch`), or the payment is not captured yet (`payment_not_captured`).',
    },
    502: { description: 'Razorpay could not be reached to confirm the payment.' },
  },
  handler: async ({ body, auth }) => ok(await payments.verifyCheckoutHandback(body, auth.customerId)),
});
