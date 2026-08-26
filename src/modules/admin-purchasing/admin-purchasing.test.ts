import { describe, expect, it } from 'vitest';
import {
  PO_LIFECYCLES,
  PO_TRANSITIONS,
  RETURN_TRANSITIONS,
  assertPoAction,
  assertReturnAction,
  isPoEditable,
  isPoReceivable,
  poEdgesFrom,
  poLifecycle,
  poPersistedState,
  poStatusAfterReceipt,
  returnEdgesFrom,
  type PoAction,
  type PoLifecycle,
  type ReturnAction,
} from './admin-purchasing.state.js';
import {
  PURCHASE_ORDER_STATUSES,
  PURCHASE_RETURN_STATUSES,
  type PurchaseReturnStatus,
} from '../../db/schema/index.js';

const asPoAction = (s: string): PoAction => s as PoAction;
const asReturnAction = (s: string): ReturnAction => s as ReturnAction;

/**
 * Purchasing state is pure, so it is tested exhaustively without a database.
 *
 * The subtle piece is the PO lifecycle: `purchase_orders.status` has no
 * `approved` value — the CHECK allows only draft/sent/partially_received/
 * received/cancelled. An approved-but-not-yet-sent PO is therefore stored as
 * `status='sent', sent_at IS NULL`, and the lifecycle is DERIVED. If that
 * derivation is wrong, a PO nobody has sent still looks sent to the buyer.
 */

describe('PO lifecycle derivation', () => {
  it('reads an unsent row as approved, not sent', () => {
    expect(poLifecycle('sent', null)).toBe('approved');
  });

  it('reads a row with sent_at as genuinely sent', () => {
    expect(poLifecycle('sent', new Date('2026-08-01T10:00:00Z'))).toBe('sent');
  });

  it('passes every other status through unchanged', () => {
    expect(poLifecycle('draft', null)).toBe('draft');
    expect(poLifecycle('partially_received', null)).toBe('partially_received');
    expect(poLifecycle('received', null)).toBe('received');
    expect(poLifecycle('cancelled', null)).toBe('cancelled');
  });

  it('round-trips: persist(approved) then derive gives approved back', () => {
    const now = new Date('2026-08-01T10:00:00Z');
    const persisted = poPersistedState('approved', now);
    expect(persisted.status).toBe('sent');
    expect(persisted.sentAt).toBeNull();
    expect(poLifecycle(persisted.status, persisted.sentAt)).toBe('approved');
  });

  it('round-trips: persist(sent) then derive gives sent back', () => {
    const now = new Date('2026-08-01T10:00:00Z');
    const persisted = poPersistedState('sent', now);
    expect(persisted.sentAt).toEqual(now);
    expect(poLifecycle(persisted.status, persisted.sentAt)).toBe('sent');
  });

  it('only ever persists a status the database CHECK allows', () => {
    const now = new Date();
    for (const l of ['approved', 'sent'] as const) {
      expect(PURCHASE_ORDER_STATUSES).toContain(poPersistedState(l, now).status);
    }
  });
});

describe('PO state machine', () => {
  it('is a total function over every lifecycle value', () => {
    for (const l of PO_LIFECYCLES) {
      expect(Array.isArray(poEdgesFrom(l))).toBe(true);
    }
  });

  it('walks draft → approved → sent', () => {
    expect(assertPoAction('draft', 'approve').to).toBe('approved');
    expect(assertPoAction('approved', 'send').to).toBe('sent');
  });

  it('rejects sending a PO that has not been approved', () => {
    // Sending an unapproved PO commits money to a supplier with no sign-off.
    expect(() => assertPoAction('draft', 'send')).toThrow();
  });

  it('rejects receiving against a PO that was never sent', () => {
    expect(() => assertPoAction('draft', 'receive')).toThrow();
    expect(() => assertPoAction('approved', 'receive')).toThrow();
  });

  it('treats received and cancelled as terminal', () => {
    for (const terminal of ['received', 'cancelled'] as PoLifecycle[]) {
      expect(poEdgesFrom(terminal)).toHaveLength(0);
      for (const a of ['edit', 'approve', 'send', 'receive', 'cancel']) {
        expect(() => assertPoAction(terminal, asPoAction(a))).toThrow();
      }
    }
  });

  it('rejects every transition not in the table — exhaustive sweep', () => {
    const legal = new Set<string>();
    for (const [from, edges] of Object.entries(PO_TRANSITIONS)) {
      for (const e of edges) legal.add(`${from}:${e.action}`);
    }
    for (const from of PO_LIFECYCLES) {
      for (const a of ['edit', 'approve', 'send', 'receive', 'cancel'] as const) {
        if (legal.has(`${from}:${a}`)) continue;
        expect(() => assertPoAction(from, a)).toThrow();
      }
    }
  });

  it('allows edits only before approval', () => {
    expect(isPoEditable('draft')).toBe(true);
    for (const l of ['sent', 'partially_received', 'received', 'cancelled'] as PoLifecycle[]) {
      expect(isPoEditable(l)).toBe(false);
    }
  });

  it('allows receiving only once sent, and while partially received', () => {
    expect(isPoReceivable('sent')).toBe(true);
    expect(isPoReceivable('partially_received')).toBe(true);
    expect(isPoReceivable('draft')).toBe(false);
    expect(isPoReceivable('received')).toBe(false);
    expect(isPoReceivable('cancelled')).toBe(false);
  });
});

describe('partial goods receipt — the status after receiving', () => {
  it('is partially_received when some lines are short', () => {
    expect(
      poStatusAfterReceipt([
        { orderedQty: 100, receivedQty: 95 },
        { orderedQty: 50, receivedQty: 50 },
      ]),
    ).toBe('partially_received');
  });

  it('is received only when every unit is in', () => {
    expect(
      poStatusAfterReceipt([
        { orderedQty: 100, receivedQty: 100 },
        { orderedQty: 50, receivedQty: 50 },
      ]),
    ).toBe('received');
  });

  it('stays partially_received when nothing has arrived yet', () => {
    expect(poStatusAfterReceipt([{ orderedQty: 100, receivedQty: 0 }])).toBe('partially_received');
  });

  it('closes the PO on an over-receipt rather than leaving it open forever', () => {
    // Suppliers ship 102 against an order of 100. Requiring exact equality would
    // leave that PO permanently "partially received" and never reconcilable.
    expect(poStatusAfterReceipt([{ orderedQty: 100, receivedQty: 102 }])).toBe('received');
  });

  it('compares TOTALS, so a surplus on one line can close a short on another', () => {
    // Deliberate and worth stating: the aggregate is what settles the PO. Per-line
    // shortfalls are visible on the lines themselves.
    expect(
      poStatusAfterReceipt([
        { orderedQty: 100, receivedQty: 110 },
        { orderedQty: 100, receivedQty: 90 },
      ]),
    ).toBe('received');
  });

  it('handles an empty line set without dividing by anything', () => {
    expect(poStatusAfterReceipt([])).toBe('received');
  });
});

describe('purchase return state machine', () => {
  it('covers exactly the statuses the database CHECK allows', () => {
    expect(Object.keys(RETURN_TRANSITIONS).sort()).toEqual([...PURCHASE_RETURN_STATUSES].sort());
  });

  it('never targets a status outside that vocabulary', () => {
    for (const edges of Object.values(RETURN_TRANSITIONS)) {
      for (const e of edges) expect(PURCHASE_RETURN_STATUSES).toContain(e.to);
    }
  });

  it('walks draft → approved → dispatched → completed', () => {
    expect(assertReturnAction('draft', 'approve').to).toBe('approved');
    expect(assertReturnAction('approved', 'dispatch').to).toBe('dispatched');
    expect(assertReturnAction('dispatched', 'complete').to).toBe('completed');
  });

  it('rejects dispatching stock back to a supplier without approval', () => {
    expect(() => assertReturnAction('draft', 'dispatch')).toThrow();
  });

  it('marks dispatch as the stock-moving edge', () => {
    // Dispatch is the moment the units leave. Approve and cancel touch nothing.
    expect(assertReturnAction('approved', 'dispatch').movesStock).toBe(true);
    expect(assertReturnAction('draft', 'approve').movesStock).toBe(false);
  });

  it('treats completed and cancelled as terminal', () => {
    for (const terminal of ['completed', 'cancelled'] as PurchaseReturnStatus[]) {
      expect(returnEdgesFrom(terminal)).toHaveLength(0);
    }
  });

  it('rejects every transition not in the table — exhaustive sweep', () => {
    const legal = new Set<string>();
    for (const [from, edges] of Object.entries(RETURN_TRANSITIONS)) {
      for (const e of edges) legal.add(`${from}:${e.action}`);
    }
    for (const from of PURCHASE_RETURN_STATUSES) {
      for (const a of ['approve', 'dispatch', 'complete', 'cancel'] as const) {
        if (legal.has(`${from}:${a}`)) continue;
        expect(() => assertReturnAction(from, asReturnAction(a))).toThrow();
      }
    }
  });
});
