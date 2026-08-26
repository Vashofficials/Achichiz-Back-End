/**
 * The arithmetic of the stock ledger — pure functions, no database, no HTTP.
 *
 * Everything in this file is deliberately testable without Postgres, because
 * these are the rules that decide whether a warehouse can oversell. They are
 * split out of the service for the same reason `admin-orders.state.ts` is split
 * out of `admin-orders.service.ts`: the interesting invariant should be readable
 * on one screen and provable in a unit test.
 *
 * Two things this file is NOT:
 *
 *  1. **It is not the concurrency mechanism.** These checks run against a row the
 *     transaction has already locked, and they exist to produce a readable error
 *     with real numbers in it. The mechanism that makes overselling impossible is
 *     the conditional `UPDATE ... WHERE on_hand_qty - reserved_qty + $delta >= 0`
 *     in the repository, whose `rowCount` the service checks. See §4.1 and the
 *     header of `db/schema/inventory.ts`.
 *
 *  2. **It is not the source of truth for `availableQty`.** That is a GENERATED
 *     column in Postgres (`on_hand_qty - reserved_qty` STORED), so it cannot
 *     drift. `availableOf` recomputes the same expression for values held in
 *     memory mid-transaction; it never overrides what the database returned.
 */

import { UnprocessableError } from '../../lib/errors.js';

/** Just enough of an `inventory_levels` row to reason about a change to it. */
export type StockPosition = {
  onHandQty: number;
  reservedQty: number;
};

/**
 * Sellable stock: what is physically here minus what is already promised.
 *
 * The same expression Postgres stores in the generated `available_qty` column.
 */
export const availableOf = (position: StockPosition): number =>
  position.onHandQty - position.reservedQty;

/**
 * §64 — a decrement may never take sellable stock below zero.
 *
 * A negative `quantityDelta` is a withdrawal. It has to come out of the SELLABLE
 * balance, not the on-hand balance: units already reserved for a paid order are
 * physically present but spoken for, and letting an adjustment eat them would
 * turn someone else's confirmed order into a stockout at picking time. That is
 * why the test is `on_hand - reserved + delta >= 0` rather than
 * `on_hand + delta >= 0`.
 *
 * An increment is always allowed and returns immediately.
 *
 * Throws with the STABLE code `insufficient_stock`. Frontends switch on it.
 */
export function assertSufficientStock(
  position: StockPosition,
  quantityDelta: number,
  label: string,
): void {
  if (quantityDelta >= 0) return;

  const available = availableOf(position);
  if (available + quantityDelta >= 0) return;

  throw new UnprocessableError(
    `${label} has ${available} sellable (${position.onHandQty} on hand, ${position.reservedQty} reserved). ` +
      `Removing ${Math.abs(quantityDelta)} would leave ${available + quantityDelta}, which is not a quantity ` +
      `that can exist. Release the reservations first, or record a smaller adjustment.`,
    'insufficient_stock',
    {
      context: {
        onHandQty: position.onHandQty,
        reservedQty: position.reservedQty,
        availableQty: available,
        requestedDelta: quantityDelta,
      },
    },
  );
}

/**
 * The running balance written onto the movement row.
 *
 * `stock_movements.balance_after` is the on-hand balance AFTER this movement, so
 * that a nightly job can assert `SUM(quantity_delta) = inventory_levels.on_hand_qty`
 * and so that a ledger read alone reconstructs the position at any point in time.
 * It is the ON-HAND balance, never the available one — reservations do not appear
 * in this ledger at all, so subtracting them here would make consecutive rows
 * disagree by however many holds happened to exist.
 *
 * Callers pass the row as it was BEFORE the update; the value returned must equal
 * the `on_hand_qty` the conditional UPDATE actually returned. The service asserts
 * exactly that rather than trusting either number on its own.
 */
export function balanceAfter(position: StockPosition, quantityDelta: number): number {
  return position.onHandQty + quantityDelta;
}

/**
 * §14 — a reservation moves `reserved_qty` and NOTHING else.
 *
 * On-hand is untouched: the units have not moved, they are only spoken for. This
 * is also why a reservation writes no `stock_movements` row — the ledger tracks
 * physical movement, and a hold that appeared in it would double-count against
 * `balance_after` the moment the goods actually shipped.
 */
export function assertReservable(position: StockPosition, quantity: number, label: string): void {
  const available = availableOf(position);
  if (quantity <= available) return;

  throw new UnprocessableError(
    `${label} has ${available} sellable (${position.onHandQty} on hand, ${position.reservedQty} already reserved). ` +
      `A hold for ${quantity} cannot be placed.`,
    'insufficient_stock',
    {
      context: {
        onHandQty: position.onHandQty,
        reservedQty: position.reservedQty,
        availableQty: available,
        requestedQty: quantity,
      },
    },
  );
}

/** What a reservation does to a level. Exported so the invariant is testable. */
export function applyReservation(
  position: StockPosition,
  quantity: number,
): StockPosition {
  return { onHandQty: position.onHandQty, reservedQty: position.reservedQty + quantity };
}

/* --------------------------------------------------------------- alerting */

export const STOCK_STATES = ['in', 'low', 'out'] as const;
export type StockState = (typeof STOCK_STATES)[number];

/**
 * §16 — the storefront is told `in` / `low` / `out`, never a number.
 *
 * Publishing "3 left" invites scraping of the whole catalogue's stock position,
 * and it is wrong the instant someone else's cart holds two of them.
 */
export function stockState(position: StockPosition, reorderPoint: number): StockState {
  const available = availableOf(position);
  if (available <= 0) return 'out';
  if (available <= reorderPoint) return 'low';
  return 'in';
}

/* ---------------------------------------------------------------- reorder */

export type ReorderInputs = {
  /** Physically present. */
  onHandQty: number;
  /** Already promised to a cart, order, quotation or manual hold. */
  reservedQty: number;
  /** On an approved purchase order that has not been received yet. */
  incomingQty: number;
  /** The level at which a buyer should act. Already a column on `inventory_levels`. */
  reorderPoint: number;
  /** The house's normal order size for this item. Also already a column. */
  reorderQty: number;
  /** Supplier minimum order quantity, from `supplier_products.moq`. At least 1. */
  moq: number;
};

export type ReorderSuggestion = {
  /** Sellable stock plus what is already on its way. */
  inventoryPosition: number;
  /** The level the order is sized to restore. */
  targetLevel: number;
  /** How far below the target the position sits, before MOQ rounding. */
  shortfallQty: number;
  /** What to actually put on the purchase order. A whole multiple of `moq`. */
  suggestedQty: number;
  /** False when the position is still above the reorder point. */
  shouldReorder: boolean;
};

/**
 * THE reorder formula. One function, one place, documented — deliberately not
 * inlined into a query or duplicated between the alert screen and the PO draft,
 * because two copies of a purchasing rule become two different purchasing rules.
 *
 * ```
 *   position  = on_hand - reserved + incoming      // inventory position
 *   trigger   = position <= reorder_point
 *   target    = reorder_point + reorder_qty        // the order-up-to level
 *   shortfall = max(0, target - position)
 *   suggested = ceil(max(shortfall, 1) / moq) * moq
 * ```
 *
 * Three choices worth stating out loud:
 *
 * **Incoming counts.** Ordering against on-hand alone re-orders every item that
 * already has a purchase order in flight, which is how a warehouse ends up with
 * four months of ribbon.
 *
 * **Reserved does not count as stock.** Units held for a paid order will leave
 * the building; treating them as cover is how the next order stocks out.
 *
 * **The suggestion is rounded UP to the MOQ, never down.** A supplier who will
 * not ship fewer than 50 makes an order for 12 into an order for 50; rounding
 * down would produce a purchase order the supplier rejects. When the shortfall
 * is already a multiple of the MOQ it is left alone.
 *
 * This function does not decide COST or SUPPLIER — see `admin-inventory.service.ts`,
 * which joins `supplier_products` for the preferred supplier and lead time. It is
 * pure so that it can be tested without a warehouse.
 */
export function reorderSuggestion(input: ReorderInputs): ReorderSuggestion {
  const moq = Math.max(1, Math.trunc(input.moq));
  const inventoryPosition = input.onHandQty - input.reservedQty + input.incomingQty;
  const targetLevel = input.reorderPoint + input.reorderQty;
  const shortfallQty = Math.max(0, targetLevel - inventoryPosition);
  const shouldReorder = inventoryPosition <= input.reorderPoint;

  if (!shouldReorder) {
    return { inventoryPosition, targetLevel, shortfallQty, suggestedQty: 0, shouldReorder: false };
  }

  // At the reorder point with a target that happens to equal the position, the
  // shortfall is 0 but the buyer still needs to act — order one MOQ.
  const raw = Math.max(shortfallQty, 1);
  const suggestedQty = Math.ceil(raw / moq) * moq;

  return { inventoryPosition, targetLevel, shortfallQty, suggestedQty, shouldReorder: true };
}

/** Round an operator-supplied quantity up to the supplier's minimum. */
export const roundUpToMoq = (quantity: number, moq: number): number => {
  const unit = Math.max(1, Math.trunc(moq));
  return Math.ceil(Math.max(1, quantity) / unit) * unit;
};
