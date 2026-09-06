import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { exchanges, orders, customers, productVariants } from '../../db/schema/index.js';
import { NotFoundError } from '../../lib/errors.js';

export async function listExchanges(params: {
  page: number;
  perPage: number;
  status?: any;
  q?: string;
}) {
  const { page, perPage, status, q } = params;

  let conditions = [];
  if (status) conditions.push(eq(exchanges.status, status));
  if (q) {
    conditions.push(or(
      ilike(exchanges.exchangeNo, `%${q}%`),
      ilike(orders.orderNo, `%${q}%`)
    )!);
  }

  const offset = (page - 1) * perPage;
  
  // We alias productVariants twice to get the from/to labels
  const fromVariants = db.select().from(productVariants).as('fromVariants');
  const toVariants = db.select().from(productVariants).as('toVariants');

  const results = await db
    .select({
      id: exchanges.id,
      exchangeNo: exchanges.exchangeNo,
      orderNo: orders.orderNo,
      customerName: customers.fullName,
      fromVariantId: exchanges.fromVariantId,
      toVariantId: exchanges.toVariantId,
      fromVariantLabel: sql<string>`${fromVariants.optionLabel}`,
      toVariantLabel: sql<string>`${toVariants.optionLabel}`,
      quantity: exchanges.quantity,
      priceDiffPaise: exchanges.priceDiffPaise,
      status: exchanges.status,
      requestedAt: exchanges.requestedAt,
      resolvedAt: exchanges.resolvedAt,
    })
    .from(exchanges)
    .leftJoin(orders, eq(exchanges.orderId, orders.id))
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(fromVariants, eq(exchanges.fromVariantId, fromVariants.id))
    .leftJoin(toVariants, eq(exchanges.toVariantId, toVariants.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(exchanges.requestedAt))
    .limit(perPage)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(exchanges)
    .leftJoin(orders, eq(exchanges.orderId, orders.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);
    
  const count = countResult[0]?.count ?? 0;

  const items = results.map(r => ({
    ...r,
    requestedAt: r.requestedAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
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

export async function approveExchange(exchangeId: string) {
  // Real implementation will generate a replacement child order and reserve stock.
  const [exc] = await db.update(exchanges).set({
    status: 'approved',
    updatedAt: new Date(),
  }).where(eq(exchanges.id, exchangeId)).returning();
  
  if (!exc) throw new NotFoundError('Exchange');
  return exc;
}
