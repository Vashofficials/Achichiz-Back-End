/**
 * Payment contracts.
 *
 * Note what the client is trusted with here: three opaque gateway identifiers
 * and a signature. Not an amount. The amount to charge is read from
 * `orders.total_paise`, and the amount actually captured is read back from
 * Razorpay — never from the browser that just finished checkout.
 */

import { z } from 'zod';
import { paymentSession } from '../checkout/checkout.schemas.js';

export { paymentSession };

export const createPaymentSessionBody = z.object({
  orderId: z.uuid().describe('The order to collect payment for. Must belong to the caller.'),
});

export const verifyPaymentBody = z.object({
  orderId: z.uuid().describe('The order the payment belongs to. Must belong to the caller.'),
  razorpayOrderId: z
    .string()
    .trim()
    .min(4)
    .max(64)
    .describe('`razorpay_order_id` from the Checkout success handler.'),
  razorpayPaymentId: z
    .string()
    .trim()
    .min(4)
    .max(64)
    .describe('`razorpay_payment_id` from the Checkout success handler.'),
  razorpaySignature: z
    .string()
    .trim()
    .length(64)
    .describe(
      'HMAC-SHA256 of `razorpay_order_id|razorpay_payment_id` keyed with the API secret, hex-encoded. ' +
        'Verified in constant time.',
    ),
});

export const paymentResult = z.object({
  orderId: z.uuid().describe('Order id.'),
  orderNo: z.string().describe('Human-facing order number, e.g. `ACH100042`.'),
  status: z.string().describe('Operational order status after the payment was applied.'),
  paymentStatus: z
    .string()
    .describe('`paid` once the captured amount covers the total; `pending` on a part payment.'),
  amountPaidPaise: z.number().int().describe('Total captured against this order so far, in integer paise.'),
  totalPaise: z.number().int().describe('Order total in integer paise.'),
  gatewayPaymentId: z.string().describe('`pay_XXXXXXXX` — the capture this call applied.'),
});

export type PaymentResultResponse = z.infer<typeof paymentResult>;
export type PaymentSessionResponse = z.infer<typeof paymentSession>;
