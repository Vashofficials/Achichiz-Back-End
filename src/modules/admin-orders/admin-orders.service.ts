/**
 * The order desk.
 *
 * Three rules shape this file.
 *
 * **1. Every status change goes through the state machine.** Nothing here writes
 * `orders.status` without `assertStaffTransition` having agreed that the edge
 * exists, that it is not a courier/gateway fact being forged by hand, and that
 * the caller holds the RBAC action the edge names. Legality is checked before
 * authorisation, so an illegal move is 422 for everyone including a Super Admin.
 *
 * **2. Money leaves through the payments SERVICE.** `refund()` calls
 * `payments.refundOrder()` — service→service. This module never touches
 * `payments`, `refunds` or the Razorpay client itself, so the idempotency key,
 * the "write the row before calling the gateway" ordering and the refund cap all
 * stay in one place instead of being re-derived by a second caller.
 *
 * **3. Bulk is per-order, not all-or-nothing.** Fifty orders selected on a busy
 * desk will include a few that moved since the page rendered. Failing the whole
 * batch for those is useless; each order gets its own outcome.
 *
 * On filters: the generic engine's `filter[key][op]` compiler is deliberately
 * NOT reused here. Orders is the sixtieth resource and the one screen with a
 * bespoke query surface — six named dropdowns, two date ranges and a
 * seven-field search that reaches into `shipments` for the AWB. Bending the
 * generic compiler around that would make it worse at the fifty-eight screens it
 * exists for. What IS shared is `parseSort`'s allowlist discipline from
 * `lib/pagination.ts`: a sort field is matched, never passed through.
 */

import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, type Tx } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { BadRequestError, ForbiddenError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import { permissionKey } from '../../lib/rbac-matrix.js';
import { assertStepUp } from '../admin-auth/admin-auth.service.js';
import * as payments from '../payments/payments.service.js';
import * as repo from './admin-orders.repository.js';
import {
  assertStaffCancellable,
  assertStaffTransition,
  edgesFrom,
  staffCancellationTarget,
} from './admin-orders.state.js';
import type {
  AdminOrderDetailResponse,
  AdminOrderKpisResponse,
  AdminOrderSummaryResponse,
  AvailableTransitionResponse,
  OrderBulkResultResponse,
} from './admin-orders.schemas.js';
import type { StaffAuth } from '../../lib/openapi/define-route.js';
import {
  orders,
  type Order,
  type OrderChannel,
  type OrderDeliveryType,
  type OrderPaymentStatus,
  type OrderPriority,
  type OrderStatus,
} from '../../db/schema/index.js';

/* ------------------------------------------------------------------ sort */

const SORT_FIELDS = [
  'placedAt',
  'orderNo',
  'totalPaise',
  'status',
  'priority',
  'requestedDeliveryDate',
  'updatedAt',
] as const;

const SORT_COLUMNS = {
  placedAt: orders.placedAt,
  orderNo: orders.orderNo,
  totalPaise: orders.totalPaise,
  status: orders.status,
  priority: orders.priority,
  requestedDeliveryDate: orders.requestedDeliveryDate,
  updatedAt: orders.updatedAt,
} as const;

/* --------------------------------------------------------------- filters */

export type AdminOrderQuery = {
  page: number;
  perPage: number;
  q?: string | undefined;
  sort?: string | undefined;
  status?: string | undefined;
  paymentStatus?: string | undefined;
  channel?: string | undefined;
  deliveryType?: string | undefined;
  priority?: string | undefined;
  warehouseId?: string | undefined;
  corporateAccountId?: string | undefined;
  placedFrom?: string | undefined;
  placedTo?: string | undefined;
  deliveryFrom?: string | undefined;
  deliveryTo?: string | undefined;
  tag?: string | undefined;
};

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * `?status=packed,ready_to_ship` → `inArray`, with every value checked against
 * the enum first. An unknown value is a 400 rather than a silently empty page:
 * a typo that returns zero orders reads exactly like "there are no orders".
 */
function enumIn<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  column: Parameters<typeof inArray>[0],
  label: string,
): SQL | undefined {
  const values = csv(raw);
  if (values.length === 0) return undefined;

  const unknown = values.filter((v) => !(allowed as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Unknown ${label}: ${unknown.join(', ')}. Valid values: ${allowed.join(', ')}.`,
    );
  }
  return inArray(column, values);
}

function parseInstant(raw: string | undefined, label: string): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`\`${label}\` is not a date I can read: '${raw}'.`);
  }
  return parsed;
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The seven-field search the console's order desk does client-side today:
 * order number, buyer, recipient, both mobiles, destination PIN code, and the
 * AWB — which lives on `shipments`, so it goes through an EXISTS rather than a
 * join that would fan a multi-parcel order out into several rows.
 */
function searchClause(q: string | undefined): SQL | undefined {
  const term = q?.trim();
  if (!term) return undefined;
  const pattern = `%${escapeLike(term)}%`;

  return or(
    ilike(orders.orderNo, pattern),
    ilike(orders.buyerName, pattern),
    ilike(orders.buyerEmail, pattern),
    ilike(orders.buyerMobile, pattern),
    ilike(orders.recipientName, pattern),
    ilike(orders.recipientMobile, pattern),
    ilike(orders.shipPincode, pattern),
    repo.awbMatches(pattern),
  );
}

const ORDER_STATUS_VALUES: readonly OrderStatus[] = [
  'pending_payment',
  'paid',
  'confirmed',
  'in_production',
  'personalisation_pending',
  'quality_check',
  'packed',
  'ready_to_ship',
  'shipped',
  'out_for_delivery',
  'delivered',
  'failed_delivery',
  'rto',
  'cancelled',
  'refund_initiated',
  'refunded',
];
const PAYMENT_STATUS_VALUES: readonly OrderPaymentStatus[] = [
  'pending',
  'paid',
  'failed',
  'partially_refunded',
  'refunded',
  'cod_due',
];
const CHANNEL_VALUES: readonly OrderChannel[] = [
  'website',
  'mobile_app',
  'whatsapp',
  'corporate_portal',
  'phone',
  'admin',
];
const DELIVERY_TYPE_VALUES: readonly OrderDeliveryType[] = [
  'standard',
  'scheduled',
  'same_day',
  'midnight',
  'international',
];
const PRIORITY_VALUES: readonly OrderPriority[] = ['standard', 'high', 'vip'];

/** `tags @> ARRAY[$1]` — the tag is a bound parameter, not interpolated text. */
const arrayContainsTag = (tag: string): SQL => sql`${orders.tags} @> ARRAY[${tag}]::text[]`;

/** Exported for the test: the whole WHERE is buildable without a database. */
export function buildOrderWhere(query: AdminOrderQuery): SQL | undefined {
  const placedFrom = parseInstant(query.placedFrom, 'placedFrom');
  const placedTo = parseInstant(query.placedTo, 'placedTo');

  const conditions: (SQL | undefined)[] = [
    enumIn(query.status, ORDER_STATUS_VALUES, orders.status, 'status'),
    enumIn(query.paymentStatus, PAYMENT_STATUS_VALUES, orders.paymentStatus, 'paymentStatus'),
    enumIn(query.channel, CHANNEL_VALUES, orders.channel, 'channel'),
    enumIn(query.deliveryType, DELIVERY_TYPE_VALUES, orders.deliveryType, 'deliveryType'),
    enumIn(query.priority, PRIORITY_VALUES, orders.priority, 'priority'),
    query.warehouseId ? eq(orders.fulfilmentWarehouseId, query.warehouseId) : undefined,
    query.corporateAccountId ? eq(orders.corporateAccountId, query.corporateAccountId) : undefined,
    placedFrom ? gte(orders.placedAt, placedFrom) : undefined,
    placedTo ? lte(orders.placedAt, placedTo) : undefined,
    query.deliveryFrom ? gte(orders.requestedDeliveryDate, query.deliveryFrom) : undefined,
    query.deliveryTo ? lte(orders.requestedDeliveryDate, query.deliveryTo) : undefined,
    query.tag ? arrayContainsTag(query.tag) : undefined,
    searchClause(query.q),
  ];

  const present = conditions.filter((c): c is SQL => Boolean(c));
  return present.length > 0 ? and(...present) : undefined;
}

/* --------------------------------------------------------------- reading */

function toSummary(row: repo.AdminOrderListRow): AdminOrderSummaryResponse {
  const o = row.order;
  return {
    id: o.id,
    orderNo: o.orderNo,
    status: o.status,
    paymentStatus: o.paymentStatus,
    fulfilmentStatus: o.fulfilmentStatus,
    channel: o.channel,
    priority: o.priority,
    deliveryType: o.deliveryType,
    buyerName: o.buyerName,
    buyerMobile: o.buyerMobile,
    recipientName: o.recipientName,
    shipCity: o.shipCity,
    shipPincode: o.shipPincode,
    totalPaise: o.totalPaise,
    amountPaidPaise: o.amountPaidPaise,
    amountRefundedPaise: o.amountRefundedPaise,
    itemCount: row.itemCount,
    lineCount: row.lineCount,
    awb: row.awb,
    courierName: row.courierName,
    warehouseId: o.fulfilmentWarehouseId,
    corporateAccountId: o.corporateAccountId,
    tags: o.tags,
    placedAt: o.placedAt.toISOString(),
    requestedDeliveryDate: o.requestedDeliveryDate,
    deliverySlot: o.deliverySlot,
  };
}

export async function listOrders(query: AdminOrderQuery): Promise<{
  items: AdminOrderSummaryResponse[];
  total: number;
  kpis: AdminOrderKpisResponse;
}> {
  const where = buildOrderWhere(query);
  const { field, direction } = parseSort(query.sort, SORT_FIELDS, {
    field: 'placedAt',
    direction: 'desc',
  });
  const column = SORT_COLUMNS[field as keyof typeof SORT_COLUMNS];
  // A unique tiebreak, or rows with equal sort keys drift between pages.
  const orderBy = [direction === 'desc' ? desc(column) : asc(column), asc(orders.id)];

  const [{ rows, total }, kpis] = await Promise.all([
    repo.listOrders(where, orderBy, query.perPage, offsetOf(query.page, query.perPage)),
    // Computed over the same WHERE, so "order value" means the filtered set —
    // not "the value of the ten rows that happen to be on screen".
    repo.orderKpis(where),
  ]);

  return { items: rows.map(toSummary), total, kpis };
}

export function availableTransitions(
  status: OrderStatus,
  permissions: ReadonlySet<string>,
): AvailableTransitionResponse[] {
  return edgesFrom(status).map((edge) => ({
    to: edge.to,
    label: edge.label,
    action: edge.action ?? 'system',
    allowed: Boolean(
      !edge.systemOnly && edge.action && permissions.has(permissionKey('orders', edge.action)),
    ),
    systemOnly: edge.systemOnly ?? false,
    sideEffects: [...(edge.sideEffects ?? [])],
  }));
}

export async function getOrder(orderId: string, auth: StaffAuth): Promise<AdminOrderDetailResponse> {
  const row = await repo.findOrder(orderId);
  if (!row) throw new NotFoundError('Order', orderId);

  const lines = await repo.findLines(orderId);
  const lineIds = lines.map((l) => l.id);

  const [addOns, personalisations, timeline, paymentRows, refundRows, shipmentRows, invoiceRows] =
    await Promise.all([
      repo.findLineAddOns(lineIds),
      repo.findLinePersonalisations(lineIds),
      repo.findTimeline(orderId),
      repo.findPayments(orderId),
      repo.findRefunds(orderId),
      repo.findShipments(orderId),
      repo.findInvoices(orderId),
    ]);

  const addOnsByLine = new Map<string, typeof addOns>();
  for (const addOn of addOns) {
    const bucket = addOnsByLine.get(addOn.orderLineId);
    if (bucket) bucket.push(addOn);
    else addOnsByLine.set(addOn.orderLineId, [addOn]);
  }
  const personalisationByLine = new Map(personalisations.map((p) => [p.orderLineId, p.inputText]));

  const o = row.order;

  return {
    ...toSummary(row),
    currency: o.currency,
    buyerEmail: o.buyerEmail,
    recipientMobile: o.recipientMobile,
    isAnonymousGift: o.isAnonymousGift,
    giftMessage: o.giftMessage,
    shippingAddress: {
      line1: o.shipLine1,
      line2: o.shipLine2,
      area: o.shipArea,
      city: o.shipCity,
      stateCode: o.shipStateCode,
      pincode: o.shipPincode,
      countryCode: o.shipCountryCode,
    },
    billing: {
      sameAsShipping: o.billSameAsShip,
      name: o.billName,
      line1: o.billLine1,
      city: o.billCity,
      stateCode: o.billStateCode,
      pincode: o.billPincode,
      gstin: o.billGstin,
    },
    tax: {
      placeOfSupplyStateCode: o.placeOfSupplyStateCode,
      supplierGstin: o.supplierGstin,
      isInterstate: o.isInterstate,
      isExport: o.isExport,
    },
    money: {
      subtotalPaise: o.subtotalPaise,
      couponDiscountPaise: o.couponDiscountPaise,
      autoDiscountPaise: o.autoDiscountPaise,
      loyaltyDiscountPaise: o.loyaltyDiscountPaise,
      shippingPaise: o.shippingPaise,
      codFeePaise: o.codFeePaise,
      taxablePaise: o.taxablePaise,
      cgstPaise: o.cgstPaise,
      sgstPaise: o.sgstPaise,
      igstPaise: o.igstPaise,
      cessPaise: o.cessPaise,
      roundOffPaise: o.roundOffPaise,
      totalPaise: o.totalPaise,
      refundablePaise: refundablePaise(o),
    },
    couponCode: o.couponCode,
    internalNotes: o.internalNotes,
    cancelReason: o.cancelReason,
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    confirmedAt: o.confirmedAt?.toISOString() ?? null,
    shippedAt: o.shippedAt?.toISOString() ?? null,
    deliveredAt: o.deliveredAt?.toISOString() ?? null,
    lines: lines.map((line) => ({
      id: line.id,
      variantId: line.variantId,
      sku: line.skuSnapshot,
      title: line.titleSnapshot,
      variantLabel: line.variantLabelSnapshot,
      imageUrl: line.imageUrlSnapshot,
      hsnCode: line.hsnSnapshot,
      quantity: line.quantity,
      fulfilledQty: line.fulfilledQty,
      returnedQty: line.returnedQty,
      unitPricePaise: line.unitPricePaise,
      lineDiscountPaise: line.lineDiscountPaise,
      allocatedOrderDiscountPaise: line.allocatedOrderDiscountPaise,
      grossPaise: line.grossPaise,
      gstRateBp: line.gstRateBp,
      taxablePaise: line.taxablePaise,
      cgstPaise: line.cgstPaise,
      sgstPaise: line.sgstPaise,
      igstPaise: line.igstPaise,
      cessPaise: line.cessPaise,
      fulfilmentStatus: line.fulfilmentStatus,
      addOns: (addOnsByLine.get(line.id) ?? []).map((a) => ({
        name: a.nameSnapshot,
        pricePaise: a.pricePaise,
        quantity: a.quantity,
        inputText: a.inputText,
      })),
      personalisation: personalisationByLine.get(line.id) ?? null,
    })),
    timeline: timeline.map((event) => ({
      occurredAt: event.occurredAt.toISOString(),
      eventType: event.eventType,
      label: event.label,
      note: event.note,
      actorKind: event.actorKind,
      actorStaffId: event.actorStaffId,
      actorLabel: event.actorLabel,
      metadata: event.metadata,
    })),
    payments: paymentRows.map((p) => ({
      id: p.id,
      gateway: p.gateway,
      method: p.method,
      status: p.status,
      amountPaise: p.amountPaise,
      gatewayPaymentId: p.gatewayPaymentId,
      capturedAt: p.capturedAt?.toISOString() ?? null,
      failureReason: p.failureReason,
    })),
    refunds: refundRows.map((r) => ({
      id: r.id,
      refundNo: r.refundNo,
      amountPaise: r.amountPaise,
      mode: r.mode,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    })),
    shipments: shipmentRows.map((s) => ({
      id: s.shipment.id,
      shipmentNo: s.shipment.shipmentNo,
      courierName: s.courierName,
      awb: s.shipment.awb,
      status: s.shipment.status,
      attempts: s.shipment.attempts,
      etaOn: s.shipment.etaOn,
      dispatchedAt: s.shipment.dispatchedAt?.toISOString() ?? null,
      deliveredAt: s.shipment.deliveredAt?.toISOString() ?? null,
    })),
    invoices: invoiceRows.map((i) => ({
      id: i.id,
      invoiceNo: i.invoiceNo,
      totalPaise: i.totalPaise,
      issuedAt: i.issuedAt.toISOString(),
      status: i.status,
    })),
    availableTransitions: availableTransitions(o.status, auth.permissions),
  };
}

const refundablePaise = (o: Pick<Order, 'amountPaidPaise' | 'amountRefundedPaise'>): number =>
  Math.max(0, o.amountPaidPaise - o.amountRefundedPaise);

/* ----------------------------------------------------------- transitions */

/** Timestamp columns that a particular arrival is supposed to stamp. */
function stampFor(to: OrderStatus, now: Date): Record<string, Date> {
  if (to === 'confirmed') return { confirmedAt: now };
  if (to === 'shipped') return { shippedAt: now };
  if (to === 'delivered') return { deliveredAt: now };
  return {};
}

export async function transitionOrder(
  orderId: string,
  input: { status: OrderStatus; note?: string | undefined; courierId?: string | undefined; awb?: string | undefined },
  auth: StaffAuth,
): Promise<AdminOrderDetailResponse> {
  // Cancellation and refund are transitions with real side effects — stock to
  // give back, a coupon redemption to return to the pool, a gateway to call.
  // Rather than a second implementation reachable through this endpoint, they
  // are routed to the one that does it properly.
  if (input.status === 'cancelled') {
    return cancelOrder(orderId, { reason: input.note ?? 'Cancelled by operations.', refund: true }, auth);
  }
  if (input.status === 'refund_initiated') {
    throw new UnprocessableError(
      'Start a refund through POST /v1/admin/orders/{orderId}/refund — it needs an amount, and it is ' +
        'gated on `orders:refund` plus a recent re-authentication.',
      'use_refund_endpoint',
    );
  }

  await db.transaction(async (tx) => {
    // Re-read under a row lock: the status fetched a moment ago may have moved
    // under a courier webhook while the operator was reading the screen.
    const order = await repo.lockOrder(tx, orderId);
    if (!order) throw new NotFoundError('Order', orderId);

    const edge = assertStaffTransition(order.status, input.status, auth.permissions, auth.role);

    const now = new Date();
    await repo.updateOrder(tx, order.id, { status: input.status, ...stampFor(input.status, now) });

    if (input.status === 'shipped') {
      await ensureShipment(tx, order, input.courierId, input.awb);
    }

    await repo.insertTimelineEvent(tx, {
      orderId: order.id,
      eventType: edge.eventType,
      label: edge.label,
      note: input.note ?? null,
      actorKind: 'staff',
      actorStaffId: auth.staffId,
      actorLabel: auth.role,
      metadata: { from: order.status, to: input.status },
    });
  });

  return getOrder(orderId, auth);
}

/**
 * A parcel cannot be "shipped" without something to ship it on.
 *
 * Reuses an open `label_created` shipment when one exists, so packing and
 * dispatch do not produce two rows for one parcel.
 */
async function ensureShipment(
  tx: Tx,
  order: Order,
  courierId: string | undefined,
  awb: string | undefined,
): Promise<void> {
  const open = await repo.findOpenShipment(order.id, tx);

  if (open) {
    if (courierId && !open.courierId) await repo.assignShipmentCourier(tx, open.id, courierId);
    return;
  }

  const warehouseId = order.fulfilmentWarehouseId ?? (await repo.defaultWarehouseId(tx));
  if (!warehouseId) {
    throw new UnprocessableError(
      'This order has no fulfilment warehouse and there is no default warehouse configured, so a ' +
        'shipment cannot be created.',
      'warehouse_unknown',
    );
  }

  const isCod = order.paymentStatus === 'cod_due';
  await repo.insertShipment(tx, {
    shipmentNo: `SHP-${ulid()}`,
    orderId: order.id,
    warehouseId,
    courierId: courierId ?? null,
    awb: awb ?? null,
    declaredValuePaise: order.totalPaise,
    isCod,
    codAmountPaise: isCod ? Math.max(0, order.totalPaise - order.amountPaidPaise) : 0,
    status: 'label_created',
  });
}

/* ---------------------------------------------------------------- cancel */

export async function cancelOrder(
  orderId: string,
  input: { reason: string; refund?: boolean },
  auth: StaffAuth,
): Promise<AdminOrderDetailResponse> {
  const required = permissionKey('orders', 'cancel');
  if (!auth.permissions.has(required)) {
    throw new ForbiddenError(`Your role (${auth.role}) does not have permission to cancel orders.`, {
      context: { required, role: auth.role },
    });
  }

  const outcome = await db.transaction(async (tx) => {
    const order = await repo.lockOrder(tx, orderId);
    if (!order) throw new NotFoundError('Order', orderId);

    assertStaffCancellable(order.status);

    // A paid order does NOT become `cancelled`. It becomes `refund_initiated`,
    // and only the gateway's confirmation makes it `refunded` — telling someone
    // their money is back before it is would be a lie.
    const target = staffCancellationTarget(order.paymentStatus);

    await repo.releaseReservations(tx, order.id);
    await repo.reverseCouponRedemption(tx, order.id, 'Order cancelled by operations.');

    // Only status and the cancellation columns change. The money columns are
    // untouched on purpose: the deferred check_order_totals() trigger fires on
    // any UPDATE of them, and a cancelled order must still reconcile against
    // its lines.
    await repo.updateOrder(tx, order.id, {
      status: target,
      cancelledAt: new Date(),
      cancelReason: input.reason,
    });

    await repo.insertTimelineEvent(tx, {
      orderId: order.id,
      eventType: 'order.cancelled',
      label: target === 'refund_initiated' ? 'Cancelled — refund initiated' : 'Cancelled',
      note: input.reason,
      actorKind: 'staff',
      actorStaffId: auth.staffId,
      actorLabel: auth.role,
      metadata: { from: order.status, to: target },
    });

    return { target, refundablePaise: refundablePaise(order) };
  });

  // Gateway I/O after commit: the cancellation must be durable even if Razorpay
  // is down. A refund that fails is retried by Finance rather than taking the
  // cancellation down with it.
  if (input.refund !== false && outcome.target === 'refund_initiated' && outcome.refundablePaise > 0) {
    try {
      await payments.refundOrder({
        orderId,
        amountPaise: outcome.refundablePaise,
        reason: `Order cancelled by operations: ${input.reason}`,
        approvedBy: auth.staffId,
      });
    } catch (err) {
      logger.error({ err, orderId }, 'order cancelled but the refund could not be initiated');
    }
  }

  return getOrder(orderId, auth);
}

/* ---------------------------------------------------------------- refund */

/**
 * The permission gate, as a pure function.
 *
 * `requirePermission('orders','refund')` on the route already enforces this —
 * this is the second lock, and it is the one a unit test can hold. Across the
 * eleven roles only Finance Manager and Super Admin carry `orders:refund`; a
 * Catalogue Manager has no `orders` grants at all, so this throws for them
 * whether or not the middleware ever ran.
 */
export function assertMayRefund(auth: Pick<StaffAuth, 'permissions' | 'role'>): void {
  const required = permissionKey('orders', 'refund');
  if (auth.permissions.has(required)) return;
  throw new ForbiddenError(
    `Your role (${auth.role}) does not have permission to refund orders. ` +
      'Only Finance Manager and Super Admin hold `orders:refund`.',
    { context: { required, role: auth.role } },
  );
}

export async function refund(
  orderId: string,
  input: { amountPaise: number; reason: string },
  auth: StaffAuth,
  idempotencyKey?: string | null,
): Promise<{
  refundId: string;
  refundNo: string;
  status: string;
  gatewayRefundId: string | null;
  amountPaise: number;
}> {
  assertMayRefund(auth);
  // Ten minutes of access-token life is a long time for an unattended laptop,
  // and a refund is irreversible.
  await assertStepUp(auth);

  const row = await repo.findOrder(orderId);
  if (!row) throw new NotFoundError('Order', orderId);

  // Delegated to the payments SERVICE, not to its repository: the refund cap,
  // the idempotency replay, the "write the row before calling the gateway"
  // ordering and the timeline entry all live there, once.
  const result = await payments.refundOrder({
    orderId,
    amountPaise: input.amountPaise,
    reason: input.reason,
    approvedBy: auth.staffId,
    idempotencyKey: idempotencyKey ?? null,
  });

  return { ...result, amountPaise: input.amountPaise };
}

/* ----------------------------------------------------------------- notes */

export async function addNote(orderId: string, note: string, auth: StaffAuth): Promise<{ note: string }> {
  await db.transaction(async (tx) => {
    const order = await repo.lockOrder(tx, orderId);
    if (!order) throw new NotFoundError('Order', orderId);

    const stamped = `[${new Date().toISOString()}] ${auth.role}: ${note}`;
    await repo.updateOrder(tx, order.id, {
      internalNotes: order.internalNotes ? `${order.internalNotes}\n${stamped}` : stamped,
    });

    // Also on the timeline, which is the append-only record. `internal_notes` is
    // a convenience column; the timeline is the one that cannot be edited.
    await repo.insertTimelineEvent(tx, {
      orderId: order.id,
      eventType: 'order.note_added',
      label: 'Internal note',
      note,
      actorKind: 'staff',
      actorStaffId: auth.staffId,
      actorLabel: auth.role,
    });
  });

  return { note };
}

/* -------------------------------------------------------------- invoices */

/**
 * Indian financial year, April to March. `2026-08-08` → `26-27`.
 *
 * Exported because it decides which statutory numbering series an invoice draws
 * from, and getting it wrong by a day at the start of April is a compliance
 * problem rather than a cosmetic one.
 */
export function financialYearOf(date: Date): string {
  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? year : year - 1;
  return `${String(startYear % 100).padStart(2, '0')}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

const addressOf = (o: Order): string =>
  [
    o.billSameAsShip ? o.buyerName : (o.billName ?? o.buyerName),
    o.billSameAsShip ? o.shipLine1 : (o.billLine1 ?? o.shipLine1),
    o.billSameAsShip ? o.shipCity : (o.billCity ?? o.shipCity),
    o.billSameAsShip ? o.shipPincode : (o.billPincode ?? o.shipPincode),
  ]
    .filter(Boolean)
    .join(', ');

/**
 * Issue the GST invoice for an order.
 *
 * Amounts are copied from the order's FROZEN tax columns rather than recomputed
 * — the rates were resolved when the order was placed and the catalogue has
 * moved on since. The total is built as `taxable + cgst + sgst + igst + cess +
 * round_off` rather than copied from `orders.total_paise`, because that is what
 * the `invoice_total_balances` CHECK asserts and the order header additionally
 * carries shipping and COD fees.
 *
 * Idempotent through `uq_invoice_per_order`: an order with an issued invoice
 * returns that one.
 */
export async function generateInvoice(
  orderId: string,
  auth: StaffAuth,
): Promise<{ id: string; invoiceNo: string; alreadyIssued: boolean }> {
  const existing = await repo.findIssuedInvoice(orderId);
  if (existing) return { id: existing.id, invoiceNo: existing.invoiceNo, alreadyIssued: true };

  return db.transaction(async (tx) => {
    const order = await repo.lockOrder(tx, orderId);
    if (!order) throw new NotFoundError('Order', orderId);

    if (order.status === 'pending_payment') {
      throw new UnprocessableError(
        'An invoice cannot be issued before the order is paid or confirmed.',
        'order_not_invoiceable',
        { context: { status: order.status } },
      );
    }

    // For an intrastate supply the supplier's state IS the place of supply, so
    // it is derivable. For an interstate one it is not, and guessing would put
    // the wrong registration on a statutory document.
    const supplierStateCode =
      order.supplierStateCode ?? (order.isInterstate ? null : order.placeOfSupplyStateCode);
    if (!supplierStateCode) {
      throw new UnprocessableError(
        'This order has no supplier state code and the supply is interstate, so the supplying GST ' +
          'registration cannot be determined. Set it on the order first.',
        'supplier_state_unknown',
      );
    }

    const issuedAt = new Date();
    const financialYear = financialYearOf(issuedAt);
    const numbering = await repo.nextInvoiceNumber(tx, financialYear);
    if (!numbering) {
      throw new UnprocessableError(
        `No active invoice numbering series is configured for financial year ${financialYear}. ` +
          'Add one to `document_number_series` before issuing invoices — a gap in a statutory series ' +
          'is not something to improvise.',
        'invoice_series_missing',
        { context: { financialYear } },
      );
    }

    const lines = await repo.findLines(orderId, tx);
    const missingHsn = lines.filter((l) => !l.hsnSnapshot);
    if (missingHsn.length > 0) {
      throw new UnprocessableError(
        `${missingHsn.length} line(s) have no HSN code. GSTR-1 needs an HSN-wise summary, so an ` +
          'invoice cannot be issued without one on every line.',
        'line_missing_hsn',
        { context: { skus: missingHsn.map((l) => l.skuSnapshot) } },
      );
    }

    const totalPaise =
      order.taxablePaise +
      order.cgstPaise +
      order.sgstPaise +
      order.igstPaise +
      order.cessPaise +
      order.roundOffPaise;

    const invoice = await repo.insertInvoice(tx, {
      invoiceNo: numbering.invoiceNo,
      seriesId: numbering.seriesId,
      orderId: order.id,
      supplierGstin: order.supplierGstin,
      supplierStateCode,
      buyerName: order.billSameAsShip ? order.buyerName : (order.billName ?? order.buyerName),
      buyerGstin: order.billGstin,
      buyerAddress: addressOf(order),
      placeOfSupplyStateCode: order.placeOfSupplyStateCode,
      taxablePaise: order.taxablePaise,
      cgstPaise: order.cgstPaise,
      sgstPaise: order.sgstPaise,
      igstPaise: order.igstPaise,
      cessPaise: order.cessPaise,
      roundOffPaise: order.roundOffPaise,
      totalPaise,
      issuedAt,
      financialYear,
      status: 'issued',
    });

    await repo.insertInvoiceLines(
      tx,
      lines.map((line, index) => ({
        invoiceId: invoice.id,
        orderLineId: line.id,
        description: [line.titleSnapshot, line.variantLabelSnapshot].filter(Boolean).join(' — '),
        hsnCode: line.hsnSnapshot ?? '',
        quantity: String(line.quantity),
        unit: 'PCS',
        unitPricePaise: line.unitPricePaise,
        discountPaise: line.lineDiscountPaise + line.allocatedOrderDiscountPaise,
        taxablePaise: line.taxablePaise,
        gstRateBp: line.gstRateBp,
        cgstPaise: line.cgstPaise,
        sgstPaise: line.sgstPaise,
        igstPaise: line.igstPaise,
        cessPaise: line.cessPaise,
        lineTotalPaise: line.grossPaise,
        position: index,
      })),
    );

    await repo.insertTimelineEvent(tx, {
      orderId: order.id,
      eventType: 'invoice.issued',
      label: `Invoice ${invoice.invoiceNo} issued`,
      actorKind: 'staff',
      actorStaffId: auth.staffId,
      actorLabel: auth.role,
      metadata: { invoiceNo: invoice.invoiceNo, totalPaise },
    });

    return { id: invoice.id, invoiceNo: invoice.invoiceNo, alreadyIssued: false };
  });
}

/* ------------------------------------------------------------ courier */

export async function assignCourier(
  orderId: string,
  courierId: string,
  auth: StaffAuth,
): Promise<{ shipmentId: string; shipmentNo: string }> {
  const courier = await repo.findCourier(courierId);
  if (!courier) throw new NotFoundError('Courier', courierId);

  return db.transaction(async (tx) => {
    const order = await repo.lockOrder(tx, orderId);
    if (!order) throw new NotFoundError('Order', orderId);

    const open = await repo.findOpenShipment(order.id, tx);
    if (open) {
      await repo.assignShipmentCourier(tx, open.id, courierId);
      await repo.insertTimelineEvent(tx, {
        orderId: order.id,
        eventType: 'shipment.courier_assigned',
        label: `Courier assigned: ${courier.name}`,
        actorKind: 'staff',
        actorStaffId: auth.staffId,
        actorLabel: auth.role,
        metadata: { shipmentNo: open.shipmentNo, courierId },
      });
      return { shipmentId: open.id, shipmentNo: open.shipmentNo };
    }

    await ensureShipment(tx, order, courierId, undefined);
    const created = await repo.findOpenShipment(order.id, tx);
    if (!created) throw new Error('shipment was created but could not be read back');

    await repo.insertTimelineEvent(tx, {
      orderId: order.id,
      eventType: 'shipment.courier_assigned',
      label: `Courier assigned: ${courier.name}`,
      actorKind: 'staff',
      actorStaffId: auth.staffId,
      actorLabel: auth.role,
      metadata: { shipmentNo: created.shipmentNo, courierId },
    });

    return { shipmentId: created.id, shipmentNo: created.shipmentNo };
  });
}

/* ------------------------------------------------------------------ bulk */

export type OrderBulkAction =
  | 'mark_packed'
  | 'mark_ready_to_ship'
  | 'generate_invoices'
  | 'assign_courier'
  | 'cancel';

/** The extra RBAC action each bulk action needs, on top of the route's `orders:edit`. */
export const BULK_ACTION_REQUIREMENTS = {
  mark_packed: 'edit',
  mark_ready_to_ship: 'edit',
  generate_invoices: 'edit',
  assign_courier: 'edit',
  cancel: 'cancel',
} as const satisfies Record<OrderBulkAction, string>;

const errorOf = (err: unknown): { code: string; message: string } => {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return { code: String((err as { code: unknown }).code), message: String((err as { message: unknown }).message) };
  }
  return { code: 'unknown_error', message: err instanceof Error ? err.message : 'Something went wrong.' };
};

export async function runBulk(
  input: { action: OrderBulkAction; orderIds: string[]; courierId?: string | undefined; reason?: string | undefined },
  auth: StaffAuth,
): Promise<OrderBulkResultResponse> {
  const required = permissionKey('orders', BULK_ACTION_REQUIREMENTS[input.action]);
  if (!auth.permissions.has(required)) {
    throw new ForbiddenError(
      `Your role (${auth.role}) cannot perform “${input.action}” on orders — it needs \`${required}\`.`,
      { context: { required, role: auth.role, action: input.action } },
    );
  }

  if (input.action === 'assign_courier' && !input.courierId) {
    throw new BadRequestError('`courierId` is required for `assign_courier`.');
  }
  if (input.action === 'cancel' && !input.reason) {
    throw new BadRequestError('`reason` is required for `cancel` — the database refuses one without it.');
  }

  const succeeded: string[] = [];
  const failed: OrderBulkResultResponse['failed'] = [];

  // Sequential on purpose. These take row locks on orders and inventory levels;
  // firing fifty in parallel converts a queue into a deadlock.
  for (const orderId of input.orderIds) {
    try {
      switch (input.action) {
        case 'mark_packed':
          await transitionOrder(orderId, { status: 'packed' }, auth);
          break;
        case 'mark_ready_to_ship':
          await transitionOrder(orderId, { status: 'ready_to_ship' }, auth);
          break;
        case 'generate_invoices':
          await generateInvoice(orderId, auth);
          break;
        case 'assign_courier':
          await assignCourier(orderId, input.courierId ?? '', auth);
          break;
        case 'cancel':
          await cancelOrder(orderId, { reason: input.reason ?? '', refund: true }, auth);
          break;
      }
      succeeded.push(orderId);
    } catch (err) {
      const { code, message } = errorOf(err);
      logger.warn({ err, orderId, action: input.action }, 'bulk order action failed for one order');
      failed.push({ orderId, code, message });
    }
  }

  return { action: input.action, requested: input.orderIds.length, succeeded, failed };
}
