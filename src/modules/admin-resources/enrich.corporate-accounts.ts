/**
 * Derived fields for the corporate-accounts list.
 */

import { eq, inArray, sql, and, ne } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { orders } from '../../db/schema/index.js';

type Row = Record<string, unknown>;

export async function enrichCorporateAccounts(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  const accountIds = [...new Set(rows.map((r) => r.id).filter((v): v is string => typeof v === 'string'))];

  const orderSums = accountIds.length
    ? await db
        .select({
          accountId: orders.corporateAccountId,
          totalPaise: sql<number>`sum(${orders.totalPaise})`,
        })
        .from(orders)
        .where(
          and(
            inArray(orders.corporateAccountId, accountIds),
            ne(orders.status, 'cancelled')
          )
        )
        .groupBy(orders.corporateAccountId)
    : [];

  const lifetimeById = new Map(orderSums.map((s) => [s.accountId, Number(s.totalPaise || 0)]));

  return rows.map((row) => {
    const enriched = { ...row };
    
    if (typeof row.id === 'string') {
      enriched.lifetime = lifetimeById.get(row.id) || 0;
    }

    return enriched;
  });
}
