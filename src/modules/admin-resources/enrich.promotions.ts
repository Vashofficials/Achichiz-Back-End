/**
 * Derived fields for promotions lists (discounts, upsells, loyalty, referrals).
 */

import { eq, inArray, sql, count, sum } from 'drizzle-orm';
import { db } from '../../config/db.js';
import {
  loyaltyAccounts,
  referralConversions,
} from '../../db/schema/index.js';

type Row = Record<string, unknown>;

export async function enrichAutoDiscounts(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  return rows.map((row) => ({
    ...row,
    // The exact count of orders would require an applied_auto_discount_id in orders.
    // Since auto_discounts apply automatically, we mock 0 for now.
    orders: 0,
  }));
}

export async function enrichUpsellRules(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  return rows.map((row) => ({
    ...row,
    // Exact upsell conversion tracking would require order line item attribution.
    conversion: 0,
    revenue: 0,
  }));
}

export async function enrichLoyaltyTiers(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  const tierIds = [...new Set(rows.map((r) => r.id).filter((v): v is string => typeof v === 'string'))];

  const memberCounts = tierIds.length
    ? await db
        .select({
          tierId: loyaltyAccounts.tierId,
          members: count(),
        })
        .from(loyaltyAccounts)
        .where(inArray(loyaltyAccounts.tierId, tierIds))
        .groupBy(loyaltyAccounts.tierId)
    : [];

  const countById = new Map(
    memberCounts
      .filter((s) => s.tierId !== null)
      .map((s) => [s.tierId as string, Number(s.members || 0)])
  );

  return rows.map((row) => {
    const enriched = { ...row };
    
    if (typeof row.id === 'string') {
      enriched.members = countById.get(row.id) || 0;
    }
    enriched.revenueShare = 0; // Mocked until order aggregation is built

    return enriched;
  });
}

export async function enrichReferrals(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  const referralIds = [...new Set(rows.map((r) => r.id).filter((v): v is string => typeof v === 'string'))];

  const aggregates = referralIds.length
    ? await db
        .select({
          referralId: referralConversions.referralId,
          invited: count(),
          converted: sum(sql`CASE WHEN ${referralConversions.status} IN ('converted', 'rewarded') THEN 1 ELSE 0 END`),
          rewardIssued: sum(referralConversions.rewardIssuedPaise),
        })
        .from(referralConversions)
        .where(inArray(referralConversions.referralId, referralIds))
        .groupBy(referralConversions.referralId)
    : [];

  const map = new Map(
    aggregates.map((s) => [
      s.referralId,
      {
        invited: Number(s.invited || 0),
        converted: Number(s.converted || 0),
        rewardIssued: Number(s.rewardIssued || 0),
      },
    ])
  );

  return rows.map((row) => {
    const enriched = { ...row };
    
    if (typeof row.id === 'string') {
      const agg = map.get(row.id);
      enriched.invited = agg?.invited || 0;
      enriched.converted = agg?.converted || 0;
      enriched.rewardIssued = agg?.rewardIssued || 0;
      enriched.revenue = 0; // Requires linking the first_order_id and aggregating its total
    }

    return enriched;
  });
}
