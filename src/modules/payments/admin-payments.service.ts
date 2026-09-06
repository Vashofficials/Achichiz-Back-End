import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { payments, orders } from '../../db/schema/index.js';
import { NotFoundError } from '../../lib/errors.js';

export async function listPayments(params: {
  page: number;
  perPage: number;
  gateway?: any;
  status?: any;
  isSettled?: 'true' | 'false';
  q?: string;
}) {
  const { page, perPage, gateway, status, isSettled, q } = params;

  let conditions = [];
  if (gateway) conditions.push(eq(payments.gateway, gateway));
  if (status) conditions.push(eq(payments.status, status));
  if (isSettled) conditions.push(eq(payments.isSettled, isSettled === 'true'));
  if (q) {
    conditions.push(or(
      ilike(payments.gatewayPaymentId, `%${q}%`),
      ilike(orders.orderNo, `%${q}%`)
    )!);
  }

  const offset = (page - 1) * perPage;

  const results = await db
    .select({
      id: payments.id,
      paymentNo: payments.gatewayPaymentId,
      orderNo: orders.orderNo,
      gatewayPaymentId: payments.gatewayPaymentId,
      gateway: payments.gateway,
      amountPaise: payments.amountPaise,
      feePaise: payments.feePaise,
      taxOnFeePaise: payments.taxOnFeePaise,
      isSettled: payments.isSettled,
      status: payments.status,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .leftJoin(orders, eq(payments.orderId, orders.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(payments.createdAt))
    .limit(perPage)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(payments)
    .leftJoin(orders, eq(payments.orderId, orders.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);
    
  const count = countResult[0]?.count ?? 0;

  const items = results.map(r => ({
    ...r,
    paymentNo: r.paymentNo || r.id, // Fallback if no gateway ID
    createdAt: r.createdAt.toISOString(),
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

export async function reconcilePayment(paymentId: string, settlementRef: string) {
  const [payment] = await db.update(payments).set({
    isSettled: true,
    settlementRef,
    settledAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(payments.id, paymentId)).returning();
  
  if (!payment) throw new NotFoundError('Payment');
  return payment;
}
