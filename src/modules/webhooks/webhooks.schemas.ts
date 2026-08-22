/**
 * Razorpay webhook contracts.
 *
 * Every object here is LOOSE (`z.looseObject`), which is a deliberate departure
 * from the rest of this API. Razorpay adds fields to these payloads without
 * warning, and a strict schema would turn a harmless new attribute into a 422 on
 * the one endpoint that must never reject a genuine event. Validation here means
 * "does it have the handful of fields we act on", not "is it exactly this shape";
 * the untouched payload is stored in `payment_events.payload` regardless.
 */

import { z } from 'zod';

const gatewayEntity = z.looseObject({
  id: z.string().describe('Razorpay entity id, e.g. `pay_MkT2…`, `rfnd_MkT2…`, `order_MkT2…`.'),
  amount: z.number().int().optional().describe('Amount in paise — Razorpay’s smallest currency unit.'),
  currency: z.string().optional().describe('ISO-4217 currency code.'),
  status: z.string().optional().describe('Entity status, e.g. `captured`, `failed`, `processed`.'),
  order_id: z.string().nullable().optional().describe('The Razorpay order this payment belongs to.'),
  payment_id: z.string().nullable().optional().describe('The payment a refund reverses.'),
  method: z.string().nullable().optional().describe('Instrument used: `upi`, `card`, `netbanking`, …'),
  error_code: z.string().nullable().optional().describe('Gateway error code on a failure.'),
  error_description: z.string().nullable().optional().describe('Human-readable gateway failure reason.'),
});

export const razorpayWebhookBody = z.looseObject({
  event: z
    .string()
    .min(3)
    .max(120)
    .describe('Event name, e.g. `payment.captured`, `payment.failed`, `refund.processed`.'),
  account_id: z.string().optional().describe('Razorpay account the event belongs to.'),
  created_at: z.number().int().optional().describe('Unix seconds at which Razorpay created the event.'),
  contains: z.array(z.string()).optional().describe('Which entities are present in `payload`.'),
  payload: z
    .looseObject({
      payment: z.looseObject({ entity: gatewayEntity }).optional().describe('The payment entity, when present.'),
      refund: z.looseObject({ entity: gatewayEntity }).optional().describe('The refund entity, when present.'),
      order: z.looseObject({ entity: gatewayEntity }).optional().describe('The order entity, when present.'),
    })
    .optional()
    .describe('The entities this event carries.'),
});

export const webhookAck = z.object({
  received: z.literal(true).describe('Always true. A 2xx is the only thing Razorpay reads.'),
  duplicate: z
    .boolean()
    .describe('True when this event id had already been processed, so the delivery changed nothing.'),
});

export type RazorpayWebhookBody = z.infer<typeof razorpayWebhookBody>;
export type GatewayEntity = z.infer<typeof gatewayEntity>;
