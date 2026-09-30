import { z } from 'zod';
import { INVOICE_STATUSES } from '../../db/schema/index.js';

export const adminInvoiceResponse = z.object({
  id: z.string().uuid(),
  invoiceNo: z.string(),
  orderNo: z.string(),
  buyerName: z.string(),
  taxablePaise: z.number().int(),
  cgstPaise: z.number().int(),
  sgstPaise: z.number().int(),
  igstPaise: z.number().int(),
  cessPaise: z.number().int(),
  totalPaise: z.number().int(),
  status: z.enum(INVOICE_STATUSES),
  issuedAt: z.string(),
});

export const invoiceLineDetail = z.object({
  id: z.string().uuid(),
  description: z.string(),
  hsnCode: z.string(),
  quantity: z.string(),
  unit: z.string(),
  unitPricePaise: z.number().int(),
  discountPaise: z.number().int(),
  taxablePaise: z.number().int(),
  gstRateBp: z.number().int(),
  cgstPaise: z.number().int(),
  sgstPaise: z.number().int(),
  igstPaise: z.number().int(),
  cessPaise: z.number().int(),
  lineTotalPaise: z.number().int(),
});

export const adminInvoiceDetail = adminInvoiceResponse.extend({
  orderId: z.string().uuid(),
  buyerGstin: z.string().nullable(),
  buyerPhone: z.string().nullable(),
  buyerEmail: z.string().nullable(),
  billingAddress: z.record(z.string(), z.unknown()).nullable(),
  shippingAddress: z.record(z.string(), z.unknown()).nullable(),
  financialYear: z.string(),
  irn: z.string().nullable(),
  irnAckNo: z.string().nullable(),
  irnAckDate: z.string().nullable(),
  qrPayload: z.string().nullable(),
  ewayBillNo: z.string().nullable(),
  roundOffPaise: z.number().int(),
  lines: z.array(invoiceLineDetail),
});

export const listInvoicesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(INVOICE_STATUSES).optional(),
  q: z.string().optional(),
});

export const invoiceIdParam = z.object({
  id: z.string().uuid(),
});

export const batchInvoicesBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});
