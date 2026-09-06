import { z } from 'zod';
import { PAYMENT_GATEWAYS, PAYMENT_STATUSES } from '../../db/schema/index.js';

export const adminPaymentResponse = z.object({
  id: z.string().uuid(),
  paymentNo: z.string(), // We'll map gatewayPaymentId or an internal ID to this
  orderNo: z.string(),
  gatewayPaymentId: z.string().nullable(),
  gateway: z.enum(PAYMENT_GATEWAYS),
  amountPaise: z.number().int(),
  feePaise: z.number().int(),
  taxOnFeePaise: z.number().int(),
  isSettled: z.boolean(),
  status: z.enum(PAYMENT_STATUSES),
  createdAt: z.string(),
});

export const listPaymentsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(10).max(100).default(50),
  gateway: z.enum(PAYMENT_GATEWAYS).optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  isSettled: z.enum(['true', 'false']).optional(),
  q: z.string().optional(),
});

export const paymentIdParam = z.object({
  paymentId: z.string().uuid(),
});

export const reconcilePaymentBody = z.object({
  settlementRef: z.string().min(1),
});
