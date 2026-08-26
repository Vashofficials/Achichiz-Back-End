import { describe, expect, it } from 'vitest';
import {
  TRANSFER_TRANSITIONS,
  assertLocationDepth,
  assertTransferAction,
  buildLocationPath,
  isTransferEditable,
  rewriteLocationPath,
  transferEdgesFrom,
  type TransferAction,
} from './admin-warehousing.state.js';
import { STOCK_TRANSFER_STATUSES, type StockTransferStatus } from '../../db/schema/index.js';

/**
 * The transfer state machine and the location tree are pure, so they are tested
 * exhaustively here without a database. What they protect is not abstract:
 * a transfer that can be cancelled mid-flight, or a bin whose path stops
 * matching its ancestors, both end with someone walking to the wrong shelf.
 */

const asAction = (s: string): TransferAction => s as TransferAction;

describe('transfer state machine — vocabulary', () => {
  it('uses ONLY the statuses the database CHECK allows', () => {
    // The brief said draft → dispatched → completed. The table says otherwise, and
    // the table wins: anything else is a runtime CHECK violation on every write.
    const declared = Object.keys(TRANSFER_TRANSITIONS).sort();
    expect(declared).toEqual([...STOCK_TRANSFER_STATUSES].sort());
  });

  it('never targets a status outside that vocabulary', () => {
    for (const edges of Object.values(TRANSFER_TRANSITIONS)) {
      for (const e of edges) {
        expect(STOCK_TRANSFER_STATUSES).toContain(e.to);
      }
    }
  });

  it('is a total function — every status has an entry, even terminal ones', () => {
    for (const s of STOCK_TRANSFER_STATUSES) {
      expect(Array.isArray(transferEdgesFrom(s))).toBe(true);
    }
  });
});

describe('transfer state machine — legality', () => {
  it('walks the happy path requested → approved → in_transit → received', () => {
    expect(assertTransferAction('requested', 'approve').to).toBe('approved');
    expect(assertTransferAction('approved', 'dispatch').to).toBe('in_transit');
    expect(assertTransferAction('in_transit', 'receive').to).toBe('received');
  });

  it('REFUSES to cancel a transfer already in transit', () => {
    // The stock has left the source. "Cancelling" would leave those units in
    // neither warehouse's ledger — invisible inventory, which is precisely what
    // the movement ledger exists to make impossible.
    expect(() => assertTransferAction('in_transit', 'cancel')).toThrowError(
      expect.objectContaining({ code: 'transfer_in_transit_not_cancellable' }),
    );
  });

  it('explains what IS possible rather than only saying no', () => {
    try {
      assertTransferAction('requested', 'receive');
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as { code: string; message: string };
      expect(err.code).toBe('illegal_transfer_transition');
      // An operator told only "no" goes hunting for a button that never existed.
      expect(err.message).toContain('approve');
    }
  });

  it('treats received and cancelled as terminal', () => {
    for (const terminal of ['received', 'cancelled'] as const) {
      expect(transferEdgesFrom(terminal)).toHaveLength(0);
      for (const action of ['approve', 'dispatch', 'receive', 'cancel']) {
        expect(() => assertTransferAction(terminal, asAction(action))).toThrow();
      }
    }
  });

  it('rejects every transition not in the table — exhaustive sweep', () => {
    const legal = new Set<string>();
    for (const [from, edges] of Object.entries(TRANSFER_TRANSITIONS)) {
      for (const e of edges) legal.add(`${from}:${e.action}`);
    }
    for (const from of STOCK_TRANSFER_STATUSES) {
      for (const action of ['approve', 'dispatch', 'receive', 'cancel'] as const) {
        if (legal.has(`${from}:${action}`)) continue;
        expect(() => assertTransferAction(from, action)).toThrow();
      }
    }
  });

  it('never silently no-ops — an illegal action always throws', () => {
    // A cancel that quietly does nothing is how a warehouse ships stock somebody
    // believed they had stopped.
    expect(() => assertTransferAction('received', 'cancel')).toThrow();
  });
});

describe('transfer state machine — which edges move stock', () => {
  it('marks exactly dispatch and receive as stock-moving', () => {
    const moving: string[] = [];
    for (const edges of Object.values(TRANSFER_TRANSITIONS)) {
      for (const e of edges) if (e.movesStock) moving.push(e.action);
    }
    expect([...new Set(moving)].sort()).toEqual(['dispatch', 'receive']);
  });

  it('does not move stock on approve or cancel', () => {
    expect(assertTransferAction('requested', 'approve').movesStock).toBe(false);
    expect(assertTransferAction('requested', 'cancel').movesStock).toBe(false);
    expect(assertTransferAction('approved', 'cancel').movesStock).toBe(false);
  });

  it('documents the in-transit accounting on the dispatch edge', () => {
    // Stock in transit belongs to neither warehouse's available. That is correct,
    // and the console needs to be able to say so before the click.
    const edge = assertTransferAction('approved', 'dispatch');
    expect(edge.sideEffects?.join(' ')).toMatch(/neither warehouse/i);
  });
});

describe('transfer editability', () => {
  it('allows edits only while requested', () => {
    expect(isTransferEditable('requested')).toBe(true);
    for (const s of ['approved', 'in_transit', 'received', 'cancelled'] as StockTransferStatus[]) {
      expect(isTransferEditable(s)).toBe(false);
    }
  });
});

describe('location hierarchy — depth', () => {
  it('accepts a root of any kind', () => {
    expect(() => assertLocationDepth(null, 'bin')).not.toThrow();
    expect(() => assertLocationDepth(null, 'zone')).not.toThrow();
  });

  it('accepts a strictly deeper child', () => {
    expect(() => assertLocationDepth('zone', 'rack')).not.toThrow();
    expect(() => assertLocationDepth('rack', 'shelf')).not.toThrow();
    expect(() => assertLocationDepth('shelf', 'bin')).not.toThrow();
  });

  it('allows SKIPPING levels — a zone straight to a bin is a small warehouse', () => {
    // Migration 0003 exists so a studio with one room and a shop with racks are
    // the same shape at different depths. Forcing exactly-one-level would make
    // the small case unrepresentable.
    expect(() => assertLocationDepth('zone', 'bin')).not.toThrow();
    expect(() => assertLocationDepth('zone', 'shelf')).not.toThrow();
  });

  it('rejects a child at the SAME depth as its parent', () => {
    expect(() => assertLocationDepth('rack', 'rack')).toThrowError(
      expect.objectContaining({ code: 'invalid_location_depth' }),
    );
  });

  it('rejects an inverted hierarchy — a shelf under a bin is not a warehouse', () => {
    expect(() => assertLocationDepth('bin', 'shelf')).toThrow();
    expect(() => assertLocationDepth('shelf', 'zone')).toThrow();
  });
});

describe('location path building', () => {
  it('uses the bare code at the root', () => {
    expect(buildLocationPath(null, 'A')).toBe('A');
  });

  it('joins with a slash under a parent', () => {
    expect(buildLocationPath('A', 'R3')).toBe('A/R3');
    expect(buildLocationPath('A/R3/S2', 'B7')).toBe('A/R3/S2/B7');
  });
});

describe('location path rewriting on a subtree move', () => {
  it('rewrites the moved node itself', () => {
    expect(rewriteLocationPath('A/R3', 'A/R3', 'B/R9')).toBe('B/R9');
  });

  it('rewrites every DESCENDANT, not just the direct child', () => {
    // A grandchild silently keeping the old prefix is invisible until someone
    // walks to the wrong bin.
    expect(rewriteLocationPath('A/R3/S2/B7', 'A/R3', 'B/R9')).toBe('B/R9/S2/B7');
  });

  it('leaves unrelated paths untouched', () => {
    expect(rewriteLocationPath('C/R1/S1', 'A/R3', 'B/R9')).toBe('C/R1/S1');
  });

  it('does not match a mere string prefix — A/R3 must not catch A/R30', () => {
    // Without the boundary slash, moving rack R3 would silently drag R30 with it.
    expect(rewriteLocationPath('A/R30/S1', 'A/R3', 'B/R9')).toBe('A/R30/S1');
  });
});
