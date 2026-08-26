import type { AnyPgColumn } from 'drizzle-orm/pg-core';
/**
 * Drizzle queries for supplier catalogues, POs, GRNs and purchase returns.
 * No business rules, no HTTP.
 *
 * ## On the four functions that look like copies of `admin-warehousing.repository`
 *
 * `ensureLevel`, `adjustOnHand`, `adjustIncoming`, `insertMovement` and
 * `lockLevels` are, deliberately. The module boundary this codebase enforces is
 * "a service may call another module's SERVICE, never its repository" — and
 * there is no warehousing *service* operation that means "add 7 units to this
 * level because a supplier delivered them". Wrapping one would put purchasing's
 * rules inside warehousing. `admin-orders.repository.ts` makes the same trade
 * for `releaseReservations`, for the same reason: the SQL is identical because
 * the physical operation is identical.
 *
 * The one thing that must not be duplicated is the *guard*, and it is not: both
 * copies are the same conditional `UPDATE ... WHERE on_hand_qty - reserved_qty >= n`
 * returning the new balance, which is the only shape that is race-free at READ
 * COMMITTED.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  goodsReceiptLines,
  goodsReceipts,
  hamperItems,
  inventoryLevels,
  packagingMaterials,
  productVariants,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReturnLines,
  purchaseReturns,
  stockMovements,
  supplierProducts,
  suppliers,
  warehouses,
  type GoodsReceipt,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type PurchaseOrderStatus,
  type PurchaseReturn,
  type PurchaseReturnStatus,
  type StockMovementType,
  type StockReferenceType,
  type SupplierProduct,
} from '../../db/schema/index.js';

/* ============================================================ shared lookups */

export async function findSupplier(
  supplierId: string,
  exec: Executor = db,
): Promise<{ id: string; name: string; code: string } | undefined> {
  const rows = await exec
    .select({ id: suppliers.id, name: suppliers.name, code: suppliers.code })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), isNull(suppliers.deletedAt)))
    .limit(1);
  return rows[0];
}

export async function findWarehouse(
  warehouseId: string,
  exec: Executor = db,
): Promise<{ id: string; name: string } | undefined> {
  const rows = await exec
    .select({ id: warehouses.id, name: warehouses.name })
    .from(warehouses)
    .where(and(eq(warehouses.id, warehouseId), isNull(warehouses.deletedAt)))
    .limit(1);
  return rows[0];
}

export async function supplierNames(ids: readonly string[], exec: Executor = db): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await exec
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(inArray(suppliers.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function warehouseNames(ids: readonly string[], exec: Executor = db): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await exec
    .select({ id: warehouses.id, name: warehouses.name })
    .from(warehouses)
    .where(inArray(warehouses.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Live ids for each of the three stockable kinds, for validating lines before anything is written. */
export async function liveStockables(
  ids: { variantIds: readonly string[]; hamperItemIds: readonly string[]; packagingIds: readonly string[] },
  exec: Executor = db,
): Promise<Set<string>> {
  const found = new Set<string>();

  if (ids.variantIds.length > 0) {
    const rows = await exec
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(and(inArray(productVariants.id, [...ids.variantIds]), isNull(productVariants.deletedAt)));
    for (const r of rows) found.add(r.id);
  }
  if (ids.hamperItemIds.length > 0) {
    const rows = await exec
      .select({ id: hamperItems.id })
      .from(hamperItems)
      .where(and(inArray(hamperItems.id, [...ids.hamperItemIds]), isNull(hamperItems.deletedAt)));
    for (const r of rows) found.add(r.id);
  }
  if (ids.packagingIds.length > 0) {
    const rows = await exec
      .select({ id: packagingMaterials.id })
      .from(packagingMaterials)
      .where(and(inArray(packagingMaterials.id, [...ids.packagingIds]), isNull(packagingMaterials.deletedAt)));
    for (const r of rows) found.add(r.id);
  }
  return found;
}

/* ========================================================== stock primitives */

export type StockableRef = { variantId: string | null; hamperItemId: string | null; packagingId: string | null };

const levelMatch = (warehouseId: string, ref: StockableRef): SQL | undefined =>
  and(
    eq(inventoryLevels.warehouseId, warehouseId),
    ref.variantId ? eq(inventoryLevels.variantId, ref.variantId) : isNull(inventoryLevels.variantId),
    ref.hamperItemId ? eq(inventoryLevels.hamperItemId, ref.hamperItemId) : isNull(inventoryLevels.hamperItemId),
    ref.packagingId ? eq(inventoryLevels.packagingId, ref.packagingId) : isNull(inventoryLevels.packagingId),
  );

/** See the warehousing copy. `ON CONFLICT DO NOTHING` then re-select, so an insert race resolves to one row. */
export async function ensureLevel(
  tx: Tx,
  warehouseId: string,
  ref: StockableRef,
): Promise<{ id: string; onHandQty: number }> {
  const match = levelMatch(warehouseId, ref);

  const existing = await tx
    .select({ id: inventoryLevels.id, onHandQty: inventoryLevels.onHandQty })
    .from(inventoryLevels)
    .where(match)
    .limit(1);
  const found = existing[0];
  if (found) return found;

  await tx
    .insert(inventoryLevels)
    .values({
      warehouseId,
      variantId: ref.variantId,
      hamperItemId: ref.hamperItemId,
      packagingId: ref.packagingId,
      onHandQty: 0,
      reservedQty: 0,
    })
    .onConflictDoNothing();

  const after = await tx
    .select({ id: inventoryLevels.id, onHandQty: inventoryLevels.onHandQty })
    .from(inventoryLevels)
    .where(match)
    .limit(1);
  const row = after[0];
  if (!row) throw new Error('inventory level could not be created or read back');
  return row;
}

export async function findLevelById(
  tx: Tx,
  levelId: string,
): Promise<{ id: string; warehouseId: string; onHandQty: number; reservedQty: number } | undefined> {
  const rows = await tx
    .select({
      id: inventoryLevels.id,
      warehouseId: inventoryLevels.warehouseId,
      onHandQty: inventoryLevels.onHandQty,
      reservedQty: inventoryLevels.reservedQty,
    })
    .from(inventoryLevels)
    .where(eq(inventoryLevels.id, levelId))
    .limit(1);
  return rows[0];
}

/**
 * THE oversell guard (§62/§64), same statement as the warehousing copy.
 *
 * Returns the new `on_hand_qty` — which IS the movement's `balance_after` — or
 * `null` when the conditional refused, meaning zero rows updated and nothing
 * written. Reserved units belong to open carts and orders, so they are not
 * available to send back to a supplier either.
 */
export async function adjustOnHand(tx: Tx, levelId: string, delta: number): Promise<number | null> {
  if (delta === 0) throw new Error('adjustOnHand called with a zero delta — a movement of nothing is not a movement');

  const guard = delta < 0 ? sql` AND on_hand_qty - reserved_qty >= ${-delta}` : sql``;

  const result = await tx.execute<{ on_hand_qty: number }>(sql`
    UPDATE inventory_levels
       SET on_hand_qty = on_hand_qty + ${delta},
           last_movement_at = now(),
           updated_at = now()
     WHERE id = ${levelId}${guard}
    RETURNING on_hand_qty`);

  return result.rows[0]?.on_hand_qty ?? null;
}

/** `incoming_qty`: raised when a PO is SENT, lowered when goods arrive. Clamped, because it is a projection. */
export async function adjustIncoming(tx: Tx, levelId: string, delta: number): Promise<void> {
  if (delta === 0) return;
  await tx.execute(sql`
    UPDATE inventory_levels
       SET incoming_qty = GREATEST(incoming_qty + ${delta}, 0),
           updated_at = now()
     WHERE id = ${levelId}`);
}

/** Locks taken up front in ascending id order, so concurrent receipts queue rather than deadlock. */
export async function lockLevels(tx: Tx, levelIds: readonly string[]): Promise<void> {
  if (levelIds.length === 0) return;
  await tx
    .select({ id: inventoryLevels.id })
    .from(inventoryLevels)
    .where(inArray(inventoryLevels.id, [...levelIds]))
    .orderBy(asc(inventoryLevels.id))
    .for('update');
}

/** The ledger is append-only. There is deliberately no `updateMovement`. */
export async function insertMovement(
  tx: Tx,
  values: {
    inventoryLevelId: string;
    movementType: StockMovementType;
    quantityDelta: number;
    balanceAfter: number;
    referenceType: StockReferenceType;
    referenceId: string;
    referenceLabel: string;
    note?: string | null;
    actorId?: string | null;
  },
): Promise<void> {
  await tx.insert(stockMovements).values({
    inventoryLevelId: values.inventoryLevelId,
    movementType: values.movementType,
    quantityDelta: values.quantityDelta,
    balanceAfter: values.balanceAfter,
    referenceType: values.referenceType,
    referenceId: values.referenceId,
    referenceLabel: values.referenceLabel,
    note: values.note ?? null,
    actorId: values.actorId ?? null,
  });
}

/* ======================================================== supplier products */

const supplierProductSku = sql<string | null>`coalesce(
  (SELECT pv.sku FROM product_variants pv WHERE pv.id = ${supplierProducts.variantId}),
  (SELECT hi.sku FROM hamper_items hi WHERE hi.id = ${supplierProducts.hamperItemId}),
  (SELECT pm.sku FROM packaging_materials pm WHERE pm.id = ${supplierProducts.packagingId}))`;

const supplierProductTitle = sql<string | null>`coalesce(
  (SELECT p.title || ' — ' || pv.option_label
     FROM product_variants pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = ${supplierProducts.variantId}),
  (SELECT hi.name FROM hamper_items hi WHERE hi.id = ${supplierProducts.hamperItemId}),
  (SELECT pm.name FROM packaging_materials pm WHERE pm.id = ${supplierProducts.packagingId}))`;

export type SupplierProductRow = SupplierProduct & { sku: string | null; title: string | null };

const SUPPLIER_PRODUCT_SORT = {
  unitCostPaise: supplierProducts.unitCostPaise,
  leadTimeDays: supplierProducts.leadTimeDays,
  moq: supplierProducts.moq,
  createdAt: supplierProducts.createdAt,
} as const;

export function supplierProductOrderBy(field: string, direction: 'asc' | 'desc'): SQL {
  const column = SUPPLIER_PRODUCT_SORT[field as keyof typeof SUPPLIER_PRODUCT_SORT];
  if (!column) {
    return direction === 'desc'
      ? sql`${supplierProductSku} DESC NULLS LAST`
      : sql`${supplierProductSku} ASC NULLS LAST`;
  }
  return direction === 'desc' ? desc(column) : asc(column);
}

export const supplierProductSearch = (pattern: string): SQL =>
  sql`(${supplierProductSku} ILIKE ${pattern}
       OR ${supplierProductTitle} ILIKE ${pattern}
       OR coalesce(${supplierProducts.supplierSku}, '') ILIKE ${pattern})`;

export async function listSupplierProducts(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<{ rows: SupplierProductRow[]; total: number }> {
  const rows = await exec
    .select({ entry: supplierProducts, sku: supplierProductSku, title: supplierProductTitle })
    .from(supplierProducts)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const counted = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(supplierProducts)
    .where(where);

  return {
    rows: rows.map((r) => ({ ...r.entry, sku: r.sku, title: r.title })),
    total: counted[0]?.n ?? 0,
  };
}

export async function findSupplierProduct(
  supplierId: string,
  supplierProductId: string,
  exec: Executor = db,
): Promise<SupplierProductRow | undefined> {
  const rows = await exec
    .select({ entry: supplierProducts, sku: supplierProductSku, title: supplierProductTitle })
    .from(supplierProducts)
    .where(and(eq(supplierProducts.id, supplierProductId), eq(supplierProducts.supplierId, supplierId)))
    .limit(1);
  const row = rows[0];
  return row ? { ...row.entry, sku: row.sku, title: row.title } : undefined;
}

/**
 * Demote whoever currently holds `is_preferred` for this variant.
 *
 * The write-order gotcha the schema README calls out for default addresses
 * applies verbatim: `uq_supplier_products_preferred_variant` is a partial unique
 * INDEX and cannot be deferred, so the incumbent must be cleared FIRST, in the
 * same transaction, or the insert collides with a row that is about to change.
 */
export async function demotePreferredForVariant(tx: Tx, variantId: string, exceptId: string | null): Promise<void> {
  const conditions = [
    eq(supplierProducts.variantId, variantId),
    eq(supplierProducts.isPreferred, true),
    isNull(supplierProducts.deletedAt),
  ];
  await tx
    .update(supplierProducts)
    .set({ isPreferred: false, updatedAt: new Date() })
    .where(exceptId ? and(...conditions, sql`${supplierProducts.id} <> ${exceptId}`) : and(...conditions));
}

export async function insertSupplierProduct(
  tx: Tx,
  values: typeof supplierProducts.$inferInsert,
): Promise<SupplierProduct> {
  const rows = await tx.insert(supplierProducts).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('supplier_products insert returned no row');
  return row;
}

export async function updateSupplierProduct(
  tx: Tx,
  supplierProductId: string,
  patch: Partial<typeof supplierProducts.$inferInsert>,
): Promise<void> {
  await tx.update(supplierProducts).set(patch).where(eq(supplierProducts.id, supplierProductId));
}

/** Is this supplier already selling this target? The partial unique index refuses a second live row. */
export async function findSupplierProductByTarget(
  tx: Tx,
  supplierId: string,
  ref: StockableRef,
): Promise<{ id: string; deletedAt: Date | null } | undefined> {
  const rows = await tx
    .select({ id: supplierProducts.id, deletedAt: supplierProducts.deletedAt })
    .from(supplierProducts)
    .where(
      and(
        eq(supplierProducts.supplierId, supplierId),
        ref.variantId ? eq(supplierProducts.variantId, ref.variantId) : isNull(supplierProducts.variantId),
        ref.hamperItemId ? eq(supplierProducts.hamperItemId, ref.hamperItemId) : isNull(supplierProducts.hamperItemId),
        ref.packagingId ? eq(supplierProducts.packagingId, ref.packagingId) : isNull(supplierProducts.packagingId),
        isNull(supplierProducts.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

/* ========================================================== purchase orders */

export type PoRow = PurchaseOrder;
export type PoLineRow = PurchaseOrderLine & { sku: string | null };

const PO_SORT = {
  createdAt: purchaseOrders.createdAt,
  poNo: purchaseOrders.poNo,
  status: purchaseOrders.status,
  expectedOn: purchaseOrders.expectedOn,
  totalPaise: purchaseOrders.totalPaise,
} as const;

export const poSortColumn = (field: string): AnyPgColumn =>
  PO_SORT[field as keyof typeof PO_SORT] ?? purchaseOrders.createdAt;

export const poStatusIn = (values: readonly PurchaseOrderStatus[]): SQL | undefined =>
  values.length > 0 ? inArray(purchaseOrders.status, [...values]) : undefined;

export const poExpectedFrom = (date: string): SQL => gte(purchaseOrders.expectedOn, date);
export const poExpectedTo = (date: string): SQL => lte(purchaseOrders.expectedOn, date);

/** `PO-2026-02291` from the row-locked series. The '2026' scope is seeded by 0001. */
export async function nextPoNumber(tx: Tx, year: number): Promise<string> {
  const scope = String(year);
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('purchase_order', ${scope}, ${`PO-${scope}-`}, '', 5, 1)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ po_no: string }>(
    sql`SELECT next_document_number('purchase_order', ${scope}) AS po_no`,
  );
  const poNo = result.rows[0]?.po_no;
  if (!poNo) throw new Error('next_document_number returned no purchase order number');
  return poNo;
}

export async function listPurchaseOrders(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<{ rows: (PoRow & { lineCount: number; orderedQty: number; receivedQty: number })[]; total: number }> {
  const lineCount = sql<number>`coalesce((
    SELECT count(*)::int FROM purchase_order_lines l WHERE l.purchase_order_id = ${purchaseOrders.id}), 0)`;
  const orderedQty = sql<number>`coalesce((
    SELECT sum(l.ordered_qty)::int FROM purchase_order_lines l WHERE l.purchase_order_id = ${purchaseOrders.id}), 0)`;
  const receivedQty = sql<number>`coalesce((
    SELECT sum(l.received_qty)::int FROM purchase_order_lines l WHERE l.purchase_order_id = ${purchaseOrders.id}), 0)`;

  const rows = await exec
    .select({ po: purchaseOrders, lineCount, orderedQty, receivedQty })
    .from(purchaseOrders)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const counted = await exec.select({ n: sql<number>`count(*)::int` }).from(purchaseOrders).where(where);

  return {
    rows: rows.map((r) => ({
      ...r.po,
      lineCount: r.lineCount,
      orderedQty: r.orderedQty,
      receivedQty: r.receivedQty,
    })),
    total: counted[0]?.n ?? 0,
  };
}

export async function findPurchaseOrder(poId: string, exec: Executor = db): Promise<PoRow | undefined> {
  const rows = await exec.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).limit(1);
  return rows[0];
}

export async function lockPurchaseOrder(tx: Tx, poId: string): Promise<PoRow | undefined> {
  const rows = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).for('update').limit(1);
  return rows[0];
}

const poLineSku = sql<string | null>`coalesce(
  (SELECT pv.sku FROM product_variants pv WHERE pv.id = ${purchaseOrderLines.variantId}),
  (SELECT hi.sku FROM hamper_items hi WHERE hi.id = ${purchaseOrderLines.hamperItemId}),
  (SELECT pm.sku FROM packaging_materials pm WHERE pm.id = ${purchaseOrderLines.packagingId}))`;

export async function findPoLines(poId: string, exec: Executor = db): Promise<PoLineRow[]> {
  const rows = await exec
    .select({ line: purchaseOrderLines, sku: poLineSku })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, poId))
    .orderBy(asc(purchaseOrderLines.position), asc(purchaseOrderLines.id));
  return rows.map((r) => ({ ...r.line, sku: r.sku }));
}

export async function insertPurchaseOrder(
  tx: Tx,
  values: typeof purchaseOrders.$inferInsert,
): Promise<PoRow> {
  const rows = await tx.insert(purchaseOrders).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('purchase_orders insert returned no row');
  return row;
}

export async function insertPoLines(tx: Tx, values: (typeof purchaseOrderLines.$inferInsert)[]): Promise<void> {
  if (values.length === 0) return;
  await tx.insert(purchaseOrderLines).values(values);
}

export async function deletePoLines(tx: Tx, poId: string): Promise<void> {
  await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
}

export async function updatePurchaseOrder(
  tx: Tx,
  poId: string,
  patch: Partial<typeof purchaseOrders.$inferInsert>,
): Promise<void> {
  await tx.update(purchaseOrders).set(patch).where(eq(purchaseOrders.id, poId));
}

export async function addPoLineReceived(tx: Tx, lineId: string, delta: number): Promise<void> {
  await tx
    .update(purchaseOrderLines)
    .set({ receivedQty: sql`${purchaseOrderLines.receivedQty} + ${delta}` })
    .where(eq(purchaseOrderLines.id, lineId));
}

/** Bump the supplier catalogue's "last purchased" columns when a PO goes out. Best effort — nothing depends on it. */
export async function touchSupplierProducts(
  tx: Tx,
  supplierId: string,
  lines: readonly { variantId: string | null; hamperItemId: string | null; packagingId: string | null; unitCostPaise: number }[],
  at: Date,
): Promise<void> {
  for (const line of lines) {
    await tx
      .update(supplierProducts)
      .set({ lastPurchaseAt: at, lastPurchaseCostPaise: line.unitCostPaise, updatedAt: at })
      .where(
        and(
          eq(supplierProducts.supplierId, supplierId),
          line.variantId ? eq(supplierProducts.variantId, line.variantId) : isNull(supplierProducts.variantId),
          line.hamperItemId
            ? eq(supplierProducts.hamperItemId, line.hamperItemId)
            : isNull(supplierProducts.hamperItemId),
          line.packagingId ? eq(supplierProducts.packagingId, line.packagingId) : isNull(supplierProducts.packagingId),
          isNull(supplierProducts.deletedAt),
        ),
      );
  }
}

/* ========================================================== goods receipts */

export type GrnRow = GoodsReceipt;

const GRN_SORT = {
  receivedOn: goodsReceipts.receivedOn,
  grnNo: goodsReceipts.grnNo,
  createdAt: goodsReceipts.createdAt,
} as const;

export const grnSortColumn = (field: string): AnyPgColumn =>
  GRN_SORT[field as keyof typeof GRN_SORT] ?? goodsReceipts.receivedOn;

export const grnReceivedFrom = (date: string): SQL => gte(goodsReceipts.receivedOn, date);
export const grnReceivedTo = (date: string): SQL => lte(goodsReceipts.receivedOn, date);

/** `GRN-2026-00912` from the row-locked series. The '2026' scope is seeded by 0001. */
export async function nextGrnNumber(tx: Tx, year: number): Promise<string> {
  const scope = String(year);
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('goods_receipt', ${scope}, ${`GRN-${scope}-`}, '', 5, 1)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ grn_no: string }>(
    sql`SELECT next_document_number('goods_receipt', ${scope}) AS grn_no`,
  );
  const grnNo = result.rows[0]?.grn_no;
  if (!grnNo) throw new Error('next_document_number returned no goods receipt number');
  return grnNo;
}

const grnAccepted = sql<number>`coalesce((
  SELECT sum(l.accepted_qty)::int FROM goods_receipt_lines l WHERE l.goods_receipt_id = ${goodsReceipts.id}), 0)`;
const grnRejected = sql<number>`coalesce((
  SELECT sum(l.rejected_qty)::int FROM goods_receipt_lines l WHERE l.goods_receipt_id = ${goodsReceipts.id}), 0)`;
const grnLineCount = sql<number>`coalesce((
  SELECT count(*)::int FROM goods_receipt_lines l WHERE l.goods_receipt_id = ${goodsReceipts.id}), 0)`;

export type GrnListRow = GrnRow & {
  acceptedQty: number;
  rejectedQty: number;
  lineCount: number;
  poNo: string | null;
  supplierId: string | null;
};

export async function listGoodsReceipts(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<{ rows: GrnListRow[]; total: number }> {
  const rows = await exec
    .select({
      grn: goodsReceipts,
      acceptedQty: grnAccepted,
      rejectedQty: grnRejected,
      lineCount: grnLineCount,
      poNo: purchaseOrders.poNo,
      supplierId: purchaseOrders.supplierId,
    })
    .from(goodsReceipts)
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.purchaseOrderId))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const counted = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(goodsReceipts)
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.purchaseOrderId))
    .where(where);

  return {
    rows: rows.map((r) => ({
      ...r.grn,
      acceptedQty: r.acceptedQty,
      rejectedQty: r.rejectedQty,
      lineCount: r.lineCount,
      poNo: r.poNo,
      supplierId: r.supplierId,
    })),
    total: counted[0]?.n ?? 0,
  };
}

export async function findGoodsReceipt(grnId: string, exec: Executor = db): Promise<GrnListRow | undefined> {
  const rows = await exec
    .select({
      grn: goodsReceipts,
      acceptedQty: grnAccepted,
      rejectedQty: grnRejected,
      lineCount: grnLineCount,
      poNo: purchaseOrders.poNo,
      supplierId: purchaseOrders.supplierId,
    })
    .from(goodsReceipts)
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.purchaseOrderId))
    .where(eq(goodsReceipts.id, grnId))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        ...row.grn,
        acceptedQty: row.acceptedQty,
        rejectedQty: row.rejectedQty,
        lineCount: row.lineCount,
        poNo: row.poNo,
        supplierId: row.supplierId,
      }
    : undefined;
}

export type GrnLineRow = {
  id: string;
  poLineId: string;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason: string | null;
  batchNo: string | null;
  expiryOn: string | null;
  sku: string | null;
  description: string | null;
};

export async function findGrnLines(grnId: string, exec: Executor = db): Promise<GrnLineRow[]> {
  const rows = await exec
    .select({
      id: goodsReceiptLines.id,
      poLineId: goodsReceiptLines.poLineId,
      acceptedQty: goodsReceiptLines.acceptedQty,
      rejectedQty: goodsReceiptLines.rejectedQty,
      rejectionReason: goodsReceiptLines.rejectionReason,
      batchNo: goodsReceiptLines.batchNo,
      expiryOn: goodsReceiptLines.expiryOn,
      sku: poLineSku,
      description: purchaseOrderLines.description,
    })
    .from(goodsReceiptLines)
    .leftJoin(purchaseOrderLines, eq(purchaseOrderLines.id, goodsReceiptLines.poLineId))
    .where(eq(goodsReceiptLines.goodsReceiptId, grnId))
    .orderBy(asc(goodsReceiptLines.id));
  return rows;
}

/** Receipts posted against one PO, for the PO detail view. */
export async function findReceiptsForPo(
  poId: string,
  exec: Executor = db,
): Promise<{ id: string; grnNo: string; receivedOn: string; qcStatus: GrnRow['qcStatus']; acceptedQty: number; rejectedQty: number }[]> {
  const rows = await exec
    .select({
      id: goodsReceipts.id,
      grnNo: goodsReceipts.grnNo,
      receivedOn: goodsReceipts.receivedOn,
      qcStatus: goodsReceipts.qcStatus,
      acceptedQty: grnAccepted,
      rejectedQty: grnRejected,
    })
    .from(goodsReceipts)
    .where(eq(goodsReceipts.purchaseOrderId, poId))
    .orderBy(desc(goodsReceipts.createdAt));
  return rows;
}

export async function insertGoodsReceipt(tx: Tx, values: typeof goodsReceipts.$inferInsert): Promise<GrnRow> {
  const rows = await tx.insert(goodsReceipts).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('goods_receipts insert returned no row');
  return row;
}

export async function insertGrnLines(tx: Tx, values: (typeof goodsReceiptLines.$inferInsert)[]): Promise<void> {
  if (values.length === 0) return;
  await tx.insert(goodsReceiptLines).values(values);
}

/* ========================================================= purchase returns */

export type ReturnRow = PurchaseReturn;
export type ReturnLineRow = {
  id: string;
  inventoryLevelId: string;
  quantity: number;
  unitCostPaise: number;
  lineTotalPaise: number;
  note: string | null;
  warehouseId: string;
  sku: string | null;
  title: string | null;
};

const RETURN_SORT = {
  createdAt: purchaseReturns.createdAt,
  returnNo: purchaseReturns.returnNo,
  status: purchaseReturns.status,
  totalPaise: purchaseReturns.totalPaise,
} as const;

export const returnSortColumn = (field: string): AnyPgColumn =>
  RETURN_SORT[field as keyof typeof RETURN_SORT] ?? purchaseReturns.createdAt;

export const returnStatusIn = (values: readonly PurchaseReturnStatus[]): SQL | undefined =>
  values.length > 0 ? inArray(purchaseReturns.status, [...values]) : undefined;

/** `PRET-2026-00001`. Migration 0003 seeds the '2026' scope and widens the doc_type CHECK for it. */
export async function nextReturnNumber(tx: Tx, year: number): Promise<string> {
  const scope = String(year);
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('purchase_return', ${scope}, ${`PRET-${scope}-`}, '', 5, 1)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ return_no: string }>(
    sql`SELECT next_document_number('purchase_return', ${scope}) AS return_no`,
  );
  const returnNo = result.rows[0]?.return_no;
  if (!returnNo) throw new Error('next_document_number returned no purchase return number');
  return returnNo;
}

export async function listPurchaseReturns(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<{ rows: (ReturnRow & { lineCount: number; totalQty: number })[]; total: number }> {
  const lineCount = sql<number>`coalesce((
    SELECT count(*)::int FROM purchase_return_lines l WHERE l.purchase_return_id = ${purchaseReturns.id}), 0)`;
  const totalQty = sql<number>`coalesce((
    SELECT sum(l.quantity)::int FROM purchase_return_lines l WHERE l.purchase_return_id = ${purchaseReturns.id}), 0)`;

  const rows = await exec
    .select({ ret: purchaseReturns, lineCount, totalQty })
    .from(purchaseReturns)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const counted = await exec.select({ n: sql<number>`count(*)::int` }).from(purchaseReturns).where(where);

  return {
    rows: rows.map((r) => ({ ...r.ret, lineCount: r.lineCount, totalQty: r.totalQty })),
    total: counted[0]?.n ?? 0,
  };
}

export async function findPurchaseReturn(returnId: string, exec: Executor = db): Promise<ReturnRow | undefined> {
  const rows = await exec.select().from(purchaseReturns).where(eq(purchaseReturns.id, returnId)).limit(1);
  return rows[0];
}

export async function lockPurchaseReturn(tx: Tx, returnId: string): Promise<ReturnRow | undefined> {
  const rows = await tx.select().from(purchaseReturns).where(eq(purchaseReturns.id, returnId)).for('update').limit(1);
  return rows[0];
}

const levelSku = sql<string | null>`coalesce(
  (SELECT pv.sku FROM product_variants pv WHERE pv.id = ${inventoryLevels.variantId}),
  (SELECT hi.sku FROM hamper_items hi WHERE hi.id = ${inventoryLevels.hamperItemId}),
  (SELECT pm.sku FROM packaging_materials pm WHERE pm.id = ${inventoryLevels.packagingId}))`;

const levelTitle = sql<string | null>`coalesce(
  (SELECT p.title || ' — ' || pv.option_label
     FROM product_variants pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = ${inventoryLevels.variantId}),
  (SELECT hi.name FROM hamper_items hi WHERE hi.id = ${inventoryLevels.hamperItemId}),
  (SELECT pm.name FROM packaging_materials pm WHERE pm.id = ${inventoryLevels.packagingId}))`;

export async function findReturnLines(returnId: string, exec: Executor = db): Promise<ReturnLineRow[]> {
  const rows = await exec
    .select({
      id: purchaseReturnLines.id,
      inventoryLevelId: purchaseReturnLines.inventoryLevelId,
      quantity: purchaseReturnLines.quantity,
      unitCostPaise: purchaseReturnLines.unitCostPaise,
      lineTotalPaise: purchaseReturnLines.lineTotalPaise,
      note: purchaseReturnLines.note,
      warehouseId: inventoryLevels.warehouseId,
      sku: levelSku,
      title: levelTitle,
    })
    .from(purchaseReturnLines)
    .leftJoin(inventoryLevels, eq(inventoryLevels.id, purchaseReturnLines.inventoryLevelId))
    .where(eq(purchaseReturnLines.purchaseReturnId, returnId))
    .orderBy(asc(purchaseReturnLines.id));

  return rows.map((r) => ({ ...r, warehouseId: r.warehouseId ?? '' }));
}

export async function insertPurchaseReturn(
  tx: Tx,
  values: typeof purchaseReturns.$inferInsert,
): Promise<ReturnRow> {
  const rows = await tx.insert(purchaseReturns).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('purchase_returns insert returned no row');
  return row;
}

export async function insertReturnLines(
  tx: Tx,
  values: (typeof purchaseReturnLines.$inferInsert)[],
): Promise<void> {
  if (values.length === 0) return;
  await tx.insert(purchaseReturnLines).values(values);
}

export async function updatePurchaseReturn(
  tx: Tx,
  returnId: string,
  patch: Partial<typeof purchaseReturns.$inferInsert>,
): Promise<void> {
  await tx.update(purchaseReturns).set(patch).where(eq(purchaseReturns.id, returnId));
}

/** Warehouse of each named level, so a line cannot quietly take stock from somewhere else. */
export async function levelWarehouses(
  tx: Tx,
  levelIds: readonly string[],
): Promise<Map<string, string>> {
  if (levelIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: inventoryLevels.id, warehouseId: inventoryLevels.warehouseId })
    .from(inventoryLevels)
    .where(inArray(inventoryLevels.id, [...levelIds]));
  return new Map(rows.map((r) => [r.id, r.warehouseId]));
}
