import { db, type Tx } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import * as repo from './admin-bulk-orders.repository.js';
import {
  aggregateDemand,
  allocateDemand,
  assertAllocationBalances,
  buildProcurementPlan,
  type DemandAllocation,
  type SupplierTerms,
  type WarehousePosition,
} from './admin-bulk-orders.planning.js';
import type {
  BulkOrderDetail,
  BulkOrderListQuery,
  BulkOrderSummary,
  CreateBulkOrderBody,
  FulfillmentPlanQuery,
  FulfillmentPlanResponse,
  InventoryCheckBody,
  InventoryCheckResponse,
  ProcurementPlanBody,
  ProcurementPlanResponse,
  ReleaseBody,
  ReleaseResponse,
  ReserveBody,
  ReserveResponse,
  UpdateBulkOrderBody,
} from './admin-bulk-orders.schemas.js';

/**
 * Corporate bulk orders — §88.
 *
 * The demand is the recipient list, never a typed number. Everything below
 * derives from that one fact: the inventory check aggregates recipients, the
 * reservation holds exactly what the aggregation says, and the fulfilment plan
 * has to add back up to the same total.
 *
 * The dangerous operation is `reserve`. It moves `reserved_qty` on several levels
 * at once, and the default is ALL-OR-NOTHING: a half-reserved campaign is worse
 * than an unreserved one, because the gap is invisible until dispatch day. The
 * caller can opt into a partial hold, which is the right call when the rest is
 * already on a purchase order — but it has to say so.
 */

/* ------------------------------------------------------------------ list */

export async function listBulkOrders(
  query: BulkOrderListQuery,
): Promise<{ rows: BulkOrderSummary[]; total: number }> {
  const { field, direction } = parseSort(
    query.sort,
    ['createdAt', 'campaignNo', 'name', 'status', 'windowStartOn', 'budgetPaise'],
    { field: 'createdAt', direction: 'desc' },
  );
  const where = repo.campaignFilters(query);
  const [rows, total] = await Promise.all([
    repo.listCampaigns(
      where,
      repo.campaignOrderBy(field, direction),
      query.perPage,
      offsetOf(query.page, query.perPage),
    ),
    repo.countCampaigns(where),
  ]);

  return { rows: rows.map(toSummary), total };
}

export async function getBulkOrder(campaignId: string): Promise<BulkOrderDetail> {
  const campaign = await repo.findCampaign(campaignId);
  if (!campaign) throw new NotFoundError('Bulk order', campaignId);
  return buildDetail(campaign);
}

export async function createBulkOrder(
  input: CreateBulkOrderBody,
  staffId: string,
): Promise<BulkOrderDetail> {
  const account = await repo.findAccount(input.accountId);
  if (!account) throw new NotFoundError('Corporate account', input.accountId);

  if (input.quotationId) {
    const quotation = await repo.findQuotation(input.quotationId);
    if (!quotation) throw new NotFoundError('Quotation', input.quotationId);
    // A campaign pointing at another company's quotation would put one client's
    // pricing on another client's dispatch.
    if (quotation.accountId && quotation.accountId !== input.accountId) {
      throw new UnprocessableError(
        `Quotation ${quotation.quotationNo} belongs to a different corporate account. A campaign and its ` +
          'source quotation must be for the same buyer.',
        'quotation_account_mismatch',
        { context: { quotationId: input.quotationId, accountId: input.accountId } },
      );
    }
  }

  assertWindowOrder(input.windowStartOn, input.windowEndOn);

  const campaignId = await db.transaction(async (tx) => {
    const campaignNo = await repo.nextCampaignNumber(tx, new Date().getUTCFullYear());
    const created = await repo.insertCampaign(tx, {
      campaignNo,
      accountId: input.accountId,
      quotationId: input.quotationId ?? null,
      name: input.name,
      budgetPaise: input.budgetPaise,
      windowStartOn: input.windowStartOn ?? null,
      windowEndOn: input.windowEndOn ?? null,
      status: 'planning',
      ownerId: input.ownerId ?? staffId,
    });
    logger.info({ campaignId: created.id, campaignNo, staffId }, 'bulk order created');
    return created.id;
  });

  return getBulkOrder(campaignId);
}

export async function updateBulkOrder(
  campaignId: string,
  input: UpdateBulkOrderBody,
): Promise<BulkOrderDetail> {
  const existing = await repo.findCampaign(campaignId);
  if (!existing) throw new NotFoundError('Bulk order', campaignId);

  const windowStartOn = input.windowStartOn === undefined ? existing.windowStartOn : input.windowStartOn;
  const windowEndOn = input.windowEndOn === undefined ? existing.windowEndOn : input.windowEndOn;
  assertWindowOrder(windowStartOn, windowEndOn);

  await db.transaction(async (tx) => {
    await repo.updateCampaign(tx, campaignId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.budgetPaise !== undefined ? { budgetPaise: input.budgetPaise } : {}),
      ...(input.windowStartOn !== undefined ? { windowStartOn: input.windowStartOn ?? null } : {}),
      ...(input.windowEndOn !== undefined ? { windowEndOn: input.windowEndOn ?? null } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId ?? null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    });
  });

  return getBulkOrder(campaignId);
}

/* -------------------------------------------------------- inventory check */

export async function checkInventory(
  campaignId: string,
  body: InventoryCheckBody,
): Promise<InventoryCheckResponse> {
  const campaign = await repo.findCampaign(campaignId);
  if (!campaign) throw new NotFoundError('Bulk order', campaignId);

  const plan = await planAllocation(campaignId, body.warehouseId);

  return {
    bulkOrderId: campaignId,
    warehouseId: body.warehouseId ?? null,
    recipientCount: campaign.recipientCount,
    unassignedRecipientCount: plan.demand.unassignedRecipientCount,
    totalRequiredQty: plan.demand.totalUnits,
    totalAllocatableQty: plan.lines.reduce((sum, l) => sum + l.allocatedQty, 0),
    totalShortageQty: plan.lines.reduce((sum, l) => sum + l.shortageQty, 0),
    canFulfil: plan.demand.totalUnits > 0 && plan.lines.every((l) => l.shortageQty === 0),
    lines: plan.lines,
  };
}

/* -------------------------------------------------------------- reserve */

/**
 * Hold stock for the whole campaign, in ONE transaction.
 *
 * The allocation computed before the transaction is a PLAN, not a guarantee — the
 * stock it was based on can be taken by a checkout microseconds later. So the
 * transaction locks the levels in ascending id order, then applies the same
 * conditional `UPDATE … WHERE on_hand - reserved >= n` that every other write
 * uses. If any level refuses, the whole thing rolls back.
 *
 * Re-planning INSIDE the transaction is what makes that honest: after the locks
 * are taken the numbers cannot move again, so a plan built there is the plan that
 * executes.
 */
export async function reserveForBulkOrder(
  campaignId: string,
  body: ReserveBody,
  staffId: string,
): Promise<ReserveResponse> {
  return db.transaction(async (tx) => {
    const campaign = await repo.lockCampaign(tx, campaignId);
    if (!campaign) throw new NotFoundError('Bulk order', campaignId);

    if (campaign.status === 'cancelled' || campaign.status === 'completed') {
      throw new UnprocessableError(
        `This campaign is ${campaign.status}. Reserving stock for it would hold units nobody is going to ` +
          'dispatch.',
        'campaign_closed',
        { context: { status: campaign.status } },
      );
    }

    // Planned inside the transaction, after the campaign row is locked, so a
    // concurrent reserve on the same campaign queues rather than double-holds.
    const plan = await planAllocation(campaignId, body.warehouseId, tx);

    if (plan.demand.totalUnits === 0) {
      throw new UnprocessableError(
        'This campaign has no recipients with a gift assigned, so there is nothing to reserve. Upload ' +
          'the recipient list and assign gifts first.',
        'no_demand',
        { context: { unassignedRecipientCount: plan.demand.unassignedRecipientCount } },
      );
    }

    const shortage = plan.lines.reduce((sum, l) => sum + l.shortageQty, 0);
    if (shortage > 0 && !body.allowPartial) {
      const short = plan.lines.filter((l) => l.shortageQty > 0);
      throw new UnprocessableError(
        `${shortage} unit(s) short across ${short.length} gift(s) — nothing has been reserved. A ` +
          'half-reserved campaign hides the gap until dispatch day. Run POST /procurement-plan to see ' +
          'what to buy, or retry with `allowPartial: true` to hold what is available.',
        'insufficient_stock',
        {
          context: {
            totalShortageQty: shortage,
            lines: short.map((l) => ({
              variantId: l.variantId,
              requiredQty: l.requiredQty,
              allocatedQty: l.allocatedQty,
              shortageQty: l.shortageQty,
            })),
          },
        },
      );
    }

    // Ascending id, across EVERY line at once — the same deadlock protocol the
    // rest of the system uses. Locking per line would let two campaigns take the
    // same two levels in opposite orders.
    const levelIds = [
      ...new Set(plan.lines.flatMap((l) => l.allocations.map((a) => a.inventoryLevelId))),
    ].sort((a, b) => a.localeCompare(b));
    await repo.lockLevels(tx, levelIds);

    const at = new Date();
    const reservationIds: string[] = [];
    let newlyReservedUnits = 0;

    for (const line of plan.lines) {
      for (const allocation of line.allocations) {
        const held = await repo.reserveStock(tx, allocation.inventoryLevelId, allocation.quantity, at);
        if (!held) {
          // The conditional refused: somebody took the stock between the plan and
          // the lock. Rolling back whole is the only correct answer — a partially
          // applied hold cannot be identified afterwards.
          throw new UnprocessableError(
            `Stock for ${line.sku ?? line.variantId} at ${allocation.warehouseName ?? allocation.warehouseId} ` +
              `was taken while this reservation was being placed. Nothing has been reserved; run the ` +
              'inventory check again and retry.',
            'insufficient_stock',
            {
              context: {
                variantId: line.variantId,
                inventoryLevelId: allocation.inventoryLevelId,
                requestedQty: allocation.quantity,
              },
            },
          );
        }

        const reservation = await repo.insertCampaignReservation(tx, {
          campaignId,
          inventoryLevelId: allocation.inventoryLevelId,
          quantity: allocation.quantity,
        });
        reservationIds.push(reservation.id);
        newlyReservedUnits += allocation.quantity;
      }
    }

    // Holding stock is the moment a campaign stops being a plan. `body.note` is
    // not written here — `corporate_campaigns` has no note column, and the audit
    // middleware already records the request body against this operation, which
    // is where a reason for a stock hold belongs anyway.
    if (campaign.status === 'planning') {
      await repo.updateCampaign(tx, campaignId, { status: 'recipients_pending' });
    }

    const active = await repo.findActiveCampaignReservations(campaignId, tx);
    const reservedUnits = active.reduce((sum, r) => sum + r.quantity, 0);

    logger.info(
      { campaignId, campaignNo: campaign.campaignNo, newlyReservedUnits, shortage, staffId },
      'bulk order stock reserved',
    );

    return {
      bulkOrderId: campaignId,
      reservedUnits,
      newlyReservedUnits,
      shortageQty: shortage,
      partial: shortage > 0,
      reservationIds,
      lines: plan.lines,
    };
  });
}

/**
 * Give the held units back.
 *
 * Idempotent by construction: `released_at IS NULL` in the UPDATE's WHERE means a
 * second call closes nothing and decrements nothing. That matters because release
 * is exactly the operation somebody retries after a timeout.
 */
export async function releaseForBulkOrder(
  campaignId: string,
  body: ReleaseBody,
  staffId: string,
): Promise<ReleaseResponse> {
  return db.transaction(async (tx) => {
    const campaign = await repo.lockCampaign(tx, campaignId);
    if (!campaign) throw new NotFoundError('Bulk order', campaignId);

    const active = await repo.findActiveCampaignReservations(campaignId, tx);
    if (active.length === 0) {
      return {
        bulkOrderId: campaignId,
        releasedUnits: 0,
        releasedReservationCount: 0,
        remainingReservedUnits: 0,
      };
    }

    const levelIds = [...new Set(active.map((r) => r.inventoryLevelId))].sort((a, b) =>
      a.localeCompare(b),
    );
    await repo.lockLevels(tx, levelIds);

    const at = new Date();
    const closed = await repo.markCampaignReservationsReleased(
      tx,
      active.map((r) => r.id),
      at,
    );

    let releasedUnits = 0;
    for (const row of closed) {
      const ok = await repo.releaseReservedQty(tx, row.inventoryLevelId, row.quantity, at);
      if (!ok) {
        // `reserved_qty` is below what this reservation claims. That is a broken
        // invariant, not a race — refusing loudly beats leaving reserved_qty
        // negative, which would let the next checkout oversell.
        throw new UnprocessableError(
          `Reserved quantity at level ${row.inventoryLevelId} is lower than the ${row.quantity} unit(s) ` +
            'this reservation holds. Nothing has been released. This is a data inconsistency worth ' +
            'investigating before retrying.',
          'reservation_inconsistent',
          { context: { inventoryLevelId: row.inventoryLevelId, quantity: row.quantity } },
        );
      }
      releasedUnits += row.quantity;
    }

    const remaining = await repo.findActiveCampaignReservations(campaignId, tx);

    logger.info(
      { campaignId, campaignNo: campaign.campaignNo, releasedUnits, staffId },
      'bulk order stock released',
    );

    return {
      bulkOrderId: campaignId,
      releasedUnits,
      releasedReservationCount: closed.length,
      remainingReservedUnits: remaining.reduce((sum, r) => sum + r.quantity, 0),
    };
  });
}

/* ----------------------------------------------------------- procurement */

export async function procurementPlan(
  campaignId: string,
  body: ProcurementPlanBody,
): Promise<ProcurementPlanResponse> {
  const campaign = await repo.findCampaign(campaignId);
  if (!campaign) throw new NotFoundError('Bulk order', campaignId);

  const plan = await planAllocation(campaignId, body.warehouseId);
  const shortages = plan.lines
    .filter((l) => l.shortageQty > 0)
    .map((l) => ({ variantId: l.variantId, shortageQty: l.shortageQty }));

  const termRows = await repo.findSupplierTerms(shortages.map((s) => s.variantId));
  const terms = new Map<string, SupplierTerms>(
    termRows.map((t) => [
      t.variantId,
      {
        supplierId: t.supplierId,
        supplierName: t.supplierName,
        moq: t.moq,
        // 0 is the column default, meaning "nobody has said" rather than
        // "arrives instantly". Treating it as zero days would mark every
        // unquoted item as comfortably on time.
        leadTimeDays: t.leadTimeDays > 0 ? t.leadTimeDays : null,
        unitCostPaise: t.unitCostPaise > 0 ? t.unitCostPaise : null,
      },
    ]),
  );

  const built = buildProcurementPlan(shortages, terms, {
    windowStartOn: campaign.windowStartOn,
  });

  return {
    bulkOrderId: campaignId,
    windowStartOn: campaign.windowStartOn,
    totalOrderQty: built.totalOrderQty,
    estimatedTotalPaise: built.estimatedTotalPaise,
    lateLineCount: built.lateLineCount,
    longestLeadTimeDays: built.longestLeadTimeDays,
    lines: built.lines.map((l) => {
      const label = plan.labels.get(l.variantId);
      return {
        variantId: l.variantId,
        sku: label?.sku ?? null,
        name: label?.name ?? null,
        shortageQty: l.shortageQty,
        orderQty: l.orderQty,
        supplierId: l.supplierId,
        supplierName: l.supplierName,
        leadTimeDays: l.leadTimeDays,
        estimatedCostPaise: l.estimatedCostPaise,
        orderByDate: l.orderByDate,
        meetsWindow: l.meetsWindow,
      };
    }),
  };
}

/* ----------------------------------------------------------- fulfilment */

export async function fulfillmentPlan(
  campaignId: string,
  query: FulfillmentPlanQuery,
): Promise<FulfillmentPlanResponse> {
  const campaign = await repo.findCampaign(campaignId);
  if (!campaign) throw new NotFoundError('Bulk order', campaignId);

  const [recipients, reservations] = await Promise.all([
    repo.findRecipients(campaignId),
    repo.findActiveCampaignReservations(campaignId),
  ]);

  const assigned = recipients.filter((r) => r.variantId !== null);
  const reservedUnits = reservations.reduce((sum, r) => sum + r.quantity, 0);

  const groups = new Map<string, { label: string | null; recipientCount: number; unitCount: number }>();
  const bump = (key: string, label: string | null, units: number): void => {
    const existing = groups.get(key);
    if (existing) {
      existing.recipientCount += 1;
      existing.unitCount += units;
      if (existing.label === null) existing.label = label;
    } else {
      groups.set(key, { label, recipientCount: 1, unitCount: units });
    }
  };

  if (query.groupBy === 'warehouse') {
    // Grouped by where the HELD units sit, then recipients distributed across
    // those warehouses in the same proportion. Recipients carry no warehouse of
    // their own — nothing in `campaign_recipients` says which site ships to them.
    const byWarehouse = new Map<string, { label: string | null; unitCount: number }>();
    for (const reservation of reservations) {
      const existing = byWarehouse.get(reservation.warehouseId);
      if (existing) existing.unitCount += reservation.quantity;
      else
        byWarehouse.set(reservation.warehouseId, {
          label: reservation.warehouseName,
          unitCount: reservation.quantity,
        });
    }
    for (const [warehouseId, entry] of byWarehouse) {
      groups.set(warehouseId, {
        label: entry.label,
        // One unit per recipient today, so units and recipients coincide. Stated
        // rather than assumed, because a multi-gift recipient would break it.
        recipientCount: entry.unitCount,
        unitCount: entry.unitCount,
      });
    }
  } else if (query.groupBy === 'state') {
    for (const recipient of assigned) {
      bump(recipient.stateCode ?? 'UNKNOWN', recipient.stateCode ?? 'No state on file', 1);
    }
  } else {
    const labels = await repo.findVariantLabels([
      ...new Set(assigned.map((r) => r.variantId).filter((v): v is string => v !== null)),
    ]);
    const byId = new Map(labels.map((l) => [l.variantId, l]));
    for (const recipient of assigned) {
      const key = recipient.variantId ?? 'UNASSIGNED';
      bump(key, byId.get(key)?.name ?? null, 1);
    }
  }

  const rows = [...groups.entries()]
    .map(([key, g]) => ({
      key,
      label: g.label,
      recipientCount: g.recipientCount,
      unitCount: g.unitCount,
    }))
    .sort((a, b) => b.unitCount - a.unitCount || a.key.localeCompare(b.key));

  const plannedUnits = rows.reduce((sum, g) => sum + g.unitCount, 0);

  return {
    bulkOrderId: campaignId,
    groupBy: query.groupBy,
    reservedUnits,
    plannedUnits,
    // §88 in the shape the caller can act on. Not thrown: a plan for an
    // unreserved campaign is a legitimate thing to look at BEFORE reserving.
    balanced: plannedUnits === reservedUnits,
    unreservedUnits: Math.max(0, assigned.length - reservedUnits),
    groups: rows,
  };
}

/* -------------------------------------------------------------- helpers */

type PlannedLine = DemandAllocation & {
  sku: string | null;
  name: string | null;
  recipientCount: number;
  availableQty: number;
};

/**
 * Recipients → demand → allocation, in one place.
 *
 * Shared by the check, the reservation and the procurement plan so all three
 * answer the same question with the same arithmetic. Three copies of an
 * allocation rule become three different allocation rules.
 */
async function planAllocation(campaignId: string, warehouseId: string | undefined, exec?: Tx) {
  const recipients = exec
    ? await repo.findRecipients(campaignId, exec)
    : await repo.findRecipients(campaignId);

  const demand = aggregateDemand(recipients);
  const variantIds = demand.lines.map((l) => l.variantId);

  const [positions, labelRows] = await Promise.all([
    exec
      ? repo.findPositions(variantIds, warehouseId, exec)
      : repo.findPositions(variantIds, warehouseId),
    exec ? repo.findVariantLabels(variantIds, exec) : repo.findVariantLabels(variantIds),
  ]);

  const labels = new Map(labelRows.map((l) => [l.variantId, l]));
  const byVariant = new Map<string, WarehousePosition[]>();
  for (const position of positions) {
    const bucket = byVariant.get(position.variantId) ?? [];
    bucket.push({
      inventoryLevelId: position.inventoryLevelId,
      warehouseId: position.warehouseId,
      warehouseName: position.warehouseName,
      availableQty: position.availableQty,
    });
    byVariant.set(position.variantId, bucket);
  }

  const lines: PlannedLine[] = demand.lines.map((line) => {
    const available = byVariant.get(line.variantId) ?? [];
    const allocation = allocateDemand(line.variantId, line.quantity, available);
    // §88 — checked on the happy path too. An invariant tested only where it is
    // expected to fail is not an invariant.
    assertAllocationBalances(allocation);

    const label = labels.get(line.variantId);
    return {
      ...allocation,
      sku: label?.sku ?? null,
      name: label?.name ?? null,
      recipientCount: line.recipientCount,
      availableQty: available.reduce((sum, p) => sum + Math.max(0, p.availableQty), 0),
    };
  });

  return { demand, lines, labels };
}

function assertWindowOrder(startOn: string | null | undefined, endOn: string | null | undefined): void {
  if (!startOn || !endOn) return;
  if (endOn < startOn) {
    throw new UnprocessableError(
      `The dispatch window ends (${endOn}) before it starts (${startOn}). \`CHECK campaign_window\` ` +
        'refuses that, so it is caught here with a message rather than as a constraint violation.',
      'invalid_campaign_window',
      { context: { windowStartOn: startOn, windowEndOn: endOn } },
    );
  }
}

const toSummary = (row: repo.CampaignRow): BulkOrderSummary => ({
  id: row.id,
  campaignNo: row.campaignNo,
  accountId: row.accountId,
  accountName: row.accountName,
  quotationId: row.quotationId,
  quotationNo: row.quotationNo,
  name: row.name,
  status: row.status,
  budgetPaise: row.budgetPaise,
  windowStartOn: row.windowStartOn,
  windowEndOn: row.windowEndOn,
  ownerId: row.ownerId,
  recipientCount: row.recipientCount,
  assignedRecipientCount: row.assignedRecipientCount,
  dispatchedRecipientCount: row.dispatchedRecipientCount,
  reservedUnits: row.reservedUnits,
  createdAt: row.createdAt.toISOString(),
});

async function buildDetail(campaign: repo.CampaignRow): Promise<BulkOrderDetail> {
  const recipients = await repo.findRecipients(campaign.id);
  const demand = aggregateDemand(recipients);
  const labelRows = await repo.findVariantLabels(demand.lines.map((l) => l.variantId));
  const labels = new Map(labelRows.map((l) => [l.variantId, l]));

  return {
    ...toSummary(campaign),
    totalRequiredQty: demand.totalUnits,
    unassignedRecipientCount: demand.unassignedRecipientCount,
    demand: demand.lines.map((l) => ({
      variantId: l.variantId,
      sku: labels.get(l.variantId)?.sku ?? null,
      name: labels.get(l.variantId)?.name ?? null,
      requiredQty: l.quantity,
      recipientCount: l.recipientCount,
    })),
  };
}
