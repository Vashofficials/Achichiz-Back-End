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

export const listInvoicesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(10).max(100).default(50),
  status: z.enum(INVOICE_STATUSES).optional(),
  q: z.string().optional(),
});
