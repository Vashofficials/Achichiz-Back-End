/**
 * Purchasing — supplier catalogues, purchase orders, goods receipts, purchase returns.
 *
 * Five rules shape this file.
 *
 * **1. Every total is recomputed from the lines.** A client-supplied
 * `totalPaise` is never trusted, for the same reason it is not trusted on an
 * order: it is the one number worth lying about. `subtotal` is the sum of
 * `orderedQty × unitCostPaise`, `tax` is the sum of each line's own basis-point
 * rate applied to its own subtotal, and `total` is their sum. All integer paise.
 *
 * **2. Approval and transmission are two steps, encoded in two columns.**
 * `purchase_orders` has no `approved` status — its CHECK allows five values and
 * migration 0003 did not widen it. So `approve` writes `status = 'sent'` with
 * `sent_at` still NULL, and `send` stamps `sent_at`. `poLifecycle()` turns that
 * pair back into the seven-stage lifecycle the API reports. The important
 * consequence is that `incoming_qty` is raised by `send`, not by `approve` — an
 * approved PO nobody has posted to the supplier is not stock on its way.
 *
 * **3. A goods receipt is one transaction.** For every line: increment on-hand
 * by the ACCEPTED quantity, write an `inbound` movement carrying the balance that
 * increment returned, add to the PO line's `received_qty`, and lower
 * `incoming_qty`. If any line fails, none of it happened.
 *
 * **4. Rejected goods never enter stock.** They are recorded on the receipt line
 * with a reason and that is all. Damaged units inside `on_hand_qty` are
 * sellable units, and no amount of downstream reporting undoes that. They also
 * do not count towards `received_qty`, so a PO with rejections stays
 * `partially_received` and is still owed stock — which is the truth.
 *
 * **5. Never negative, never silent.** Purchase-return dispatch decrements
 * through the same conditional `UPDATE … WHERE on_hand - reserved >= n` the
 * transfer path uses. `null` back is 422 `insufficient_stock`, naming the SKU.
 */

import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { BadRequestError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { applyBasisPoints } from '../../lib/money.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import * as repo from './admin-purchasing.repository.js';
import {
  assertPoAction,
  assertReturnAction,
  isPoEditable,
  isPoReceivable,
  poEdgesFrom,
  poLifecycle,
  poPersistedState,
  poStatusAfterReceipt,
  returnEdgesFrom,
} from './admin-purchasing.state.js';
import type {
  GrnDetailResponse,
  GrnSummaryResponse,
  PoDetailResponse,
  PoSummaryResponse,
  ReturnDetailResponse,
  ReturnSummaryResponse,
  SupplierProductResponse,
} from './admin-purchasing.schemas.js';
import type { StaffAuth } from '../../lib/openapi/define-route.js';
import {
  goodsReceipts,
  purchaseOrders,
  purchaseReturns,
  supplierProducts,
  PURCHASE_ORDER_STATUSES,
  PURCHASE_RETURN_STATUSES,
  type GrnQcStatus,
  type PurchaseOrderStatus,
  type PurchaseReturnReason,
  type PurchaseReturnStatus,
} from '../../db/schema/index.js';

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

type Target = {
  variantId?: string | undefined;
  hamperItemId?: string | undefined;
  packagingId?: string | undefined;
};

const targetKindOf = (row: {
  variantId: string | null;
  hamperItemId: string | null;
}): 'variant' | 'hamper_item' | 'packaging' =>
  row.variantId ? 'variant' : row.hamperItemId ? 'hamper_item' : 'packaging';

const refOf = (t: Target): repo.StockableRef => ({
  variantId: t.variantId ?? null,
  hamperItemId: t.hamperItemId ?? null,
  packagingId: t.packagingId ?? null,
});

async function assertTargetsExist(targets: readonly Target[]): Promise<void> {
  const variantIds = [...new Set(targets.map((t) => t.variantId).filter((v): v is string => Boolean(v)))];
  const hamperItemIds = [...new Set(targets.map((t) => t.hamperItemId).filter((v): v is string => Boolean(v)))];
  const packagingIds = [...new Set(targets.map((t) => t.packagingId).filter((v): v is string => Boolean(v)))];

  const live = await repo.liveStockables({ variantIds, hamperItemIds, packagingIds });
  const missing = [...variantIds, ...hamperItemIds, ...packagingIds].filter((id) => !live.has(id));
  if (missing.length > 0) {
    throw new UnprocessableError(
      `${missing.length} line(s) name a stockable that does not exist or has been deleted.`,
      'unknown_stockable',
      { context: { missing } },
    );
  }
}

/* ======================================================= supplier products */

const toSupplierProductResponse = (row: repo.SupplierProductRow): SupplierProductResponse => ({
  id: row.id,
  supplierId: row.supplierId,
  targetKind: targetKindOf(row),
  targetId: row.variantId ?? row.hamperItemId ?? row.packagingId ?? row.id,
  sku: row.sku,
  title: row.title,
  supplierSku: row.supplierSku,
  unitCostPaise: row.unitCostPaise,
  currency: row.currency,
  moq: row.moq,
  leadTimeDays: row.leadTimeDays,
  isPreferred: row.isPreferred,
  lastPurchaseAt: row.lastPurchaseAt?.toISOString() ?? null,
  lastPurchaseCostPaise: row.lastPurchaseCostPaise,
  archivedAt: row.deletedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export type SupplierProductListQuery = {
  page: number;
  perPage: number;
  q?: string | undefined;
  sort?: string | undefined;
  preferredOnly?: 'true' | 'false' | undefined;
  includeArchived: 'true' | 'false';
};

const SUPPLIER_PRODUCT_SORT_FIELDS = ['sku', 'unitCostPaise', 'leadTimeDays', 'moq', 'createdAt'] as const;

export async function listSupplierProducts(
  supplierId: string,
  query: SupplierProductListQuery,
): Promise<{ items: SupplierProductResponse[]; total: number }> {
  const supplier = await repo.findSupplier(supplierId);
  if (!supplier) throw new NotFoundError('Supplier', supplierId);

  const conditions: (SQL | undefined)[] = [
    eq(supplierProducts.supplierId, supplierId),
    query.includeArchived === 'true' ? undefined : isNull(supplierProducts.deletedAt),
    query.preferredOnly === 'true' ? eq(supplierProducts.isPreferred, true) : undefined,
    query.q ? repo.supplierProductSearch(`%${escapeLike(query.q)}%`) : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  const where = present.length > 0 ? and(...present) : undefined;

  const { field, direction } = parseSort(query.sort, SUPPLIER_PRODUCT_SORT_FIELDS, {
    field: 'sku',
    direction: 'asc',
  });
  const orderBy = [repo.supplierProductOrderBy(field, direction), asc(supplierProducts.id)] as SQL[];

  const { rows, total } = await repo.listSupplierProducts(
    where,
    orderBy,
    query.perPage,
    offsetOf(query.page, query.perPage),
  );
  return { items: rows.map(toSupplierProductResponse), total };
}

export async function createSupplierProduct(
  supplierId: string,
  input: Target & {
    supplierSku?: string | null | undefined;
    unitCostPaise: number;
    moq: number;
    leadTimeDays: number;
    isPreferred: boolean;
  },
): Promise<SupplierProductResponse> {
  const supplier = await repo.findSupplier(supplierId);
  if (!supplier) throw new NotFoundError('Supplier', supplierId);
  await assertTargetsExist([input]);

  const created = await db.transaction(async (tx) => {
    const ref = refOf(input);

    const duplicate = await repo.findSupplierProductByTarget(tx, supplierId, ref);
    if (duplicate) {
      throw new UnprocessableError(
        `${supplier.name} already has a live catalogue entry for this item. Edit that one rather than ` +
          'creating a second — the reorder engine would have no way to choose between them.',
        'supplier_product_exists',
        { context: { supplierProductId: duplicate.id } },
      );
    }

    // Clear the incumbent FIRST: the preferred index is a partial UNIQUE index
    // and cannot be deferred, so an insert before the demotion collides with a
    // row that is about to change.
    if (input.isPreferred && ref.variantId) {
      await repo.demotePreferredForVariant(tx, ref.variantId, null);
    }

    return repo.insertSupplierProduct(tx, {
      supplierId,
      variantId: ref.variantId,
      hamperItemId: ref.hamperItemId,
      packagingId: ref.packagingId,
      supplierSku: input.supplierSku ?? null,
      unitCostPaise: input.unitCostPaise,
      moq: input.moq,
      leadTimeDays: input.leadTimeDays,
      isPreferred: input.isPreferred,
    });
  });

  return getSupplierProduct(supplierId, created.id);
}

export async function getSupplierProduct(
  supplierId: string,
  supplierProductId: string,
): Promise<SupplierProductResponse> {
  const row = await repo.findSupplierProduct(supplierId, supplierProductId);
  if (!row) throw new NotFoundError('Supplier product', supplierProductId);
  return toSupplierProductResponse(row);
}

export async function updateSupplierProduct(
  supplierId: string,
  supplierProductId: string,
  input: {
    supplierSku?: string | null | undefined;
    unitCostPaise?: number | undefined;
    moq?: number | undefined;
    leadTimeDays?: number | undefined;
    isPreferred?: boolean | undefined;
    archived?: boolean | undefined;
  },
): Promise<SupplierProductResponse> {
  await db.transaction(async (tx) => {
    const current = await repo.findSupplierProduct(supplierId, supplierProductId, tx);
    if (!current) throw new NotFoundError('Supplier product', supplierProductId);

    if (input.isPreferred === true && current.variantId) {
      await repo.demotePreferredForVariant(tx, current.variantId, supplierProductId);
    }

    const patch: Partial<typeof supplierProducts.$inferInsert> = {
      ...(input.supplierSku !== undefined ? { supplierSku: input.supplierSku ?? null } : {}),
      ...(input.unitCostPaise !== undefined ? { unitCostPaise: input.unitCostPaise } : {}),
      ...(input.moq !== undefined ? { moq: input.moq } : {}),
      ...(input.leadTimeDays !== undefined ? { leadTimeDays: input.leadTimeDays } : {}),
      ...(input.isPreferred !== undefined ? { isPreferred: input.isPreferred } : {}),
      ...(input.archived !== undefined ? { deletedAt: input.archived ? new Date() : null } : {}),
      updatedAt: new Date(),
    };

    // An archived entry must not keep the preferred slot: the partial index
    // excludes soft-deleted rows, but the flag itself would still read as true.
    if (input.archived === true) patch.isPreferred = false;

    await repo.updateSupplierProduct(tx, supplierProductId, patch);
  });

  return getSupplierProduct(supplierId, supplierProductId);
}

/* ========================================================= purchase orders */

/**
 * Line money, computed once and used everywhere.
 *
 * `lineTotalPaise` excludes GST — the column is the taxable value, and the tax
 * is derived from each line's own basis-point rate so a PO mixing 5% and 18%
 * items does not have to pick one.
 */
export function computePoTotals(
  lines: readonly { orderedQty: number; unitCostPaise: number; gstRateBp: number }[],
): { lineTotals: number[]; subtotalPaise: number; taxPaise: number; totalPaise: number } {
  const lineTotals = lines.map((l) => l.orderedQty * l.unitCostPaise);
  const subtotalPaise = lineTotals.reduce((sum, v) => sum + v, 0);
  const taxPaise = lines.reduce(
    (sum, line, index) => sum + applyBasisPoints(lineTotals[index] ?? 0, line.gstRateBp),
    0,
  );
  return { lineTotals, subtotalPaise, taxPaise, totalPaise: subtotalPaise + taxPaise };
}

export type PoListQuery = {
  page: number;
  perPage: number;
  q?: string | undefined;
  sort?: string | undefined;
  status?: string | undefined;
  supplierId?: string | undefined;
  warehouseId?: string | undefined;
  expectedFrom?: string | undefined;
  expectedTo?: string | undefined;
};

const PO_SORT_FIELDS = ['createdAt', 'poNo', 'status', 'expectedOn', 'totalPaise'] as const;

/** Exported for the test. An unknown status is a 400, not a silently empty page. */
export function parsePoStatuses(raw: string | undefined): PurchaseOrderStatus[] {
  const values = csv(raw);
  const unknown = values.filter((v) => !(PURCHASE_ORDER_STATUSES as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Unknown purchase order status: ${unknown.join(', ')}. Valid stored values: ` +
        `${PURCHASE_ORDER_STATUSES.join(', ')}. \`approved\` is not one of them — an approved PO is ` +
        'stored as `sent` with no `sentAt`; filter on `sent` and read `lifecycle` on each row.',
    );
  }
  return values as PurchaseOrderStatus[];
}

export async function listPurchaseOrders(
  query: PoListQuery,
): Promise<{ items: PoSummaryResponse[]; total: number }> {
  const conditions: (SQL | undefined)[] = [
    repo.poStatusIn(parsePoStatuses(query.status)),
    query.supplierId ? eq(purchaseOrders.supplierId, query.supplierId) : undefined,
    query.warehouseId ? eq(purchaseOrders.warehouseId, query.warehouseId) : undefined,
    query.expectedFrom ? repo.poExpectedFrom(query.expectedFrom) : undefined,
    query.expectedTo ? repo.poExpectedTo(query.expectedTo) : undefined,
    query.q ? sql`${purchaseOrders.poNo} ILIKE ${`%${escapeLike(query.q)}%`}` : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  const where = present.length > 0 ? and(...present) : undefined;

  const { field, direction } = parseSort(query.sort, PO_SORT_FIELDS, { field: 'createdAt', direction: 'desc' });
  const column = repo.poSortColumn(field);
  const orderBy = [direction === 'desc' ? desc(column) : asc(column), asc(purchaseOrders.id)] as SQL[];

  const { rows, total } = await repo.listPurchaseOrders(
    where,
    orderBy,
    query.perPage,
    offsetOf(query.page, query.perPage),
  );

  const [supplierMap, warehouseMap] = await Promise.all([
    repo.supplierNames([...new Set(rows.map((r) => r.supplierId))]),
    repo.warehouseNames([...new Set(rows.map((r) => r.warehouseId))]),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      poNo: row.poNo,
      status: row.status,
      lifecycle: poLifecycle(row.status, row.sentAt),
      supplierId: row.supplierId,
      supplierName: supplierMap.get(row.supplierId) ?? null,
      warehouseId: row.warehouseId,
      warehouseName: warehouseMap.get(row.warehouseId) ?? null,
      currency: row.currency,
      subtotalPaise: row.subtotalPaise,
      taxPaise: row.taxPaise,
      totalPaise: row.totalPaise,
      lineCount: row.lineCount,
      orderedQty: row.orderedQty,
      receivedQty: row.receivedQty,
      expectedOn: row.expectedOn,
      sentAt: row.sentAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
  };
}

export async function getPurchaseOrder(poId: string): Promise<PoDetailResponse> {
  const po = await repo.findPurchaseOrder(poId);
  if (!po) throw new NotFoundError('Purchase order', poId);

  const [lines, receipts, supplierMap, warehouseMap] = await Promise.all([
    repo.findPoLines(poId),
    repo.findReceiptsForPo(poId),
    repo.supplierNames([po.supplierId]),
    repo.warehouseNames([po.warehouseId]),
  ]);

  const lifecycle = poLifecycle(po.status, po.sentAt);

  return {
    id: po.id,
    poNo: po.poNo,
    status: po.status,
    lifecycle,
    supplierId: po.supplierId,
    supplierName: supplierMap.get(po.supplierId) ?? null,
    warehouseId: po.warehouseId,
    warehouseName: warehouseMap.get(po.warehouseId) ?? null,
    currency: po.currency,
    subtotalPaise: po.subtotalPaise,
    taxPaise: po.taxPaise,
    totalPaise: po.totalPaise,
    lineCount: lines.length,
    orderedQty: lines.reduce((sum, l) => sum + l.orderedQty, 0),
    receivedQty: lines.reduce((sum, l) => sum + l.receivedQty, 0),
    expectedOn: po.expectedOn,
    sentAt: po.sentAt?.toISOString() ?? null,
    closedAt: po.closedAt?.toISOString() ?? null,
    createdAt: po.createdAt.toISOString(),
    notes: po.notes,
    createdBy: po.createdBy,
    lines: lines.map((line) => ({
      id: line.id,
      targetKind: targetKindOf(line),
      targetId: line.variantId ?? line.hamperItemId ?? line.packagingId ?? line.id,
      sku: line.sku,
      description: line.description,
      orderedQty: line.orderedQty,
      receivedQty: line.receivedQty,
      outstandingQty: Math.max(0, line.orderedQty - line.receivedQty),
      unitCostPaise: line.unitCostPaise,
      gstRateBp: line.gstRateBp,
      lineTotalPaise: line.lineTotalPaise,
    })),
    receipts: receipts.map((r) => ({
      id: r.id,
      grnNo: r.grnNo,
      receivedOn: r.receivedOn,
      qcStatus: r.qcStatus,
      acceptedQty: r.acceptedQty,
      rejectedQty: r.rejectedQty,
    })),
    availableActions: poEdgesFrom(lifecycle).map((edge) => ({
      action: edge.action,
      to: edge.to,
      label: edge.label,
      documentDriven: edge.documentDriven ?? false,
      sideEffects: [...(edge.sideEffects ?? [])],
    })),
  };
}

export type PoLineInput = Target & {
  description: string;
  orderedQty: number;
  unitCostPaise: number;
  gstRateBp: number;
};

export async function createPurchaseOrder(
  input: {
    supplierId: string;
    warehouseId: string;
    expectedOn?: string | null | undefined;
    notes?: string | null | undefined;
    lines: PoLineInput[];
  },
  auth: StaffAuth,
): Promise<PoDetailResponse> {
  const [supplier, warehouse] = await Promise.all([
    repo.findSupplier(input.supplierId),
    repo.findWarehouse(input.warehouseId),
  ]);
  if (!supplier) throw new NotFoundError('Supplier', input.supplierId);
  if (!warehouse) throw new NotFoundError('Warehouse', input.warehouseId);
  await assertTargetsExist(input.lines);

  const created = await db.transaction(async (tx) => {
    const totals = computePoTotals(input.lines);
    const poNo = await repo.nextPoNumber(tx, new Date().getUTCFullYear());

    const po = await repo.insertPurchaseOrder(tx, {
      poNo,
      supplierId: input.supplierId,
      warehouseId: input.warehouseId,
      status: 'draft',
      subtotalPaise: totals.subtotalPaise,
      taxPaise: totals.taxPaise,
      totalPaise: totals.totalPaise,
      expectedOn: input.expectedOn ?? null,
      notes: input.notes ?? null,
      createdBy: auth.staffId,
    });

    await repo.insertPoLines(
      tx,
      input.lines.map((line, index) => ({
        purchaseOrderId: po.id,
        variantId: line.variantId ?? null,
        hamperItemId: line.hamperItemId ?? null,
        packagingId: line.packagingId ?? null,
        description: line.description,
        orderedQty: line.orderedQty,
        unitCostPaise: line.unitCostPaise,
        gstRateBp: line.gstRateBp,
        lineTotalPaise: totals.lineTotals[index] ?? 0,
        position: index,
      })),
    );

    return po;
  });

  return getPurchaseOrder(created.id);
}

/**
 * Edit a draft PO.
 *
 * Lines are replaced wholesale rather than patched: a PO line carries a
 * `received_qty`, and a partial patch that reordered or dropped lines would have
 * to decide what happens to that. While the PO is a draft it is always zero, so
 * replacement is safe — and outside draft, editing is refused entirely, because
 * the supplier already has a copy of the document.
 */
export async function updatePurchaseOrder(
  poId: string,
  input: {
    expectedOn?: string | null | undefined;
    notes?: string | null | undefined;
    lines?: PoLineInput[] | undefined;
  },
): Promise<PoDetailResponse> {
  if (input.lines) await assertTargetsExist(input.lines);

  await db.transaction(async (tx) => {
    const po = await repo.lockPurchaseOrder(tx, poId);
    if (!po) throw new NotFoundError('Purchase order', poId);

    const lifecycle = poLifecycle(po.status, po.sentAt);
    if (!isPoEditable(lifecycle)) {
      assertPoAction(lifecycle, 'edit'); // Throws `illegal_po_transition` with the legal actions listed.
    }

    const patch: Partial<typeof purchaseOrders.$inferInsert> = {
      ...(input.expectedOn !== undefined ? { expectedOn: input.expectedOn ?? null } : {}),
      ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
      updatedAt: new Date(),
    };

    if (input.lines) {
      const totals = computePoTotals(input.lines);
      await repo.deletePoLines(tx, poId);
      await repo.insertPoLines(
        tx,
        input.lines.map((line, index) => ({
          purchaseOrderId: poId,
          variantId: line.variantId ?? null,
          hamperItemId: line.hamperItemId ?? null,
          packagingId: line.packagingId ?? null,
          description: line.description,
          orderedQty: line.orderedQty,
          unitCostPaise: line.unitCostPaise,
          gstRateBp: line.gstRateBp,
          lineTotalPaise: totals.lineTotals[index] ?? 0,
          position: index,
        })),
      );
      patch.subtotalPaise = totals.subtotalPaise;
      patch.taxPaise = totals.taxPaise;
      patch.totalPaise = totals.totalPaise;
    }

    await repo.updatePurchaseOrder(tx, poId, patch);
  });

  return getPurchaseOrder(poId);
}

/**
 * Approve — `draft` → lifecycle `approved`, stored as `status='sent'`, `sentAt=NULL`.
 *
 * Nothing is raised on `incoming_qty` here. An approved PO that has not been
 * posted to the supplier is not stock on its way, and showing it as incoming
 * would make the reorder engine skip a SKU nobody has actually ordered.
 */
export async function approvePurchaseOrder(poId: string): Promise<PoDetailResponse> {
  await db.transaction(async (tx) => {
    const po = await repo.lockPurchaseOrder(tx, poId);
    if (!po) throw new NotFoundError('Purchase order', poId);

    assertPoAction(poLifecycle(po.status, po.sentAt), 'approve');

    const lines = await repo.findPoLines(poId, tx);
    if (lines.length === 0) {
      throw new UnprocessableError(
        'This purchase order has no lines. Approving an empty document commits nobody to anything.',
        'po_has_no_lines',
        { context: { poId } },
      );
    }

    const persisted = poPersistedState('approved', new Date());
    await repo.updatePurchaseOrder(tx, poId, { ...persisted, updatedAt: new Date() });
  });

  return getPurchaseOrder(poId);
}

/**
 * Send — lifecycle `approved` → `sent`. Stamps `sentAt` and raises `incoming_qty`.
 *
 * This is the moment the order becomes real to the outside world, so it is the
 * moment the destination warehouse starts expecting stock. The level rows are
 * created here if they do not exist: a first-time purchase of a new SKU has
 * nowhere to record the expectation otherwise.
 */
export async function sendPurchaseOrder(poId: string): Promise<PoDetailResponse> {
  await db.transaction(async (tx) => {
    const po = await repo.lockPurchaseOrder(tx, poId);
    if (!po) throw new NotFoundError('Purchase order', poId);

    assertPoAction(poLifecycle(po.status, po.sentAt), 'send');

    const lines = await repo.findPoLines(poId, tx);
    const now = new Date();

    const resolved: { levelId: string; qty: number }[] = [];
    for (const line of lines) {
      const level = await repo.ensureLevel(tx, po.warehouseId, {
        variantId: line.variantId,
        hamperItemId: line.hamperItemId,
        packagingId: line.packagingId,
      });
      resolved.push({ levelId: level.id, qty: Math.max(0, line.orderedQty - line.receivedQty) });
    }

    resolved.sort((a, b) => (a.levelId < b.levelId ? -1 : a.levelId > b.levelId ? 1 : 0));
    for (const { levelId, qty } of resolved) {
      await repo.adjustIncoming(tx, levelId, qty);
    }

    await repo.touchSupplierProducts(tx, po.supplierId, lines, now);
    await repo.updatePurchaseOrder(tx, poId, { ...poPersistedState('sent', now), updatedAt: now });
  });

  return getPurchaseOrder(poId);
}

/**
 * Cancel — legal from draft, approved, sent and partially received.
 *
 * `received` is terminal: goods that arrived cannot be un-received by a status
 * flip. Whatever has NOT been received stops being incoming, because it is no
 * longer coming.
 */
export async function cancelPurchaseOrder(poId: string, reason: string): Promise<PoDetailResponse> {
  await db.transaction(async (tx) => {
    const po = await repo.lockPurchaseOrder(tx, poId);
    if (!po) throw new NotFoundError('Purchase order', poId);

    assertPoAction(poLifecycle(po.status, po.sentAt), 'cancel');

    const lines = await repo.findPoLines(poId, tx);
    const now = new Date();

    // Only a SENT order ever raised incoming, so only a sent one releases it.
    if (po.sentAt) {
      const resolved: { levelId: string; qty: number }[] = [];
      for (const line of lines) {
        const outstanding = Math.max(0, line.orderedQty - line.receivedQty);
        if (outstanding === 0) continue;
        const level = await repo.ensureLevel(tx, po.warehouseId, {
          variantId: line.variantId,
          hamperItemId: line.hamperItemId,
          packagingId: line.packagingId,
        });
        resolved.push({ levelId: level.id, qty: outstanding });
      }
      resolved.sort((a, b) => (a.levelId < b.levelId ? -1 : a.levelId > b.levelId ? 1 : 0));
      for (const { levelId, qty } of resolved) {
        await repo.adjustIncoming(tx, levelId, -qty);
      }
    }

    const stamped = `[${now.toISOString()}] Cancelled: ${reason}`;
    await repo.updatePurchaseOrder(tx, poId, {
      status: 'cancelled',
      closedAt: now,
      notes: po.notes ? `${po.notes}\n${stamped}` : stamped,
      updatedAt: now,
    });
  });

  return getPurchaseOrder(poId);
}

/* ========================================================== goods receipts */

export type GrnListQuery = {
  page: number;
  perPage: number;
  q?: string | undefined;
  sort?: string | undefined;
  purchaseOrderId?: string | undefined;
  warehouseId?: string | undefined;
  qcStatus?: GrnQcStatus | undefined;
  receivedFrom?: string | undefined;
  receivedTo?: string | undefined;
};

const GRN_SORT_FIELDS = ['receivedOn', 'grnNo', 'createdAt'] as const;

const toGrnSummary = (
  row: repo.GrnListRow,
  supplierName: string | null,
  warehouseName: string | null,
): GrnSummaryResponse => ({
  id: row.id,
  grnNo: row.grnNo,
  purchaseOrderId: row.purchaseOrderId,
  poNo: row.poNo,
  warehouseId: row.warehouseId,
  warehouseName,
  supplierId: row.supplierId,
  supplierName,
  receivedOn: row.receivedOn,
  qcStatus: row.qcStatus,
  supplierInvoiceNo: row.supplierInvoiceNo,
  acceptedQty: row.acceptedQty,
  rejectedQty: row.rejectedQty,
  lineCount: row.lineCount,
  createdAt: row.createdAt.toISOString(),
});

export async function listGoodsReceipts(
  query: GrnListQuery,
): Promise<{ items: GrnSummaryResponse[]; total: number }> {
  const conditions: (SQL | undefined)[] = [
    query.purchaseOrderId ? eq(goodsReceipts.purchaseOrderId, query.purchaseOrderId) : undefined,
    query.warehouseId ? eq(goodsReceipts.warehouseId, query.warehouseId) : undefined,
    query.qcStatus ? eq(goodsReceipts.qcStatus, query.qcStatus) : undefined,
    query.receivedFrom ? repo.grnReceivedFrom(query.receivedFrom) : undefined,
    query.receivedTo ? repo.grnReceivedTo(query.receivedTo) : undefined,
    query.q
      ? sql`(${goodsReceipts.grnNo} ILIKE ${`%${escapeLike(query.q)}%`}
             OR coalesce(${goodsReceipts.supplierInvoiceNo}, '') ILIKE ${`%${escapeLike(query.q)}%`})`
      : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  const where = present.length > 0 ? and(...present) : undefined;

  const { field, direction } = parseSort(query.sort, GRN_SORT_FIELDS, { field: 'receivedOn', direction: 'desc' });
  const column = repo.grnSortColumn(field);
  const orderBy = [direction === 'desc' ? desc(column) : asc(column), asc(goodsReceipts.id)] as SQL[];

  const { rows, total } = await repo.listGoodsReceipts(
    where,
    orderBy,
    query.perPage,
    offsetOf(query.page, query.perPage),
  );

  const [supplierMap, warehouseMap] = await Promise.all([
    repo.supplierNames([...new Set(rows.map((r) => r.supplierId).filter((v): v is string => Boolean(v)))]),
    repo.warehouseNames([...new Set(rows.map((r) => r.warehouseId))]),
  ]);

  return {
    items: rows.map((row) =>
      toGrnSummary(
        row,
        row.supplierId ? (supplierMap.get(row.supplierId) ?? null) : null,
        warehouseMap.get(row.warehouseId) ?? null,
      ),
    ),
    total,
  };
}

export async function getGoodsReceipt(grnId: string): Promise<GrnDetailResponse> {
  const grn = await repo.findGoodsReceipt(grnId);
  if (!grn) throw new NotFoundError('Goods receipt', grnId);

  const [lines, po, supplierMap, warehouseMap] = await Promise.all([
    repo.findGrnLines(grnId),
    repo.findPurchaseOrder(grn.purchaseOrderId),
    repo.supplierNames(grn.supplierId ? [grn.supplierId] : []),
    repo.warehouseNames([grn.warehouseId]),
  ]);

  return {
    ...toGrnSummary(
      grn,
      grn.supplierId ? (supplierMap.get(grn.supplierId) ?? null) : null,
      warehouseMap.get(grn.warehouseId) ?? null,
    ),
    inspectorId: grn.inspectorId,
    notes: grn.notes,
    poStatusAfter: po?.status ?? 'received',
    lines: lines.map((line) => ({
      id: line.id,
      poLineId: line.poLineId,
      sku: line.sku,
      description: line.description,
      acceptedQty: line.acceptedQty,
      rejectedQty: line.rejectedQty,
      rejectionReason: line.rejectionReason,
      batchNo: line.batchNo,
      expiryOn: line.expiryOn,
    })),
  };
}

export type GrnLineInput = {
  poLineId: string;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason?: string | null | undefined;
  batchNo?: string | null | undefined;
  expiryOn?: string | null | undefined;
};

/**
 * Post a goods receipt. ONE transaction, all of it.
 *
 * Per line: increment on-hand by ACCEPTED units, write an `inbound` movement
 * carrying the balance that increment returned, add to the PO line's
 * `received_qty`, and lower `incoming_qty` by everything that turned up
 * (accepted and rejected alike — the lorry has been).
 *
 * Rejected units are recorded and go no further. They never touch `on_hand_qty`,
 * because damaged stock inside on-hand is sellable stock; and they never count
 * towards `received_qty`, so the PO stays open for what it is still owed.
 */
export async function createGoodsReceipt(
  input: {
    purchaseOrderId: string;
    receivedOn?: string | undefined;
    qcStatus: GrnQcStatus;
    inspectorId?: string | null | undefined;
    supplierInvoiceNo?: string | null | undefined;
    notes?: string | null | undefined;
    lines: GrnLineInput[];
  },
  auth: StaffAuth,
): Promise<GrnDetailResponse> {
  const created = await db.transaction(async (tx) => {
    const po = await repo.lockPurchaseOrder(tx, input.purchaseOrderId);
    if (!po) throw new NotFoundError('Purchase order', input.purchaseOrderId);

    const lifecycle = poLifecycle(po.status, po.sentAt);
    if (!isPoReceivable(lifecycle)) {
      throw new UnprocessableError(
        `Goods cannot be received against a purchase order in \`${lifecycle}\`. It has to have been sent ` +
          'to the supplier first — receiving against a draft records an arrival for an order nobody placed.',
        'po_not_receivable',
        { context: { poId: po.id, lifecycle } },
      );
    }

    const poLines = await repo.findPoLines(po.id, tx);
    const byId = new Map(poLines.map((l) => [l.id, l]));

    // Validate EVERY line before writing anything. A receipt that half-posts and
    // then hits an over-receipt on line four is worse than one that is refused.
    const prepared: {
      input: GrnLineInput;
      poLine: repo.PoLineRow;
      levelId: string;
    }[] = [];

    for (const line of input.lines) {
      const poLine = byId.get(line.poLineId);
      if (!poLine) {
        throw new UnprocessableError(
          `Line ${line.poLineId} does not belong to purchase order ${po.poNo}.`,
          'unknown_po_line',
          { context: { poId: po.id, poLineId: line.poLineId } },
        );
      }
      if (poLine.receivedQty + line.acceptedQty > poLine.orderedQty) {
        throw new UnprocessableError(
          `${poLine.sku ?? poLine.description}: ${poLine.orderedQty} were ordered and ` +
            `${poLine.receivedQty} already accepted, so ${line.acceptedQty} more would over-receive the ` +
            'line. Amend the purchase order if the supplier genuinely sent extra.',
          'over_receipt',
          {
            context: {
              poLineId: poLine.id,
              orderedQty: poLine.orderedQty,
              receivedQty: poLine.receivedQty,
              acceptedQty: line.acceptedQty,
            },
          },
        );
      }

      const level = await repo.ensureLevel(tx, po.warehouseId, {
        variantId: poLine.variantId,
        hamperItemId: poLine.hamperItemId,
        packagingId: poLine.packagingId,
      });
      prepared.push({ input: line, poLine, levelId: level.id });
    }

    prepared.sort((a, b) => (a.levelId < b.levelId ? -1 : a.levelId > b.levelId ? 1 : 0));
    await repo.lockLevels(tx, prepared.map((p) => p.levelId));

    const grnNo = await repo.nextGrnNumber(tx, new Date().getUTCFullYear());
    const grn = await repo.insertGoodsReceipt(tx, {
      grnNo,
      purchaseOrderId: po.id,
      // Forced to the PO's warehouse rather than accepted from the client: a
      // receipt into a different warehouse than the one that ordered would leave
      // `incoming_qty` raised forever at the warehouse still waiting.
      warehouseId: po.warehouseId,
      ...(input.receivedOn ? { receivedOn: input.receivedOn } : {}),
      qcStatus: input.qcStatus,
      inspectorId: input.inspectorId ?? auth.staffId,
      supplierInvoiceNo: input.supplierInvoiceNo ?? null,
      notes: input.notes ?? null,
    });

    await repo.insertGrnLines(
      tx,
      input.lines.map((line) => ({
        goodsReceiptId: grn.id,
        poLineId: line.poLineId,
        acceptedQty: line.acceptedQty,
        rejectedQty: line.rejectedQty,
        rejectionReason: line.rejectionReason ?? null,
        batchNo: line.batchNo ?? null,
        expiryOn: line.expiryOn ?? null,
      })),
    );

    for (const { input: line, poLine, levelId } of prepared) {
      const arrived = line.acceptedQty + line.rejectedQty;
      if (arrived > 0) await repo.adjustIncoming(tx, levelId, -arrived);

      if (line.acceptedQty > 0) {
        const balanceAfter = await repo.adjustOnHand(tx, levelId, line.acceptedQty);
        if (balanceAfter === null) {
          throw new Error('increment unexpectedly refused — an increment has no guard to fail');
        }

        await repo.insertMovement(tx, {
          inventoryLevelId: levelId,
          movementType: 'inbound',
          quantityDelta: line.acceptedQty,
          balanceAfter,
          referenceType: 'goods_receipt',
          referenceId: grn.id,
          referenceLabel: grn.grnNo,
          note: line.batchNo ? `Batch ${line.batchNo}` : null,
          actorId: auth.staffId,
        });

        await repo.addPoLineReceived(tx, poLine.id, line.acceptedQty);
      }
      // Rejected units: recorded on the receipt line above and nowhere else.
      // No movement, no on-hand, no `received_qty`.
    }

    // Re-read the lines so the roll-up sees this receipt's writes.
    const after = await repo.findPoLines(po.id, tx);
    const nextStatus = poStatusAfterReceipt(after);
    const now = new Date();
    await repo.updatePurchaseOrder(tx, po.id, {
      status: nextStatus,
      ...(nextStatus === 'received' ? { closedAt: now } : {}),
      updatedAt: now,
    });

    return grn;
  });

  return getGoodsReceipt(created.id);
}

/* ========================================================= purchase returns */

export type ReturnListQuery = {
  page: number;
  perPage: number;
  q?: string | undefined;
  sort?: string | undefined;
  status?: string | undefined;
  supplierId?: string | undefined;
  warehouseId?: string | undefined;
  reason?: PurchaseReturnReason | undefined;
};

const RETURN_SORT_FIELDS = ['createdAt', 'returnNo', 'status', 'totalPaise'] as const;

/** Exported for the test. */
export function parseReturnStatuses(raw: string | undefined): PurchaseReturnStatus[] {
  const values = csv(raw);
  const unknown = values.filter((v) => !(PURCHASE_RETURN_STATUSES as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Unknown purchase return status: ${unknown.join(', ')}. Valid values: ${PURCHASE_RETURN_STATUSES.join(', ')}.`,
    );
  }
  return values as PurchaseReturnStatus[];
}

export async function listPurchaseReturns(
  query: ReturnListQuery,
): Promise<{ items: ReturnSummaryResponse[]; total: number }> {
  const conditions: (SQL | undefined)[] = [
    repo.returnStatusIn(parseReturnStatuses(query.status)),
    query.supplierId ? eq(purchaseReturns.supplierId, query.supplierId) : undefined,
    query.warehouseId ? eq(purchaseReturns.warehouseId, query.warehouseId) : undefined,
    query.reason ? eq(purchaseReturns.reason, query.reason) : undefined,
    query.q ? sql`${purchaseReturns.returnNo} ILIKE ${`%${escapeLike(query.q)}%`}` : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  const where = present.length > 0 ? and(...present) : undefined;

  const { field, direction } = parseSort(query.sort, RETURN_SORT_FIELDS, { field: 'createdAt', direction: 'desc' });
  const column = repo.returnSortColumn(field);
  const orderBy = [direction === 'desc' ? desc(column) : asc(column), asc(purchaseReturns.id)] as SQL[];

  const { rows, total } = await repo.listPurchaseReturns(
    where,
    orderBy,
    query.perPage,
    offsetOf(query.page, query.perPage),
  );

  const [supplierMap, warehouseMap] = await Promise.all([
    repo.supplierNames([...new Set(rows.map((r) => r.supplierId))]),
    repo.warehouseNames([...new Set(rows.map((r) => r.warehouseId))]),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      returnNo: row.returnNo,
      status: row.status,
      reason: row.reason,
      supplierId: row.supplierId,
      supplierName: supplierMap.get(row.supplierId) ?? null,
      warehouseId: row.warehouseId,
      warehouseName: warehouseMap.get(row.warehouseId) ?? null,
      goodsReceiptId: row.goodsReceiptId,
      subtotalPaise: row.subtotalPaise,
      taxPaise: row.taxPaise,
      totalPaise: row.totalPaise,
      lineCount: row.lineCount,
      totalQty: row.totalQty,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
  };
}

export async function getPurchaseReturn(returnId: string): Promise<ReturnDetailResponse> {
  const ret = await repo.findPurchaseReturn(returnId);
  if (!ret) throw new NotFoundError('Purchase return', returnId);

  const [lines, supplierMap, warehouseMap] = await Promise.all([
    repo.findReturnLines(returnId),
    repo.supplierNames([ret.supplierId]),
    repo.warehouseNames([ret.warehouseId]),
  ]);

  return {
    id: ret.id,
    returnNo: ret.returnNo,
    status: ret.status,
    reason: ret.reason,
    supplierId: ret.supplierId,
    supplierName: supplierMap.get(ret.supplierId) ?? null,
    warehouseId: ret.warehouseId,
    warehouseName: warehouseMap.get(ret.warehouseId) ?? null,
    goodsReceiptId: ret.goodsReceiptId,
    subtotalPaise: ret.subtotalPaise,
    taxPaise: ret.taxPaise,
    totalPaise: ret.totalPaise,
    lineCount: lines.length,
    totalQty: lines.reduce((sum, l) => sum + l.quantity, 0),
    approvedAt: ret.approvedAt?.toISOString() ?? null,
    dispatchedAt: ret.dispatchedAt?.toISOString() ?? null,
    createdAt: ret.createdAt.toISOString(),
    note: ret.note,
    createdBy: ret.createdBy,
    approvedBy: ret.approvedBy,
    lines: lines.map((line) => ({
      id: line.id,
      inventoryLevelId: line.inventoryLevelId,
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
      unitCostPaise: line.unitCostPaise,
      lineTotalPaise: line.lineTotalPaise,
      note: line.note,
    })),
    availableActions: returnEdgesFrom(ret.status).map((edge) => ({
      action: edge.action,
      to: edge.to,
      label: edge.label,
      movesStock: edge.movesStock,
      sideEffects: [...(edge.sideEffects ?? [])],
    })),
  };
}

export type ReturnLineInput = {
  inventoryLevelId: string;
  quantity: number;
  unitCostPaise: number;
  note?: string | null | undefined;
};

export async function createPurchaseReturn(
  input: {
    supplierId: string;
    warehouseId: string;
    goodsReceiptId?: string | null | undefined;
    reason: PurchaseReturnReason;
    note?: string | null | undefined;
    taxPaise: number;
    lines: ReturnLineInput[];
  },
  auth: StaffAuth,
): Promise<ReturnDetailResponse> {
  const [supplier, warehouse] = await Promise.all([
    repo.findSupplier(input.supplierId),
    repo.findWarehouse(input.warehouseId),
  ]);
  if (!supplier) throw new NotFoundError('Supplier', input.supplierId);
  if (!warehouse) throw new NotFoundError('Warehouse', input.warehouseId);

  const created = await db.transaction(async (tx) => {
    // Every named level must live in the return's warehouse. Without this a
    // return "from Mumbai" could quietly take the stock out of Delhi.
    const levelIds = input.lines.map((l) => l.inventoryLevelId);
    const warehouseOf = await repo.levelWarehouses(tx, levelIds);
    const wrong = levelIds.filter((id) => warehouseOf.get(id) !== input.warehouseId);
    if (wrong.length > 0) {
      throw new UnprocessableError(
        `${wrong.length} line(s) name an inventory level that is not in this warehouse, or does not ` +
          'exist. A return takes stock out of one warehouse; every line has to be that warehouse.',
        'level_warehouse_mismatch',
        { context: { warehouseId: input.warehouseId, levelIds: wrong } },
      );
    }

    const lineTotals = input.lines.map((l) => l.quantity * l.unitCostPaise);
    const subtotalPaise = lineTotals.reduce((sum, v) => sum + v, 0);

    const returnNo = await repo.nextReturnNumber(tx, new Date().getUTCFullYear());
    const ret = await repo.insertPurchaseReturn(tx, {
      returnNo,
      supplierId: input.supplierId,
      warehouseId: input.warehouseId,
      goodsReceiptId: input.goodsReceiptId ?? null,
      status: 'draft',
      reason: input.reason,
      subtotalPaise,
      taxPaise: input.taxPaise,
      totalPaise: subtotalPaise + input.taxPaise,
      note: input.note ?? null,
      createdBy: auth.staffId,
    });

    await repo.insertReturnLines(
      tx,
      input.lines.map((line, index) => ({
        purchaseReturnId: ret.id,
        inventoryLevelId: line.inventoryLevelId,
        quantity: line.quantity,
        unitCostPaise: line.unitCostPaise,
        lineTotalPaise: lineTotals[index] ?? 0,
        note: line.note ?? null,
      })),
    );

    return ret;
  });

  return getPurchaseReturn(created.id);
}

export async function approvePurchaseReturn(returnId: string, auth: StaffAuth): Promise<ReturnDetailResponse> {
  await db.transaction(async (tx) => {
    const ret = await repo.lockPurchaseReturn(tx, returnId);
    if (!ret) throw new NotFoundError('Purchase return', returnId);

    assertReturnAction(ret.status, 'approve');

    const lines = await repo.findReturnLines(returnId, tx);
    if (lines.length === 0) {
      throw new UnprocessableError(
        'This return has no lines. Approving it would authorise sending nothing back.',
        'return_has_no_lines',
        { context: { returnId } },
      );
    }

    const now = new Date();
    await repo.updatePurchaseReturn(tx, returnId, {
      status: 'approved',
      approvedBy: auth.staffId,
      approvedAt: now,
      updatedAt: now,
    });
  });

  return getPurchaseReturn(returnId);
}

/**
 * Dispatch — the one stock-moving edge on a return.
 *
 * ONE transaction: decrement every line's level through the conditional update,
 * write an `outbound` movement referenced to `purchase_return`, done. Any line
 * short rolls the whole thing back — a return that shipped three of its four
 * lines is a parcel the supplier will dispute and a ledger nobody can reconcile.
 */
export async function dispatchPurchaseReturn(
  returnId: string,
  auth: StaffAuth,
): Promise<ReturnDetailResponse> {
  await db.transaction(async (tx) => {
    const ret = await repo.lockPurchaseReturn(tx, returnId);
    if (!ret) throw new NotFoundError('Purchase return', returnId);

    assertReturnAction(ret.status, 'dispatch');

    const lines = await repo.findReturnLines(returnId, tx);
    if (lines.length === 0) {
      throw new UnprocessableError('This return has no lines to dispatch.', 'return_has_no_lines');
    }

    const sorted = [...lines].sort((a, b) =>
      a.inventoryLevelId < b.inventoryLevelId ? -1 : a.inventoryLevelId > b.inventoryLevelId ? 1 : 0,
    );
    await repo.lockLevels(tx, sorted.map((l) => l.inventoryLevelId));

    for (const line of sorted) {
      const balanceAfter = await repo.adjustOnHand(tx, line.inventoryLevelId, -line.quantity);
      if (balanceAfter === null) {
        throw new UnprocessableError(
          `Not enough sellable stock to return ${line.quantity} unit(s) of ${line.sku ?? 'this line'}. ` +
            'Reserved units belong to open carts and orders and cannot be sent back to the supplier.',
          'insufficient_stock',
          {
            context: {
              returnId,
              lineId: line.id,
              sku: line.sku,
              inventoryLevelId: line.inventoryLevelId,
              requested: line.quantity,
            },
          },
        );
      }

      await repo.insertMovement(tx, {
        inventoryLevelId: line.inventoryLevelId,
        movementType: 'outbound',
        quantityDelta: -line.quantity,
        balanceAfter,
        referenceType: 'purchase_return',
        referenceId: ret.id,
        referenceLabel: ret.returnNo,
        note: line.note ?? `Returned to supplier: ${ret.reason}`,
        actorId: auth.staffId,
      });
    }

    const now = new Date();
    await repo.updatePurchaseReturn(tx, returnId, {
      status: 'dispatched',
      dispatchedAt: now,
      updatedAt: now,
    });
  });

  return getPurchaseReturn(returnId);
}
