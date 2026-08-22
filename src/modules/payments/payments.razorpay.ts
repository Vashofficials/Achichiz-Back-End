/**
 * The Razorpay boundary: signature verification and the SDK client.
 *
 * The verification functions are PURE — they take a secret as an argument rather
 * than reading `env`, so the test suite can exercise them against Razorpay's own
 * published example vectors without a gateway, a key or a network.
 *
 * Two different signatures exist and they are NOT interchangeable:
 *
 *  - **Checkout handback**: `HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id)`
 *    keyed with the API **key secret**. Proves the browser's success callback is
 *    genuine. It does not prove the payment was captured — only the gateway's own
 *    record does, which is why `payments.service` refetches.
 *  - **Webhook**: `HMAC_SHA256(raw request body)` keyed with the **webhook
 *    secret**, a different secret entirely. It must be computed over the exact
 *    bytes received: JSON.parse + JSON.stringify reorders nothing but does
 *    renormalise whitespace, unicode escapes and number formatting, and every
 *    signature check then fails for reasons that look like a key mismatch.
 */

import Razorpay from 'razorpay';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, razorpayLiveKeyError } from '../../config/env.js';
import { UpstreamError } from '../../lib/errors.js';
import type { PaymentMethod } from '../../db/schema/index.js';

/** Constant-time compare that tolerates a wrong-length attacker-supplied value. */
export function safeEqualHex(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  // timingSafeEqual throws on a length mismatch, and the length of an HMAC digest
  // is not a secret, so comparing it first leaks nothing.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const checkoutSignature = (razorpayOrderId: string, razorpayPaymentId: string, keySecret: string): string =>
  createHmac('sha256', keySecret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');

export function verifyCheckoutSignature(
  input: { razorpayOrderId: string; razorpayPaymentId: string; signature: string },
  keySecret: string,
): boolean {
  if (!keySecret) return false;
  return safeEqualHex(
    checkoutSignature(input.razorpayOrderId, input.razorpayPaymentId, keySecret),
    input.signature,
  );
}

export const webhookSignature = (rawBody: Buffer | string, webhookSecret: string): string =>
  createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

export function verifyWebhookSignature(
  rawBody: Buffer | string | undefined,
  signature: string | undefined,
  webhookSecret: string,
): boolean {
  if (!rawBody || !signature || !webhookSecret) return false;
  return safeEqualHex(webhookSignature(rawBody, webhookSecret), signature);
}

/* ------------------------------------------------------------------ client */

let client: Razorpay | null = null;

export const razorpayConfigured = (): boolean =>
  Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

/**
 * Thrown when the process is configured to move REAL money somewhere it should
 * not. Deliberately not an `UpstreamError`: this is not a vendor that might come
 * back in a second, it is a deployment fault, and it must not be retried.
 */
export class LiveKeyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveKeyRefusedError';
  }
}

/**
 * Built on first use, not at import time. Importing the route graph must not
 * construct a gateway client — `openapi:generate` runs on machines with no keys.
 *
 * The live-key guard sits HERE rather than only at boot, because that is the
 * last point before real money can move: no client, no `orders.create`, no
 * `payments.refund`. A dev server that somehow loaded a live `.env` fails on the
 * first checkout with an explicit message instead of charging a real card.
 */
export function razorpay(): Razorpay {
  if (!razorpayConfigured()) {
    throw new UpstreamError('Razorpay is not configured: RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are unset.');
  }
  const liveKeyError = razorpayLiveKeyError(env.RAZORPAY_KEY_ID, env.NODE_ENV);
  if (liveKeyError) throw new LiveKeyRefusedError(liveKeyError);

  client ??= new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  return client;
}

/* ------------------------------------------------- narrow SDK return types */

/**
 * The SDK types several fields as `any` (`IMap<any>`, `string | number`). Rather
 * than let that leak into the service, every gateway response is narrowed here
 * to exactly the fields this codebase uses, with paise coerced to an integer.
 */
export type GatewayOrder = { id: string; amountPaise: number; currency: string; status: string };
export type GatewayPayment = {
  id: string;
  orderId: string | null;
  amountPaise: number;
  currency: string;
  status: string;
  method: string | null;
  errorCode: string | null;
  errorDescription: string | null;
};
export type GatewayRefund = { id: string; amountPaise: number; status: string };

const toPaise = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new UpstreamError(`Razorpay returned a non-integer amount: ${String(value)}`);
  return n;
};

export async function createGatewayOrder(input: {
  amountPaise: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}): Promise<GatewayOrder> {
  // Outside the try on purpose: a configuration refusal must NOT be laundered
  // into a 502 "vendor unavailable, safe to retry".
  const gateway = razorpay();
  try {
    const order = await gateway.orders.create({
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
      payment_capture: true,
    });
    return {
      id: order.id,
      amountPaise: toPaise(order.amount),
      currency: order.currency,
      status: String(order.status),
    };
  } catch (err) {
    throw new UpstreamError('Razorpay could not create the payment order.', { cause: err });
  }
}

export async function fetchGatewayPayment(paymentId: string): Promise<GatewayPayment> {
  const gateway = razorpay();
  try {
    const payment = await gateway.payments.fetch(paymentId);
    return {
      id: payment.id,
      orderId: payment.order_id ?? null,
      amountPaise: toPaise(payment.amount),
      currency: payment.currency,
      status: payment.status,
      method: typeof payment.method === 'string' ? payment.method : null,
      errorCode: typeof payment.error_code === 'string' ? payment.error_code : null,
      errorDescription: typeof payment.error_description === 'string' ? payment.error_description : null,
    };
  } catch (err) {
    throw new UpstreamError('Razorpay could not be reached to confirm the payment.', { cause: err });
  }
}

export async function createGatewayRefund(input: {
  paymentId: string;
  amountPaise: number;
  notes: Record<string, string>;
}): Promise<GatewayRefund> {
  const gateway = razorpay();
  try {
    const refund = await gateway.payments.refund(input.paymentId, {
      amount: input.amountPaise,
      speed: 'normal',
      notes: input.notes,
    });
    return { id: refund.id, amountPaise: toPaise(refund.amount), status: String(refund.status) };
  } catch (err) {
    throw new UpstreamError('Razorpay could not process the refund.', { cause: err });
  }
}

/* ---------------------------------------------------------- method mapping */

/**
 * Razorpay's method vocabulary onto `payments.method`, which is a CHECK
 * constraint. An unrecognised method must not fail the write — the money is
 * already taken by then — so anything unknown lands on `net_banking`.
 */
export function toPaymentMethod(gatewayMethod: string | null | undefined): PaymentMethod {
  switch (gatewayMethod) {
    case 'upi':
      return 'upi';
    case 'card':
      return 'credit_card';
    case 'netbanking':
      return 'net_banking';
    case 'wallet':
      return 'wallet';
    case 'emi':
      return 'emi';
    default:
      return 'net_banking';
  }
}
