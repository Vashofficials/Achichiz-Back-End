import { z } from 'zod';
import { RETURN_STATUSES } from '../../db/schema/index.js'; // Assuming exchange statuses overlap or are similar

export const adminExchangeResponse = z.object({
  id: z.string().uuid(),
  exchangeNo: z.string(),
  orderNo: z.string(),
  customerName: z.string().nullable(),
  fromVariantId: z.string().uuid(),
  toVariantId: z.string().uuid(),
  fromVariantLabel: z.string(),
  toVariantLabel: z.string(),
  quantity: z.number().int(),
  priceDiffPaise: z.number().int(),
  status: z.enum(RETURN_STATUSES),
  requestedAt: z.string(),
  resolvedAt: z.string().nullable(),
});

export const listExchangesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(10).max(100).default(50),
  status: z.enum(RETURN_STATUSES).optional(),
  q: z.string().optional(),
});

export const exchangeIdParam = z.object({
  exchangeId: z.string().uuid(),
});

export const approveExchangeBody = z.object({});
