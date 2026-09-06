import { z } from 'zod';

export const adminCartLine = z.object({
  id: z.string().uuid(),
  title: z.string(),
  variantLabel: z.string(),
  sku: z.string(),
  quantity: z.number().int(),
  unitPricePaise: z.number().int(),
});

export const adminCart = z.object({
  id: z.string().uuid(),
  customerName: z.string().nullable(),
  email: z.string().nullable(),
  mobile: z.string().nullable(),
  stage: z.enum(['cart', 'address', 'payment', 'converted']),
  abandonedAt: z.string().nullable(),
  recoveryState: z.enum(['not_sent', 'email_sent', 'whatsapp_sent', 'recovered']),
  itemCount: z.number().int(),
  totalPaise: z.number().int(),
  lines: z.array(adminCartLine),
});

export const listAbandonedCartsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(10).max(100).default(50),
  stage: z.enum(['cart', 'address', 'payment']).optional(),
  recoveryState: z.enum(['not_sent', 'email_sent', 'whatsapp_sent', 'recovered']).optional(),
  q: z.string().optional(),
});

export const cartIdParam = z.object({
  cartId: z.string().uuid(),
});

export const remindCartBody = z.object({
  method: z.enum(['email', 'whatsapp']),
});
