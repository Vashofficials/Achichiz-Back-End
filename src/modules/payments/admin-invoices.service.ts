import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { invoices, orders } from '../../db/schema/index.js';

export async function listInvoices(params: {
  page: number;
  perPage: number;
  status?: any;
  q?: string;
}) {
  const { page, perPage, status, q } = params;

  let conditions = [];
  if (status) conditions.push(eq(invoices.status, status));
  if (q) {
    conditions.push(or(
      ilike(invoices.invoiceNo, `%${q}%`),
      ilike(orders.orderNo, `%${q}%`)
    )!);
  }

  const offset = (page - 1) * perPage;

  const results = await db
    .select({
      id: invoices.id,
      invoiceNo: invoices.invoiceNo,
      orderNo: orders.orderNo,
      buyerName: invoices.buyerName,
      taxablePaise: invoices.taxablePaise,
      cgstPaise: invoices.cgstPaise,
      sgstPaise: invoices.sgstPaise,
      igstPaise: invoices.igstPaise,
      cessPaise: invoices.cessPaise,
      totalPaise: invoices.totalPaise,
      status: invoices.status,
      issuedAt: invoices.issuedAt,
    })
    .from(invoices)
    .leftJoin(orders, eq(invoices.orderId, orders.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(invoices.issuedAt))
    .limit(perPage)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .leftJoin(orders, eq(invoices.orderId, orders.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);
    
  const count = countResult[0]?.count ?? 0;

  const items = results.map(r => ({
    ...r,
    issuedAt: r.issuedAt.toISOString(),
  }));

  return {
    items,
    meta: {
      page,
      perPage,
      total: count,
      totalPages: Math.ceil(count / perPage),
    },
  };
}
