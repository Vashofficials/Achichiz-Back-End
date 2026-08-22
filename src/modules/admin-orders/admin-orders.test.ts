import { describe, expect, it } from 'vitest';
import { ForbiddenError, UnprocessableError } from '../../lib/errors.js';
import { permissionsForRole, ROLES, type Role } from '../../lib/rbac-matrix.js';
import { ORDER_STATUSES, type OrderStatus } from '../../db/schema/index.js';
import {
  assertStaffCancellable,
  assertStaffTransition,
  canStaffCancel,
  edgesFrom,
  STAFF_TRANSITIONS,
  staffCancellationTarget,
} from './admin-orders.state.js';
import {
  assertMayRefund,
  availableTransitions,
  BULK_ACTION_REQUIREMENTS,
  buildOrderWhere,
  financialYearOf,
} from './admin-orders.service.js';
import { adminOrderListQuery, orderBulkBody, refundBody, transitionBody } from './admin-orders.schemas.js';

/**
 * Pure tests only — no database, no Redis. What is worth testing here is the
 * authorization boundary and the state machine, which are the two things that
 * were 100% client-side (and self-service) in the console this replaces.
 */

/** A staff principal carrying exactly the grants the matrix gives that role. */
const principal = (role: Role): { role: string; permissions: ReadonlySet<string> } => ({
  role,
  permissions: new Set(permissionsForRole(role)),
});

describe('refund authorization — the definition of done', () => {
  it('a Catalogue Manager cannot issue a refund', () => {
    const catalogueManager = principal('Catalogue Manager');

    expect(catalogueManager.permissions.has('orders:refund')).toBe(false);
    expect(() => assertMayRefund(catalogueManager)).toThrow(ForbiddenError);
    expect(() => assertMayRefund(catalogueManager)).toThrow(/does not have permission to refund/i);
  });

  it('a Catalogue Manager cannot reach a refund through the state machine either', () => {
    const catalogueManager = principal('Catalogue Manager');
    // Not merely "the button is hidden": the edge itself is refused.
    expect(() =>
      assertStaffTransition('delivered', 'refund_initiated', catalogueManager.permissions, 'Catalogue Manager'),
    ).toThrow(ForbiddenError);
  });

  it('only Finance Manager and Super Admin may refund, out of all eleven roles', () => {
    const allowed = ROLES.filter((role) => {
      try {
        assertMayRefund(principal(role));
        return true;
      } catch {
        return false;
      }
    });

    expect(allowed).toEqual(['Super Admin', 'Finance Manager']);
  });

  it('roles that may CANCEL still may not REFUND — cancelling is not refunding', () => {
    for (const role of ['Operations Manager', 'Order Manager'] as const) {
      const actor = principal(role);
      expect(actor.permissions.has('orders:cancel')).toBe(true);
      expect(() => assertMayRefund(actor)).toThrow(ForbiddenError);
    }
  });

  it('a Finance Manager may refund', () => {
    expect(() => assertMayRefund(principal('Finance Manager'))).not.toThrow();
  });
});

describe('order state machine', () => {
  it('covers all sixteen statuses', () => {
    expect(Object.keys(STAFF_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('never declares an edge to a status that does not exist', () => {
    for (const status of ORDER_STATUSES) {
      for (const edge of edgesFrom(status)) {
        expect(ORDER_STATUSES).toContain(edge.to);
      }
    }
  });

  it('rejects an illegal transition for everyone, including a Super Admin', () => {
    const superAdmin = principal('Super Admin');
    // Nothing jumps the queue from `paid` straight to `delivered`.
    expect(() => assertStaffTransition('paid', 'delivered', superAdmin.permissions, 'Super Admin')).toThrow(
      UnprocessableError,
    );
    expect(() => assertStaffTransition('paid', 'delivered', superAdmin.permissions, 'Super Admin')).toThrow(
      /cannot move to/i,
    );
  });

  it('checks legality BEFORE permission, so a missing grant is never blamed for a missing edge', () => {
    const contentManager = principal('Content Manager'); // no `orders` grants at all
    let thrown: unknown;
    try {
      assertStaffTransition('delivered', 'packed', contentManager.permissions, 'Content Manager');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnprocessableError);
  });

  it('treats terminal statuses as terminal', () => {
    expect(edgesFrom('cancelled')).toHaveLength(0);
    expect(edgesFrom('refunded')).toHaveLength(0);
    expect(() =>
      assertStaffTransition('cancelled', 'paid', principal('Super Admin').permissions, 'Super Admin'),
    ).toThrow(/terminal state/i);
  });

  it('refuses courier- and gateway-owned edges even to a Super Admin', () => {
    const superAdmin = principal('Super Admin');
    const systemEdges: [OrderStatus, OrderStatus][] = [
      ['pending_payment', 'paid'],
      ['shipped', 'out_for_delivery'],
      ['out_for_delivery', 'delivered'],
      ['out_for_delivery', 'failed_delivery'],
      ['refund_initiated', 'refunded'],
    ];

    for (const [from, to] of systemEdges) {
      expect(() => assertStaffTransition(from, to, superAdmin.permissions, 'Super Admin')).toThrow(
        UnprocessableError,
      );
      expect(() => assertStaffTransition(from, to, superAdmin.permissions, 'Super Admin')).toThrow(
        /courier or the payment gateway/i,
      );
    }
  });

  it('lets a Warehouse Manager pack but not cancel', () => {
    const warehouse = principal('Warehouse Manager');
    expect(() =>
      assertStaffTransition('quality_check', 'packed', warehouse.permissions, 'Warehouse Manager'),
    ).not.toThrow();
    expect(() =>
      assertStaffTransition('packed', 'cancelled', warehouse.permissions, 'Warehouse Manager'),
    ).toThrow(ForbiddenError);
  });

  it('lets an Order Manager cancel a pre-shipment order', () => {
    const orderManager = principal('Order Manager');
    expect(() =>
      assertStaffTransition('confirmed', 'cancelled', orderManager.permissions, 'Order Manager'),
    ).not.toThrow();
  });

  it('marks exactly the pre-shipment statuses cancellable', () => {
    const cancellable = ORDER_STATUSES.filter(canStaffCancel);
    expect(cancellable).toEqual([
      'pending_payment',
      'paid',
      'confirmed',
      'in_production',
      'personalisation_pending',
      'quality_check',
      'packed',
      'ready_to_ship',
    ]);
    expect(() => assertStaffCancellable('shipped')).toThrow(UnprocessableError);
    expect(() => assertStaffCancellable('delivered')).toThrow(/return-to-origin/i);
  });

  it('sends a paid cancellation to refund_initiated, never straight to cancelled', () => {
    expect(staffCancellationTarget('paid')).toBe('refund_initiated');
    expect(staffCancellationTarget('partially_refunded')).toBe('refund_initiated');
    expect(staffCancellationTarget('pending')).toBe('cancelled');
    expect(staffCancellationTarget('cod_due')).toBe('cancelled');
  });
});

describe('availableTransitions', () => {
  it('reports system edges as never allowed, whatever the role', () => {
    const view = availableTransitions('out_for_delivery', principal('Super Admin').permissions);
    expect(view.every((t) => t.systemOnly)).toBe(true);
    expect(view.every((t) => !t.allowed)).toBe(true);
  });

  it('flags allowed per role rather than hiding the edge', () => {
    const forFinance = availableTransitions('delivered', principal('Finance Manager').permissions);
    const forCatalogue = availableTransitions('delivered', principal('Catalogue Manager').permissions);

    // Same edges either way — the console renders a disabled button, not a gap.
    expect(forFinance.map((t) => t.to)).toEqual(forCatalogue.map((t) => t.to));
    expect(forFinance.find((t) => t.to === 'refund_initiated')?.allowed).toBe(true);
    expect(forCatalogue.find((t) => t.to === 'refund_initiated')?.allowed).toBe(false);
  });

  it('surfaces the side effects a transition carries', () => {
    const shipped = availableTransitions('ready_to_ship', principal('Operations Manager').permissions);
    const edge = shipped.find((t) => t.to === 'shipped');
    expect(edge?.sideEffects.join(' ')).toMatch(/AWB/i);
  });
});

describe('bulk action requirements', () => {
  it('makes `cancel` need orders:cancel, which the route’s own edit gate does not imply', () => {
    expect(BULK_ACTION_REQUIREMENTS.cancel).toBe('cancel');
    const warehouse = principal('Warehouse Manager');
    expect(warehouse.permissions.has('orders:edit')).toBe(true);
    expect(warehouse.permissions.has('orders:cancel')).toBe(false);
  });

  it('keeps the non-destructive actions on edit', () => {
    expect(BULK_ACTION_REQUIREMENTS.mark_packed).toBe('edit');
    expect(BULK_ACTION_REQUIREMENTS.mark_ready_to_ship).toBe('edit');
    expect(BULK_ACTION_REQUIREMENTS.generate_invoices).toBe('edit');
    expect(BULK_ACTION_REQUIREMENTS.assign_courier).toBe('edit');
  });
});

describe('list query compilation', () => {
  it('applies the shared pagination defaults and cap', () => {
    const parsed = adminOrderListQuery.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(25);
    expect(adminOrderListQuery.safeParse({ perPage: 101 }).success).toBe(false);
    expect(adminOrderListQuery.safeParse({ perPage: 100 }).success).toBe(true);
  });

  it('builds no WHERE at all for an unfiltered page', () => {
    expect(buildOrderWhere({ page: 1, perPage: 25 })).toBeUndefined();
  });

  it('accepts a comma-separated list of valid statuses', () => {
    expect(buildOrderWhere({ page: 1, perPage: 25, status: 'packed,ready_to_ship' })).toBeDefined();
  });

  it('rejects an unknown enum value rather than returning a silently empty page', () => {
    expect(() => buildOrderWhere({ page: 1, perPage: 25, status: 'nearly_packed' })).toThrow(
      /Unknown status/i,
    );
    expect(() => buildOrderWhere({ page: 1, perPage: 25, paymentStatus: 'paid,maybe' })).toThrow(
      /Unknown paymentStatus/i,
    );
    expect(() => buildOrderWhere({ page: 1, perPage: 25, channel: 'carrier-pigeon' })).toThrow(
      /Unknown channel/i,
    );
  });

  it('rejects an unparseable date bound', () => {
    expect(() => buildOrderWhere({ page: 1, perPage: 25, placedFrom: 'last tuesday' })).toThrow(
      /not a date/i,
    );
  });

  it('builds a WHERE for the full six-filter set plus search', () => {
    const where = buildOrderWhere({
      page: 1,
      perPage: 25,
      q: 'ACH1000',
      status: 'confirmed',
      paymentStatus: 'paid',
      channel: 'website',
      deliveryType: 'same_day',
      priority: 'vip',
      warehouseId: '9f8b2c1a-7d3e-4f5a-9b6c-2e1d4a7f8c30',
      placedFrom: '2026-01-01',
      placedTo: '2026-12-31',
      tag: 'corporate',
    });
    expect(where).toBeDefined();
  });
});

describe('request bodies', () => {
  it('requires a cancellation reason — the database refuses one without it', () => {
    expect(refundBody.safeParse({ amountPaise: 100, reason: 'damaged' }).success).toBe(true);
    expect(refundBody.safeParse({ amountPaise: 0, reason: 'damaged' }).success).toBe(false);
    expect(refundBody.safeParse({ amountPaise: -100, reason: 'damaged' }).success).toBe(false);
    // Money is integer paise; a rupee float is not a refund amount.
    expect(refundBody.safeParse({ amountPaise: 10.5, reason: 'damaged' }).success).toBe(false);
  });

  it('only accepts real statuses on a transition', () => {
    expect(transitionBody.safeParse({ status: 'packed' }).success).toBe(true);
    expect(transitionBody.safeParse({ status: 'Packed' }).success).toBe(false);
  });

  it('caps a bulk selection', () => {
    const id = '9f8b2c1a-7d3e-4f5a-9b6c-2e1d4a7f8c30';
    expect(orderBulkBody.safeParse({ action: 'mark_packed', orderIds: [id] }).success).toBe(true);
    expect(
      orderBulkBody.safeParse({ action: 'mark_packed', orderIds: Array.from({ length: 101 }, () => id) })
        .success,
    ).toBe(false);
    expect(orderBulkBody.safeParse({ action: 'teleport', orderIds: [id] }).success).toBe(false);
  });
});

describe('financial year', () => {
  it('runs April to March', () => {
    expect(financialYearOf(new Date('2026-04-01T00:00:00Z'))).toBe('26-27');
    expect(financialYearOf(new Date('2027-03-31T23:59:59Z'))).toBe('26-27');
    expect(financialYearOf(new Date('2026-03-31T23:59:59Z'))).toBe('25-26');
    expect(financialYearOf(new Date('2026-12-31T00:00:00Z'))).toBe('26-27');
  });
});
