/**
 * Bulk-order planning — pure arithmetic, no database, no HTTP.
 *
 * A corporate campaign is a list of recipients, each wanting one gift. The
 * inventory question is therefore not "is this in stock" but "can we cover 800
 * units across four warehouses, and if not, what do we buy and when".
 *
 * Three computations live here, in the order the endpoints use them:
 *
 * ## 1. Demand — recipients collapse to per-variant totals
 *
 * 800 recipients wanting the same hamper is one line of 800, not 800 lines. The
 * aggregation is by variant, and a recipient with no variant assigned yet is
 * counted separately rather than silently dropped: "we cannot plan for 43 people
 * because nobody has chosen their gift" is the answer the planner needs, and a
 * quiet 757 is the answer that ships 43 empty boxes.
 *
 * ## 2. Allocation — §88, and it must SUM EXACTLY
 *
 * Stock for one variant lives at several warehouses. Allocation decides how much
 * comes from each. The invariant the spec names is that the per-warehouse
 * allocations sum to exactly the reserved total — not approximately, and not
 * "close enough after rounding". A campaign whose allocations sum to 799 against
 * a reservation of 800 has one recipient nobody will ever ship to, and nothing
 * downstream will notice.
 *
 * So `allocateDemand` returns the allocations AND the shortfall, and
 * `assertAllocationBalances` is the check that they add up. It is called even on
 * the happy path, because the whole point of an invariant is that it is not
 * checked only where you expect it to fail.
 *
 * **Allocation is greedy, largest-stock-first.** Not because it is optimal —
 * optimal would weigh distance to the recipient, which this system does not model
 * — but because it is DETERMINISTIC and it minimises the number of warehouses a
 * single campaign draws from. Splitting 800 units across four sites when two
 * would do multiplies the dispatch work by two for no gain.
 *
 * ## 3. Procurement — the shortfall becomes purchase lines
 *
 * What cannot be covered has to be bought. Quantities round UP to the supplier's
 * MOQ (`roundUpToMoq`, shared with the reorder engine rather than reimplemented),
 * and the lead time decides whether the campaign window is still reachable. When
 * it is not, that is stated as a fact with a date, not softened into a warning.
 */

import { roundUpToMoq } from '../admin-inventory/admin-inventory.stock.js';

/* ------------------------------------------------------------------ demand */

/** One recipient, reduced to the only two fields planning cares about. */
export type RecipientDemand = {
  id: string;
  /** Null until somebody assigns this recipient a gift. */
  variantId: string | null;
  /** Recipients this row stands for. Always 1 today; a parameter so a future
   *  "12 for the Bangalore office" line does not need a different function. */
  quantity?: number;
};

export type DemandLine = {
  variantId: string;
  quantity: number;
  recipientCount: number;
};

export type AggregatedDemand = {
  lines: DemandLine[];
  totalUnits: number;
  /** Recipients with no gift assigned. Reported, never silently skipped. */
  unassignedRecipientCount: number;
  unassignedRecipientIds: string[];
};

/**
 * Recipients collapse to per-variant totals.
 *
 * Sorted by variant id so two calls on the same campaign produce the same plan —
 * a procurement plan that reorders its own lines between refreshes is a plan
 * nobody trusts.
 */
export function aggregateDemand(recipients: readonly RecipientDemand[]): AggregatedDemand {
  const byVariant = new Map<string, DemandLine>();
  const unassignedRecipientIds: string[] = [];

  for (const recipient of recipients) {
    const quantity = Math.max(1, Math.trunc(recipient.quantity ?? 1));

    if (!recipient.variantId) {
      unassignedRecipientIds.push(recipient.id);
      continue;
    }

    const existing = byVariant.get(recipient.variantId);
    if (existing) {
      existing.quantity += quantity;
      existing.recipientCount += 1;
    } else {
      byVariant.set(recipient.variantId, {
        variantId: recipient.variantId,
        quantity,
        recipientCount: 1,
      });
    }
  }

  const lines = [...byVariant.values()].sort((a, b) => a.variantId.localeCompare(b.variantId));

  return {
    lines,
    totalUnits: lines.reduce((sum, l) => sum + l.quantity, 0),
    unassignedRecipientCount: unassignedRecipientIds.length,
    unassignedRecipientIds,
  };
}

/* -------------------------------------------------------------- allocation */

/** One warehouse's position for one variant. `availableQty` is on_hand − reserved. */
export type WarehousePosition = {
  inventoryLevelId: string;
  warehouseId: string;
  warehouseName: string | null;
  availableQty: number;
};

export type Allocation = {
  inventoryLevelId: string;
  warehouseId: string;
  warehouseName: string | null;
  /** Units taken from this warehouse. Always > 0 — a zero allocation is not a row. */
  quantity: number;
};

export type DemandAllocation = {
  variantId: string;
  requiredQty: number;
  allocatedQty: number;
  /** `requiredQty − allocatedQty`, floored at 0. Non-zero means buy or transfer. */
  shortageQty: number;
  allocations: Allocation[];
};

/**
 * Cover one variant's demand from the warehouses that hold it.
 *
 * Largest-stock-first, so a campaign draws from as few sites as possible. Ties
 * break on `inventoryLevelId`, which makes the result deterministic — the same
 * campaign asked twice produces the same plan, and the ascending-id order is also
 * the lock order the reservation transaction takes.
 *
 * Never allocates more than a warehouse has, and never allocates a zero row.
 */
export function allocateDemand(
  variantId: string,
  requiredQty: number,
  positions: readonly WarehousePosition[],
): DemandAllocation {
  const wanted = Math.max(0, Math.trunc(requiredQty));

  const ranked = [...positions]
    .filter((p) => p.availableQty > 0)
    .sort((a, b) =>
      b.availableQty !== a.availableQty
        ? b.availableQty - a.availableQty
        : a.inventoryLevelId.localeCompare(b.inventoryLevelId),
    );

  const allocations: Allocation[] = [];
  let remaining = wanted;

  for (const position of ranked) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, position.availableQty);
    if (take <= 0) continue;
    allocations.push({
      inventoryLevelId: position.inventoryLevelId,
      warehouseId: position.warehouseId,
      warehouseName: position.warehouseName,
      quantity: take,
    });
    remaining -= take;
  }

  // Sorted into lock order for the reservation transaction — the same ascending-id
  // protocol every other multi-level write in this system uses.
  allocations.sort((a, b) => a.inventoryLevelId.localeCompare(b.inventoryLevelId));

  const allocatedQty = allocations.reduce((sum, a) => sum + a.quantity, 0);

  return {
    variantId,
    requiredQty: wanted,
    allocatedQty,
    shortageQty: Math.max(0, wanted - allocatedQty),
    allocations,
  };
}

/**
 * §88 — the allocations must sum to exactly what was allocated, and never exceed
 * what was required.
 *
 * Checked on the happy path too. An invariant only tested where it is expected to
 * fail is not an invariant; and the failure this catches — allocations that sum to
 * 799 against a reservation of 800 — is invisible everywhere downstream, because
 * every individual number looks reasonable.
 */
export function assertAllocationBalances(allocation: DemandAllocation): void {
  const summed = allocation.allocations.reduce((sum, a) => sum + a.quantity, 0);

  if (summed !== allocation.allocatedQty) {
    throw new Error(
      `Allocation for ${allocation.variantId} does not balance: rows sum to ${summed} but the total ` +
        `says ${allocation.allocatedQty}. Nothing was reserved.`,
    );
  }
  if (summed > allocation.requiredQty) {
    throw new Error(
      `Allocation for ${allocation.variantId} over-allocates: ${summed} against a requirement of ` +
        `${allocation.requiredQty}. Nothing was reserved.`,
    );
  }
  if (summed + allocation.shortageQty !== allocation.requiredQty) {
    throw new Error(
      `Allocation for ${allocation.variantId} loses units: ${summed} allocated plus ` +
        `${allocation.shortageQty} short is not ${allocation.requiredQty}. Nothing was reserved.`,
    );
  }
  if (allocation.allocations.some((a) => a.quantity <= 0)) {
    throw new Error(`Allocation for ${allocation.variantId} contains a zero or negative row.`);
  }
}

/* ------------------------------------------------------------- procurement */

export type SupplierTerms = {
  supplierId: string | null;
  supplierName: string | null;
  /** `supplier_products.moq`. At least 1. */
  moq: number;
  /** `supplier_products.lead_time_days`. Null when the supplier has never said. */
  leadTimeDays: number | null;
  unitCostPaise: number | null;
};

export type ProcurementLine = {
  variantId: string;
  shortageQty: number;
  /** `shortageQty` rounded up to the supplier's minimum. What goes on the PO. */
  orderQty: number;
  supplierId: string | null;
  supplierName: string | null;
  leadTimeDays: number | null;
  /** `orderQty × unitCost`, or null when no cost is on file. Integer paise. */
  estimatedCostPaise: number | null;
  /** The date this line must be ordered by to land before the window opens. */
  orderByDate: string | null;
  /** False when ordering today still misses the window. */
  meetsWindow: boolean;
};

export type ProcurementPlan = {
  lines: ProcurementLine[];
  totalOrderQty: number;
  /** Null when any line has no cost on file — a partial total invites bad decisions. */
  estimatedTotalPaise: number | null;
  /** Lines that cannot arrive in time however promptly they are ordered. */
  lateLineCount: number;
  longestLeadTimeDays: number | null;
};

const DAY_MS = 86_400_000;
const isoDate = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * Turn shortfalls into purchase lines.
 *
 * `windowStartOn` is the date the campaign has to start dispatching. A line whose
 * lead time does not fit between today and that date is marked `meetsWindow:
 * false` and its `orderByDate` is in the past — stated as a fact rather than
 * softened, because the decision it drives (split the campaign, substitute the
 * gift, move the date) belongs to a human and needs the real number.
 *
 * `estimatedTotalPaise` is null if ANY line lacks a cost. A total that silently
 * omits the three most expensive items is worse than no total.
 */
export function buildProcurementPlan(
  shortages: readonly { variantId: string; shortageQty: number }[],
  terms: ReadonlyMap<string, SupplierTerms>,
  options: { windowStartOn?: string | null; today?: Date } = {},
): ProcurementPlan {
  const today = options.today ?? new Date();
  const windowStart = options.windowStartOn ? new Date(`${options.windowStartOn}T00:00:00.000Z`) : null;

  const lines: ProcurementLine[] = shortages
    .filter((s) => s.shortageQty > 0)
    .map((shortage) => {
      const supplier = terms.get(shortage.variantId);
      const moq = Math.max(1, supplier?.moq ?? 1);
      const orderQty = roundUpToMoq(shortage.shortageQty, moq);
      const leadTimeDays = supplier?.leadTimeDays ?? null;

      // No window, or no stated lead time: nothing to be late against. An unknown
      // lead time is reported as unknown rather than assumed to be zero, which
      // would mark every unquoted item as comfortably on time.
      let orderByDate: string | null = null;
      let meetsWindow = true;
      if (windowStart && leadTimeDays !== null) {
        const orderBy = new Date(windowStart.getTime() - leadTimeDays * DAY_MS);
        orderByDate = isoDate(orderBy);
        meetsWindow = orderBy.getTime() >= today.getTime() - DAY_MS;
      }

      const unitCostPaise = supplier?.unitCostPaise ?? null;

      return {
        variantId: shortage.variantId,
        shortageQty: shortage.shortageQty,
        orderQty,
        supplierId: supplier?.supplierId ?? null,
        supplierName: supplier?.supplierName ?? null,
        leadTimeDays,
        estimatedCostPaise: unitCostPaise === null ? null : orderQty * unitCostPaise,
        orderByDate,
        meetsWindow,
      };
    })
    .sort((a, b) => a.variantId.localeCompare(b.variantId));

  const leadTimes = lines.map((l) => l.leadTimeDays).filter((d): d is number => d !== null);

  return {
    lines,
    totalOrderQty: lines.reduce((sum, l) => sum + l.orderQty, 0),
    estimatedTotalPaise: lines.some((l) => l.estimatedCostPaise === null)
      ? null
      : lines.reduce((sum, l) => sum + (l.estimatedCostPaise ?? 0), 0),
    lateLineCount: lines.filter((l) => !l.meetsWindow).length,
    longestLeadTimeDays: leadTimes.length > 0 ? Math.max(...leadTimes) : null,
  };
}
