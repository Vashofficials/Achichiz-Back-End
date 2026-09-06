import { and, desc, eq, ilike, isNotNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { carts, cartLines, customers, productVariants } from '../../db/schema/index.js';

export async function listAbandonedCarts(params: {
  page: number;
  perPage: number;
  stage?: 'cart' | 'address' | 'payment';
  recoveryState?: 'not_sent' | 'email_sent' | 'whatsapp_sent' | 'recovered';
  q?: string;
}) {
  const { page, perPage, stage, recoveryState, q } = params;

  let conditions = [
    isNotNull(carts.abandonedAt),
    ne(carts.stage, 'converted'),
  ];

  if (stage) conditions.push(eq(carts.stage, stage));
  if (recoveryState) conditions.push(eq(carts.recoveryState, recoveryState));
  if (q) {
    conditions.push(or(
      ilike(carts.email, `%${q}%`),
      ilike(carts.mobile, `%${q}%`)
    )!);
  }

  const offset = (page - 1) * perPage;

  const results = await db
    .select({
      id: carts.id,
      customerName: customers.fullName,
      email: carts.email,
      mobile: carts.mobile,
      stage: carts.stage,
      abandonedAt: carts.abandonedAt,
      recoveryState: carts.recoveryState,
    })
    .from(carts)
    .leftJoin(customers, eq(carts.customerId, customers.id))
    .where(and(...conditions))
    .orderBy(desc(carts.abandonedAt))
    .limit(perPage)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(carts)
    .where(and(...conditions));
  
  const count = countResult[0]?.count ?? 0;

  const items = await Promise.all(results.map(async (cart) => {
    const lines = await db
      .select({
        id: cartLines.id,
        title: productVariants.optionLabel, // Just a placeholder for title since we would need a join on products
        variantLabel: productVariants.optionLabel,
        sku: productVariants.sku,
        quantity: cartLines.quantity,
        unitPricePaise: cartLines.unitPricePaise,
      })
      .from(cartLines)
      .leftJoin(productVariants, eq(cartLines.variantId, productVariants.id))
      .where(eq(cartLines.cartId, cart.id));

    return {
      ...cart,
      abandonedAt: cart.abandonedAt?.toISOString() ?? null,
      itemCount: lines.reduce((acc, l) => acc + l.quantity, 0),
      totalPaise: lines.reduce((acc, l) => acc + (l.quantity * l.unitPricePaise), 0),
      lines: lines.map(l => ({
        id: l.id,
        title: l.title ?? 'Unknown Product',
        variantLabel: l.variantLabel ?? '',
        sku: l.sku ?? '',
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
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

export async function remindCart(cartId: string, method: 'email' | 'whatsapp') {
  // In a real implementation this drops a job into BullMQ
  // For now we update the DB state to mimic the worker output
  
  await db
    .update(carts)
    .set({
      recoveryState: method === 'email' ? 'email_sent' : 'whatsapp_sent',
      recoverySentAt: new Date(),
    })
    .where(eq(carts.id, cartId));
}
