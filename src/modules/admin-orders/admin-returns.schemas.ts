import { z } from 'zod';
import { RETURN_REASONS, RETURN_STATUSES, REFUND_MODES, RETURN_LINE_CONDITIONS } from '../../db/schema/index.js';

export const adminReturnLine = z.object({
  id: z.string().uuid(),
  title: z.string(),
  sku: z.string(),
  quantity: z.number().int(),
  condition: z.enum(RETURN_LINE_CONDITIONS).nullable(),
  refundPaise: z.number().int(),
});

export const adminReturnResponse = z.object({
  id: z.string().uuid(),
  returnNo: z.string(),
  orderNo: z.string(),
  customerName: z.string().nullable(),
  reason: z.enum(RETURN_REASONS),
  reasonNote: z.string().nullable(),
  status: z.enum(RETURN_STATUSES),
  refundMode: z.enum(REFUND_MODES),
  refundPaise: z.number().int(),
  restock: z.boolean(),
  pickupAwb: z.string().nullable(),
  requestedAt: z.string(),
  resolvedAt: z.string().nullable(),
  lines: z.array(adminReturnLine),
});

export const listReturnsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(10).max(100).default(50),
  status: z.enum(RETURN_STATUSES).optional(),
  q: z.string().optional(),
});

export const returnIdParam = z.object({
  returnId: z.string().uuid(),
});

export const approveReturnBody = z.object({
  pickupAwb: z.string().optional(),
});

export const refundReturnBody = z.object({
  refundPaise: z.number().int().min(1),
});

export const rejectReturnBody = z.object({
  reasonNote: z.string().min(3),
});
