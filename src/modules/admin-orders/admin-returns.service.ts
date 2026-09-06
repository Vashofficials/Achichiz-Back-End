import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { returns, returnLines, orders, customers, orderLines, productVariants } from '../../db/schema/index.js';
import { NotFoundError } from '../../lib/errors.js';

export async function listReturns(params: {
  page: number;
  perPage: number;
  status?: any;
  q?: string;
}) {
  const { page, perPage, status, q } = params;

  let conditions = [];
  if (status) conditions.push(eq(returns.status, status));
  if (q) {
    conditions.push(or(
      ilike(returns.returnNo, `%${q}%`),
      ilike(orders.orderNo, `%${q}%`)
    )!);
  }

  const offset = (page - 1) * perPage;

  const results = await db
    .select({
      id: returns.id,
      returnNo: returns.returnNo,
      orderNo: orders.orderNo,
      customerName: customers.fullName,
      reason: returns.reason,
      reasonNote: returns.reasonNote,
      status: returns.status,
      refundMode: returns.refundMode,
      refundPaise: returns.refundPaise,
      restock: returns.restock,
      pickupAwb: returns.pickupAwb,
      requestedAt: returns.requestedAt,
      resolvedAt: returns.resolvedAt,
    })
    .from(returns)
    .leftJoin(orders, eq(returns.orderId, orders.id))
    .leftJoin(customers, eq(returns.customerId, customers.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(returns.requestedAt))
    .limit(perPage)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(returns)
    .leftJoin(orders, eq(returns.orderId, orders.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const count = countResult[0]?.count ?? 0;

  const items = await Promise.all(results.map(async (ret) => {
    const lines = await db
      .select({
        id: returnLines.id,
        title: productVariants.optionLabel, // placeholder title
        sku: productVariants.sku,
        quantity: returnLines.quantity,
        condition: returnLines.condition,
        refundPaise: returnLines.refundPaise,
      })
      .from(returnLines)
      .innerJoin(orderLines, eq(returnLines.orderLineId, orderLines.id))
      .leftJoin(productVariants, eq(orderLines.variantId, productVariants.id))
      .where(eq(returnLines.returnId, ret.id));

    return {
      ...ret,
      requestedAt: ret.requestedAt.toISOString(),
      resolvedAt: ret.resolvedAt?.toISOString() ?? null,
      lines: lines.map(l => ({
        ...l,
        title: l.title ?? 'Unknown',
        sku: l.sku ?? '',
      })),
    };
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

export async function approveReturn(returnId: string, pickupAwb?: string) {
  const [ret] = await db.update(returns).set({
    status: 'approved',
    pickupAwb,
    updatedAt: new Date(),
  }).where(eq(returns.id, returnId)).returning();
  if (!ret) throw new NotFoundError('Return');
  return ret;
}

export async function refundReturn(returnId: string, refundPaise: number) {
  const [ret] = await db.update(returns).set({
    status: 'refunded',
    refundPaise,
    resolvedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(returns.id, returnId)).returning();
  if (!ret) throw new NotFoundError('Return');
  return ret;
}

export async function rejectReturn(returnId: string, reasonNote: string) {
  const [ret] = await db.update(returns).set({
    status: 'rejected',
    reasonNote,
    resolvedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(returns.id, returnId)).returning();
  if (!ret) throw new NotFoundError('Return');
  return ret;
}
