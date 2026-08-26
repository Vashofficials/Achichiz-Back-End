/**
 * Drizzle queries for corporate bulk orders. No business rules, no HTTP.
 *
 * A "bulk order" in the API is a `corporate_campaigns` row. The name differs
 * because that is what the console calls it and what the spec's §88 calls it; the
 * table is not renamed, because a rename would be a migration that buys nothing.
 *
 * ## The reservation primitives are duplicated, deliberately
 *
 * `reserveStock`, `releaseReservedQty` and `lockLevels` are the same four lines as
 * in `admin-inventory.repository.ts`, for the reason stated there: a service may
 * call another module's SERVICE, never its repository, and there is no
 * inventory-service operation meaning "hold 800 units for this campaign across
 * four warehouses in one transaction".
 *
 * What is NOT duplicated is the guard. Every copy is the same conditional
 * `UPDATE … WHERE on_hand_qty - reserved_qty >= n`, which is the only shape that
 * is race-free at READ COMMITTED. If that ever differs between copies, the one
 * that differs is wrong.
 */

import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  campaignRecipients,
  corporateAccounts,
  corporateCampaigns,
  inventoryLevels,
  inventoryReservations,
  productVariants,
  products,
  quotations,
  suppliers,
  supplierProducts,
  warehouses,
  type CampaignStatus,
  type CorporateCampaign,
} from '../../db/schema/index.js';

/* ------------------------------------------------------------ campaign reads */

const recipientCount = sql<number>`coalesce((
  SELECT count(*)::int FROM campaign_recipients r
   WHERE r.campaign_id = ${corporateCampaigns.id}), 0)`;

const assignedRecipientCount = sql<number>`coalesce((
  SELECT count(*)::int FROM campaign_recipients r
   WHERE r.campaign_id = ${corporateCampaigns.id} AND r.variant_id IS NOT NULL), 0)`;

const dispatchedRecipientCount = sql<number>`coalesce((
  SELECT count(*)::int FROM campaign_recipients r
   WHERE r.campaign_id = ${corporateCampaigns.id}
     AND r.status IN ('dispatched','delivered')), 0)`;

/** Units currently held for this campaign. Derived, never stored. */
const reservedUnits = sql<number>`coalesce((
  SELECT sum(res.quantity)::int FROM inventory_reservations res
   WHERE res.campaign_id = ${corporateCampaigns.id} AND res.released_at IS NULL), 0)`;

export type CampaignRow = CorporateCampaign & {
  accountName: string | null;
  quotationNo: string | null;
  recipientCount: number;
  assignedRecipientCount: number;
  dispatchedRecipientCount: number;
  reservedUnits: number;
};

const campaignSelection = {
  campaign: corporateCampaigns,
  accountName: corporateAccounts.companyName,
  quotationNo: quotations.quotationNo,
  recipientCount,
  assignedRecipientCount,
  dispatchedRecipientCount,
  reservedUnits,
} as const;

const CAMPAIGN_SORT = {
  createdAt: corporateCampaigns.createdAt,
  campaignNo: corporateCampaigns.campaignNo,
  name: corporateCampaigns.name,
  status: corporateCampaigns.status,
  windowStartOn: corporateCampaigns.windowStartOn,
  budgetPaise: corporateCampaigns.budgetPaise,
} as const;

export const campaignOrderBy = (field: string, direction: 'asc' | 'desc'): SQL => {
  const column = CAMPAIGN_SORT[field as keyof typeof CAMPAIGN_SORT] ?? corporateCampaigns.createdAt;
  return direction === 'desc' ? desc(column) : asc(column);
};

export function campaignFilters(query: {
  status?: string | undefined;
  accountId?: string | undefined;
  ownerId?: string | undefined;
  q?: string | undefined;
}): SQL | undefined {
  const clauses: SQL[] = [];

  if (query.status) {
    const requested = query.status
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is CampaignStatus => CAMPAIGN_STATUS_SET.has(s));
    // Every value unrecognised: match nothing. Returning everything would be a
    // filter that silently does the opposite of what was asked.
    if (requested.length === 0) return sql`false`;
    clauses.push(inArray(corporateCampaigns.status, requested));
  }

  if (query.accountId) clauses.push(eq(corporateCampaigns.accountId, query.accountId));
  if (query.ownerId) clauses.push(eq(corporateCampaigns.ownerId, query.ownerId));
  if (query.q) {
    const pattern = `%${query.q}%`;
    clauses.push(
      sql`(${corporateCampaigns.campaignNo} ILIKE ${pattern}
           OR ${corporateCampaigns.name} ILIKE ${pattern}
           OR coalesce(${corporateAccounts.companyName}, '') ILIKE ${pattern})`,
    );
  }

  return clauses.length > 0 ? and(...clauses) : undefined;
}

const CAMPAIGN_STATUS_SET = new Set<string>([
  'planning',
  'recipients_pending',
  'in_dispatch',
  'completed',
  'cancelled',
]);

export async function listCampaigns(
  where: SQL | undefined,
  orderBy: SQL,
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<CampaignRow[]> {
  const rows = await exec
    .select(campaignSelection)
    .from(corporateCampaigns)
    .leftJoin(corporateAccounts, eq(corporateAccounts.id, corporateCampaigns.accountId))
    .leftJoin(quotations, eq(quotations.id, corporateCampaigns.quotationId))
    .where(where)
    .orderBy(orderBy, asc(corporateCampaigns.id))
    .limit(limit)
    .offset(offset);

  return rows.map(toCampaignRow);
}

export async function countCampaigns(where: SQL | undefined, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ n: count() })
    .from(corporateCampaigns)
    .leftJoin(corporateAccounts, eq(corporateAccounts.id, corporateCampaigns.accountId))
    .leftJoin(quotations, eq(quotations.id, corporateCampaigns.quotationId))
    .where(where);
  return rows[0]?.n ?? 0;
}

export async function findCampaign(
  campaignId: string,
  exec: Executor = db,
): Promise<CampaignRow | undefined> {
  const rows = await exec
    .select(campaignSelection)
    .from(corporateCampaigns)
    .leftJoin(corporateAccounts, eq(corporateAccounts.id, corporateCampaigns.accountId))
    .leftJoin(quotations, eq(quotations.id, corporateCampaigns.quotationId))
    .where(eq(corporateCampaigns.id, campaignId))
    .limit(1);

  const row = rows[0];
  return row ? toCampaignRow(row) : undefined;
}

type CampaignSelectionRow = {
  campaign: CorporateCampaign;
  accountName: string | null;
  quotationNo: string | null;
  recipientCount: number;
  assignedRecipientCount: number;
  dispatchedRecipientCount: number;
  reservedUnits: number;
};

const toCampaignRow = (r: CampaignSelectionRow): CampaignRow => ({
  ...r.campaign,
  accountName: r.accountName,
  quotationNo: r.quotationNo,
  recipientCount: r.recipientCount,
  assignedRecipientCount: r.assignedRecipientCount,
  dispatchedRecipientCount: r.dispatchedRecipientCount,
  reservedUnits: r.reservedUnits,
});

/** Locks the campaign row so two reserve calls queue rather than double-hold. */
export async function lockCampaign(
  tx: Tx,
  campaignId: string,
): Promise<CorporateCampaign | undefined> {
  const rows = await tx
    .select()
    .from(corporateCampaigns)
    .where(eq(corporateCampaigns.id, campaignId))
    .for('update')
    .limit(1);
  return rows[0];
}

export async function findAccount(
  accountId: string,
  exec: Executor = db,
): Promise<{ id: string; companyName: string } | undefined> {
  const rows = await exec
    .select({ id: corporateAccounts.id, companyName: corporateAccounts.companyName })
    .from(corporateAccounts)
    .where(and(eq(corporateAccounts.id, accountId), isNull(corporateAccounts.deletedAt)))
    .limit(1);
  return rows[0];
}

export async function findQuotation(
  quotationId: string,
  exec: Executor = db,
): Promise<{ id: string; quotationNo: string; accountId: string | null } | undefined> {
  const rows = await exec
    .select({
      id: quotations.id,
      quotationNo: quotations.quotationNo,
      accountId: quotations.accountId,
    })
    .from(quotations)
    .where(and(eq(quotations.id, quotationId), isNull(quotations.deletedAt)))
    .limit(1);
  return rows[0];
}

/* ------------------------------------------------------------ campaign writes */

/**
 * `CMP-2026-00001` from the same row-locked series every other document uses.
 * Improvising a number here would collide with the real series the first time
 * both ran.
 */
export async function nextCampaignNumber(tx: Tx, year: number): Promise<string> {
  const scope = String(year);
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('campaign', ${scope}, ${`CMP-${scope}-`}, '', 5, 1)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ campaign_no: string }>(
    sql`SELECT next_document_number('campaign', ${scope}) AS campaign_no`,
  );
  const campaignNo = result.rows[0]?.campaign_no;
  if (!campaignNo) throw new Error('next_document_number returned no campaign number');
  return campaignNo;
}

export async function insertCampaign(
  tx: Tx,
  values: typeof corporateCampaigns.$inferInsert,
): Promise<CorporateCampaign> {
  const rows = await tx.insert(corporateCampaigns).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('corporate_campaigns insert returned no row');
  return row;
}

export async function updateCampaign(
  tx: Tx,
  campaignId: string,
  patch: Partial<typeof corporateCampaigns.$inferInsert>,
): Promise<void> {
  await tx
    .update(corporateCampaigns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(corporateCampaigns.id, campaignId));
}

/* ------------------------------------------------------------------ demand */

export type RecipientRow = {
  id: string;
  name: string;
  variantId: string | null;
  status: string;
  stateCode: string | null;
  city: string | null;
  pincode: string | null;
};

export async function findRecipients(
  campaignId: string,
  exec: Executor = db,
): Promise<RecipientRow[]> {
  return exec
    .select({
      id: campaignRecipients.id,
      name: campaignRecipients.name,
      variantId: campaignRecipients.variantId,
      status: campaignRecipients.status,
      stateCode: campaignRecipients.stateCode,
      city: campaignRecipients.city,
      pincode: campaignRecipients.pincode,
    })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))
    .orderBy(asc(campaignRecipients.id));
}

export type VariantLabel = { variantId: string; sku: string; name: string };

export async function findVariantLabels(
  variantIds: readonly string[],
  exec: Executor = db,
): Promise<VariantLabel[]> {
  if (variantIds.length === 0) return [];
  return exec
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      name: sql<string>`${products.title} || ' — ' || ${productVariants.optionLabel}`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, [...variantIds]));
}

export type PositionRow = {
  inventoryLevelId: string;
  variantId: string;
  warehouseId: string;
  warehouseName: string | null;
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
};

/**
 * Every warehouse position for a set of variants.
 *
 * `available_qty` is the GENERATED column `on_hand_qty - reserved_qty`, so it
 * cannot drift from the two it is computed from. Allocation uses SELLABLE stock
 * — a unit already held for somebody else's order is not available to this
 * campaign however physically present it is.
 */
export async function findPositions(
  variantIds: readonly string[],
  warehouseId: string | undefined,
  exec: Executor = db,
): Promise<PositionRow[]> {
  if (variantIds.length === 0) return [];

  const clauses: SQL[] = [inArray(inventoryLevels.variantId, [...variantIds])];
  if (warehouseId) clauses.push(eq(inventoryLevels.warehouseId, warehouseId));

  const rows = await exec
    .select({
      inventoryLevelId: inventoryLevels.id,
      variantId: inventoryLevels.variantId,
      warehouseId: inventoryLevels.warehouseId,
      warehouseName: warehouses.name,
      onHandQty: inventoryLevels.onHandQty,
      reservedQty: inventoryLevels.reservedQty,
      availableQty: inventoryLevels.availableQty,
    })
    .from(inventoryLevels)
    .leftJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .where(and(...clauses, isNull(warehouses.deletedAt)))
    .orderBy(asc(inventoryLevels.id));

  return rows
    .filter((r): r is typeof r & { variantId: string } => r.variantId !== null)
    .map((r) => ({
      inventoryLevelId: r.inventoryLevelId,
      variantId: r.variantId,
      warehouseId: r.warehouseId,
      warehouseName: r.warehouseName,
      onHandQty: r.onHandQty,
      reservedQty: r.reservedQty,
      availableQty: r.availableQty ?? r.onHandQty - r.reservedQty,
    }));
}

export type SupplierTermsRow = {
  variantId: string;
  supplierId: string;
  supplierName: string;
  moq: number;
  leadTimeDays: number;
  unitCostPaise: number;
};

/**
 * The preferred supplier's terms per variant.
 *
 * `DISTINCT ON` with `is_preferred DESC` picks the preferred row when one exists
 * and the cheapest otherwise — one query rather than a preferred lookup plus a
 * fallback lookup, and no variant can come back twice and silently double a
 * procurement line.
 */
export async function findSupplierTerms(
  variantIds: readonly string[],
  exec: Executor = db,
): Promise<SupplierTermsRow[]> {
  if (variantIds.length === 0) return [];

  const rows = await exec
    .selectDistinctOn([supplierProducts.variantId], {
      variantId: supplierProducts.variantId,
      supplierId: supplierProducts.supplierId,
      supplierName: suppliers.name,
      moq: supplierProducts.moq,
      leadTimeDays: supplierProducts.leadTimeDays,
      unitCostPaise: supplierProducts.unitCostPaise,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(
      and(
        inArray(supplierProducts.variantId, [...variantIds]),
        isNull(supplierProducts.deletedAt),
        isNull(suppliers.deletedAt),
      ),
    )
    .orderBy(
      asc(supplierProducts.variantId),
      desc(supplierProducts.isPreferred),
      asc(supplierProducts.unitCostPaise),
    );

  return rows.filter((r): r is SupplierTermsRow => r.variantId !== null);
}

/* ------------------------------------------------------------- reservations */

/**
 * Locks taken up front in ascending id order.
 *
 * Without it, campaign A holding level 1 and wanting level 2 deadlocks against
 * campaign B holding 2 and wanting 1. PostgreSQL detects it and aborts one, but a
 * `deadlock_timeout` stall is not an acceptable way to find out.
 */
export async function lockLevels(tx: Tx, levelIds: readonly string[]): Promise<void> {
  if (levelIds.length === 0) return;
  await tx
    .select({ id: inventoryLevels.id })
    .from(inventoryLevels)
    .where(inArray(inventoryLevels.id, [...levelIds]))
    .orderBy(asc(inventoryLevels.id))
    .for('update');
}

/**
 * THE reservation guard (§62/§14).
 *
 * Moves `reserved_qty` and NOTHING else — the units have not moved, they are only
 * spoken for. No `stock_movements` row is written either: the ledger tracks
 * physical movement, and a hold appearing in it would double-count against
 * `balance_after` the moment the goods actually shipped.
 *
 * Returns false when the conditional refused, meaning zero rows updated.
 */
export async function reserveStock(tx: Tx, levelId: string, quantity: number, at: Date): Promise<boolean> {
  const rows = await tx
    .update(inventoryLevels)
    .set({ reservedQty: sql`${inventoryLevels.reservedQty} + ${quantity}`, updatedAt: at })
    .where(
      and(
        eq(inventoryLevels.id, levelId),
        sql`${inventoryLevels.onHandQty} - ${inventoryLevels.reservedQty} >= ${quantity}`,
      ),
    )
    .returning({ id: inventoryLevels.id });
  return rows.length === 1;
}

export async function releaseReservedQty(
  tx: Tx,
  levelId: string,
  quantity: number,
  at: Date,
): Promise<boolean> {
  const rows = await tx
    .update(inventoryLevels)
    .set({ reservedQty: sql`${inventoryLevels.reservedQty} - ${quantity}`, updatedAt: at })
    .where(and(eq(inventoryLevels.id, levelId), sql`${inventoryLevels.reservedQty} >= ${quantity}`))
    .returning({ id: inventoryLevels.id });
  return rows.length === 1;
}

export async function insertCampaignReservation(
  tx: Tx,
  values: { campaignId: string; inventoryLevelId: string; quantity: number },
): Promise<{ id: string }> {
  const rows = await tx
    .insert(inventoryReservations)
    .values({
      campaignId: values.campaignId,
      inventoryLevelId: values.inventoryLevelId,
      quantity: values.quantity,
      // `quotation` is the reason a corporate hold carries. Migration 0004 made
      // it insertable — before that it satisfied the reason CHECK and violated
      // `reservation_has_owner` for every possible row.
      reason: 'quotation',
      // Deliberately null: a campaign hold is released explicitly or by
      // fulfilment, never by a timer. `reservation_campaign_no_expiry` enforces it.
      expiresAt: null,
    })
    .returning({ id: inventoryReservations.id });

  const row = rows[0];
  if (!row) throw new Error('inventory_reservations insert returned nothing');
  return row;
}

export type CampaignReservationRow = {
  id: string;
  inventoryLevelId: string;
  variantId: string | null;
  warehouseId: string;
  warehouseName: string | null;
  quantity: number;
  createdAt: Date;
};

export async function findActiveCampaignReservations(
  campaignId: string,
  exec: Executor = db,
): Promise<CampaignReservationRow[]> {
  return exec
    .select({
      id: inventoryReservations.id,
      inventoryLevelId: inventoryReservations.inventoryLevelId,
      variantId: inventoryLevels.variantId,
      warehouseId: inventoryLevels.warehouseId,
      warehouseName: warehouses.name,
      quantity: inventoryReservations.quantity,
      createdAt: inventoryReservations.createdAt,
    })
    .from(inventoryReservations)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, inventoryReservations.inventoryLevelId))
    .leftJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .where(
      and(eq(inventoryReservations.campaignId, campaignId), isNull(inventoryReservations.releasedAt)),
    )
    .orderBy(asc(inventoryReservations.inventoryLevelId));
}

/**
 * Claim the release. `released_at IS NULL` in the WHERE is what makes a double
 * release a no-op instead of a double decrement of `reserved_qty`.
 */
export async function markCampaignReservationsReleased(
  tx: Tx,
  reservationIds: readonly string[],
  at: Date,
): Promise<{ id: string; inventoryLevelId: string; quantity: number }[]> {
  if (reservationIds.length === 0) return [];
  return tx
    .update(inventoryReservations)
    .set({ releasedAt: at })
    .where(
      and(
        inArray(inventoryReservations.id, [...reservationIds]),
        isNull(inventoryReservations.releasedAt),
      ),
    )
    .returning({
      id: inventoryReservations.id,
      inventoryLevelId: inventoryReservations.inventoryLevelId,
      quantity: inventoryReservations.quantity,
    });
}
