/**
 * Payments: session creation, checkout verification, capture/failure/refund
 * application, and the refund service the admin module will call.
 *
 * The rule that shapes this whole file: **the browser never decides that an
 * order is paid.** `verifyCheckoutHandback` proves the success callback is
 * authentic, and then refetches the payment from Razorpay to find out what
 * actually happened. The webhook is the source of truth and reaches
 * `applyPaymentCaptured` by the same path, so whichever arrives first wins and
 * the second is a no-op.
 *
 * Every `apply*` function is idempotent by construction:
 *   - the capture is keyed on `(gateway, gateway_payment_id)`, which is UNIQUE;
 *   - the order row is locked BEFORE the re-check, so a webhook and a handback
 *     racing on the same payment serialise instead of double-crediting;
 *   - the refund is keyed on `gateway_refund_id`.
 */

import { db, type Tx } from '../../config/db.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import * as repo from './payments.repository.js';
import {
  createGatewayOrder,
  createGatewayRefund,
  fetchGatewayPayment,
  toPaymentMethod,
  verifyCheckoutSignature,
} from './payments.razorpay.js';
import type { PaymentResultResponse, PaymentSessionResponse } from './payments.schemas.js';
import type { OrderStatus } from '../../db/schema/index.js';

export type ApplyOutcome = {
  orderId: string | null;
  paymentId: string | null;
  /** False when this call changed nothing — a replay, or an event about an unknown order. */
  changed: boolean;
  /**
   * Set when the event was AUTHENTIC but could not be applied yet or at all — a
   * refund for a payment this system has not recorded, a capture for a gateway
   * order it never created, an amount that is not a positive integer.
   *
   * The webhook module leaves such an event `processed_at` NULL so it stays in
   * `idx_payment_events_unprocessed` for reconciliation. Marking it processed
   * would close it forever: an out-of-order `refund.processed` would then be
   * money that left the account with no ledger row anywhere.
   */
  deferred?: string;
};

const UNPAYABLE_STATUSES: readonly string[] = ['cancelled', 'refund_initiated', 'refunded', 'rto'];

/* ------------------------------------------------------------ money guards */

/**
 * Whether a captured amount may be applied to an order's ledger, and whether it
 * is the amount this API asked Razorpay to collect.
 *
 * `expectedPaise` is the amount on the payment session row. A mismatch is NOT
 * fatal — the money genuinely moved, so refusing to record it would be worse
 * than recording it — but it is an accounting anomaly that must be shouted
 * about rather than absorbed silently. A non-positive or non-integer amount, by
 * contrast, can never be applied: it is a mangled payload, and `payments`
 * carries a `amount_paise > 0` CHECK that would abort the whole delivery.
 */
export function captureAmountIssue(
  amountPaise: number,
  expectedPaise: number | null,
): { fatal: string | null; mismatch: string | null } {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    return {
      fatal:
        `Razorpay reported a captured amount of ${String(amountPaise)}, which is not a positive integer ` +
        'number of paise. Nothing was applied to the order.',
      mismatch: null,
    };
  }
  if (expectedPaise !== null && expectedPaise > 0 && amountPaise !== expectedPaise) {
    return {
      fatal: null,
      mismatch:
        `Razorpay captured ${amountPaise} paise but this order asked it to collect ${expectedPaise} paise.`,
    };
  }
  return { fatal: null, mismatch: null };
}

/**
 * What may still be refunded on an order.
 *
 * `orders.amount_refunded_paise` only moves when the gateway CONFIRMS a refund,
 * which can be minutes later — so comparing against it alone lets a second
 * refund be initiated for money that is already on its way back. The refunds
 * table is the real ledger: every row in `initiated`, `processing` or
 * `completed` is money committed. Taking the larger of the two is what makes
 * "refund twice quickly" impossible rather than merely unlikely.
 */
export function refundableAfterOpen(
  order: { amountPaidPaise: number; amountRefundedPaise: number },
  openRefundsPaise: number,
): number {
  const committed = Math.max(order.amountRefundedPaise, openRefundsPaise);
  return Math.max(0, order.amountPaidPaise - committed);
}

/* ---------------------------------------------------------------- sessions */

/**
 * Create (or reuse) the Razorpay order the browser hands to Checkout.js.
 *
 * The amount is the order's OUTSTANDING balance read from the database, so a
 * client cannot ask to pay less. Reused when an unconsumed session for the same
 * amount already exists, which makes a double-tap on "Pay now" free.
 */
export async function createPaymentSession(
  orderId: string,
  customerId?: string | null,
): Promise<PaymentSessionResponse> {
  const order = await repo.findOrderForPayment(orderId);
  if (!order) throw new NotFoundError('Order', orderId);
  if (customerId && order.customerId !== customerId) throw new NotFoundError('Order', orderId);

  if (UNPAYABLE_STATUSES.includes(order.status)) {
    throw new UnprocessableError('This order can no longer be paid for.', 'order_not_payable');
  }
  if (order.paymentStatus === 'paid') {
    throw new UnprocessableError('This order has already been paid.', 'order_already_paid');
  }

  const duePaise = order.totalPaise - order.amountPaidPaise;
  if (duePaise <= 0) {
    throw new UnprocessableError('There is nothing left to pay on this order.', 'order_already_paid');
  }

  const open = await repo.findOpenSession(order.id);
  if (open?.gatewayOrderId && open.amountPaise === duePaise) {
    return {
      gateway: 'razorpay',
      keyId: env.RAZORPAY_KEY_ID,
      razorpayOrderId: open.gatewayOrderId,
      amountPaise: duePaise,
      currency: order.currency,
    };
  }

  const gatewayOrder = await createGatewayOrder({
    amountPaise: duePaise,
    currency: order.currency,
    receipt: order.orderNo,
    notes: { orderId: order.id, orderNo: order.orderNo },
  });

  await repo.insertPayment({
    orderId: order.id,
    gateway: 'razorpay',
    // The real instrument is unknown until the customer picks one at Checkout;
    // `payments.method` is NOT NULL with a CHECK, so it is provisional here and
    // corrected from the gateway's own record when the capture is applied.
    method: 'upi',
    gatewayOrderId: gatewayOrder.id,
    amountPaise: duePaise,
    currency: order.currency,
    status: 'created',
  });

  return {
    gateway: 'razorpay',
    keyId: env.RAZORPAY_KEY_ID,
    razorpayOrderId: gatewayOrder.id,
    amountPaise: duePaise,
    currency: order.currency,
  };
}

/* ------------------------------------------------------------ verification */

/**
 * The Checkout.js hand-back.
 *
 * The signature proves the three identifiers came from Razorpay and were not
 * assembled by whoever is driving the browser. It does NOT prove the money moved
 * — so the payment is refetched from the gateway and only a `captured` status
 * counts. Skipping that refetch is the classic Razorpay integration bug: a valid
 * signature over an `authorized`-but-never-captured payment marks the order paid.
 */
export async function verifyCheckoutHandback(
  input: {
    orderId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  },
  customerId: string,
): Promise<PaymentResultResponse> {
  const order = await repo.findOrderForPayment(input.orderId);
  if (!order || order.customerId !== customerId) throw new NotFoundError('Order', input.orderId);

  const signatureOk = verifyCheckoutSignature(
    {
      razorpayOrderId: input.razorpayOrderId,
      razorpayPaymentId: input.razorpayPaymentId,
      signature: input.razorpaySignature,
    },
    env.RAZORPAY_KEY_SECRET,
  );
  if (!signatureOk) {
    logger.warn(
      { orderId: input.orderId, razorpayPaymentId: input.razorpayPaymentId },
      'razorpay checkout signature verification failed',
    );
    throw new UnprocessableError('The payment signature could not be verified.', 'signature_invalid');
  }

  const session = await repo.findPaymentByGatewayOrderId(input.razorpayOrderId);
  if (!session || session.orderId !== order.id) {
    throw new UnprocessableError(
      'That Razorpay order does not belong to this order.',
      'payment_order_mismatch',
    );
  }

  const gatewayPayment = await fetchGatewayPayment(input.razorpayPaymentId);

  // The signature already binds order id to payment id, so this can only fail if
  // something upstream is very wrong — but the cost of being wrong here is
  // crediting one customer's order with another's payment, so it is checked
  // against the gateway's own record rather than assumed.
  if (gatewayPayment.orderId && gatewayPayment.orderId !== input.razorpayOrderId) {
    logger.error(
      {
        orderId: input.orderId,
        claimedRazorpayOrderId: input.razorpayOrderId,
        actualRazorpayOrderId: gatewayPayment.orderId,
      },
      'razorpay payment belongs to a different gateway order than the signature claimed',
    );
    throw new UnprocessableError(
      'That payment belongs to a different Razorpay order.',
      'payment_order_mismatch',
    );
  }

  if (gatewayPayment.status !== 'captured') {
    throw new UnprocessableError(
      `The payment is ${gatewayPayment.status}, not captured. If you were charged, it will be confirmed shortly.`,
      'payment_not_captured',
    );
  }

  await applyPaymentCaptured({
    gatewayPaymentId: gatewayPayment.id,
    gatewayOrderId: gatewayPayment.orderId ?? input.razorpayOrderId,
    amountPaise: gatewayPayment.amountPaise,
    method: gatewayPayment.method,
    signature: input.razorpaySignature,
    raw: gatewayPayment,
  });

  const fresh = await repo.findOrderForPayment(order.id);
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    status: fresh?.status ?? order.status,
    paymentStatus: fresh?.paymentStatus ?? order.paymentStatus,
    amountPaidPaise: fresh?.amountPaidPaise ?? order.amountPaidPaise,
    totalPaise: order.totalPaise,
    gatewayPaymentId: gatewayPayment.id,
  };
}

/* ------------------------------------------------------- applying outcomes */

export async function applyPaymentCaptured(input: {
  gatewayPaymentId: string;
  gatewayOrderId: string | null;
  amountPaise: number;
  method: string | null;
  signature?: string | null;
  raw: unknown;
}): Promise<ApplyOutcome> {
  const known = await repo.findPaymentByGatewayPaymentId(input.gatewayPaymentId);
  if (known?.status === 'captured') {
    return { orderId: known.orderId, paymentId: known.id, changed: false };
  }

  const session =
    known ?? (input.gatewayOrderId ? await repo.findPaymentByGatewayOrderId(input.gatewayOrderId) : null);

  if (!session) {
    // A capture for a gateway order this system never created. The delivery is
    // still answered 2xx so Razorpay stops retrying, but the event is left
    // UNPROCESSED: money reached the merchant account that no order here claims,
    // and that has to end up in front of a human rather than in a log line.
    const reason = `Capture for gateway order ${String(input.gatewayOrderId)}, which this system never created.`;
    logger.error({ gatewayOrderId: input.gatewayOrderId }, 'razorpay capture for an unknown gateway order');
    return { orderId: null, paymentId: null, changed: false, deferred: reason };
  }

  // The session amount is what this API asked Razorpay to collect. Reconciling
  // the capture against it is the only server-side check that a gateway callback
  // is claiming the amount the order actually costs.
  const amountCheck = captureAmountIssue(input.amountPaise, session.amountPaise);
  if (amountCheck.fatal) {
    logger.error(
      { gatewayPaymentId: input.gatewayPaymentId, amountPaise: input.amountPaise },
      'razorpay capture carried an unusable amount',
    );
    return { orderId: session.orderId, paymentId: null, changed: false, deferred: amountCheck.fatal };
  }
  if (amountCheck.mismatch) {
    logger.error(
      {
        gatewayPaymentId: input.gatewayPaymentId,
        capturedPaise: input.amountPaise,
        expectedPaise: session.amountPaise,
        orderId: session.orderId,
      },
      'razorpay captured an amount this order did not ask for',
    );
  }

  return db.transaction(async (tx) => {
    // Lock the order FIRST. A concurrent webhook and checkout hand-back for the
    // same payment both arrive here; the loser blocks, and only then re-reads —
    // at which point the winner's capture is visible and it does nothing.
    const order = await repo.lockOrder(tx, session.orderId);
    if (!order) return { orderId: null, paymentId: null, changed: false };

    const fresh = await repo.findPaymentByGatewayPaymentId(input.gatewayPaymentId, tx);
    if (fresh?.status === 'captured') {
      return { orderId: order.id, paymentId: fresh.id, changed: false };
    }

    const capturedAt = new Date();
    let paymentId: string;

    if (fresh) {
      await repo.updatePayment(tx, fresh.id, {
        status: 'captured',
        method: toPaymentMethod(input.method),
        amountPaise: input.amountPaise,
        capturedAt,
        gatewaySignature: input.signature ?? null,
        rawPayload: input.raw,
      });
      paymentId = fresh.id;
    } else if (session.gatewayPaymentId === null) {
      await repo.updatePayment(tx, session.id, {
        gatewayPaymentId: input.gatewayPaymentId,
        status: 'captured',
        method: toPaymentMethod(input.method),
        amountPaise: input.amountPaise,
        capturedAt,
        gatewaySignature: input.signature ?? null,
        rawPayload: input.raw,
      });
      paymentId = session.id;
    } else {
      const inserted = await repo.insertPayment(
        {
          orderId: order.id,
          gateway: 'razorpay',
          method: toPaymentMethod(input.method),
          gatewayPaymentId: input.gatewayPaymentId,
          gatewayOrderId: input.gatewayOrderId,
          amountPaise: input.amountPaise,
          currency: order.currency,
          status: 'captured',
          capturedAt,
          rawPayload: input.raw,
        },
        tx,
      );
      paymentId = inserted.id;
    }

    const amountPaidPaise = order.amountPaidPaise + input.amountPaise;
    const fullyPaid = amountPaidPaise >= order.totalPaise;
    const status: OrderStatus = order.status === 'pending_payment' && fullyPaid ? 'paid' : order.status;

    await repo.updateOrderPaymentState(tx, order.id, {
      amountPaidPaise,
      paymentStatus: fullyPaid ? 'paid' : 'pending',
      status,
    });

    await repo.insertTimelineEvent(tx, {
      orderId: order.id,
      eventType: 'payment.captured',
      label: 'Payment captured',
      actorKind: 'gateway',
      actorLabel: 'Razorpay',
      metadata: { gatewayPaymentId: input.gatewayPaymentId, amountPaise: input.amountPaise },
    });

    return { orderId: order.id, paymentId, changed: true };
  });
}

export async function applyPaymentFailed(input: {
  gatewayPaymentId: string;
  gatewayOrderId: string | null;
  method: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  raw: unknown;
}): Promise<ApplyOutcome> {
  const known = await repo.findPaymentByGatewayPaymentId(input.gatewayPaymentId);
  if (known?.status === 'failed' || known?.status === 'captured') {
    return { orderId: known.orderId, paymentId: known.id, changed: false };
  }

  const session =
    known ?? (input.gatewayOrderId ? await repo.findPaymentByGatewayOrderId(input.gatewayOrderId) : null);
  if (!session) return { orderId: null, paymentId: null, changed: false };

  // The CHECK `payment_failed_has_reason` requires one, and "unknown" is a worse
  // record than the gateway's own wording.
  const failureReason = input.errorDescription ?? input.errorCode ?? 'Payment failed at the gateway.';

  return db.transaction(async (tx) => {
    const order = await repo.lockOrder(tx, session.orderId);
    if (!order) return { orderId: null, paymentId: null, changed: false };

    const fresh = await repo.findPaymentByGatewayPaymentId(input.gatewayPaymentId, tx);
    if (fresh && fresh.status !== 'created') {
      return { orderId: order.id, paymentId: fresh.id, changed: false };
    }

    const target = fresh ?? session;
    await repo.updatePayment(tx, target.id, {
      gatewayPaymentId: input.gatewayPaymentId,
      status: 'failed',
      method: toPaymentMethod(input.method),
      failureCode: input.errorCode,
      failureReason,
      rawPayload: input.raw,
    });

    // A failed attempt does not cancel the order — the customer may simply retry
    // with another instrument. It only marks the payment state, and only while
    // nothing has actually been captured.
    if (order.amountPaidPaise === 0 && order.paymentStatus === 'pending') {
      await repo.updateOrderPaymentState(tx, order.id, { paymentStatus: 'failed' });
    }

    await repo.insertTimelineEvent(tx, {
      orderId: order.id,
      eventType: 'payment.failed',
      label: 'Payment failed',
      note: failureReason,
      actorKind: 'gateway',
      actorLabel: 'Razorpay',
      metadata: { gatewayPaymentId: input.gatewayPaymentId, errorCode: input.errorCode },
    });

    return { orderId: order.id, paymentId: target.id, changed: true };
  });
}

/* ----------------------------------------------------------------- refunds */

/**
 * Start a refund. Called by customer cancellation and, later, by the admin
 * module — which is why it takes an approver and an idempotency key rather than
 * reading either from a request.
 *
 * The row is written and committed BEFORE the gateway is called, so a refund
 * that Razorpay accepted but whose response was lost is still on the books and
 * reconcilable, instead of vanishing with the HTTP connection.
 */
export async function refundOrder(input: {
  orderId: string;
  amountPaise: number;
  reason: string;
  approvedBy?: string | null;
  idempotencyKey?: string | null;
}): Promise<{ refundId: string; refundNo: string; status: string; gatewayRefundId: string | null }> {
  if (input.amountPaise <= 0) {
    throw new UnprocessableError('A refund amount must be positive.', 'invalid_refund_amount');
  }

  if (input.idempotencyKey) {
    const replay = await repo.findRefundByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return {
        refundId: replay.id,
        refundNo: replay.refundNo,
        status: replay.status,
        gatewayRefundId: replay.gatewayRefundId,
      };
    }
  }

  const order = await repo.findOrderForPayment(input.orderId);
  if (!order) throw new NotFoundError('Order', input.orderId);

  const captured = await repo.findCapturedPayment(order.id);

  /*
   * The cap is enforced INSIDE the transaction, after the order row is locked.
   *
   * Computing it beforehand was a double-refund waiting to happen in two
   * different ways: two concurrent requests both read the same
   * `amount_refunded_paise` and both pass, and — worse, because it needs no
   * concurrency at all — a customer cancellation followed by an ops refund both
   * pass, because `amount_refunded_paise` does not move until the gateway
   * confirms, which is minutes away. Neither call site supplies an idempotency
   * key, so nothing else was stopping it.
   */
  const outcome = await db.transaction(async (tx) => {
    const locked = await repo.lockOrder(tx, order.id);
    if (!locked) throw new NotFoundError('Order', input.orderId);

    // Re-checked under the lock so two concurrent calls with the SAME key
    // serialise into one refund and one replayed answer, rather than racing to a
    // unique-violation on `refunds.idempotency_key`.
    if (input.idempotencyKey) {
      const replay = await repo.findRefundByIdempotencyKey(input.idempotencyKey, tx);
      if (replay) return { row: replay, replayed: true as const };
    }

    const openRefundsPaise = await repo.sumCommittedRefundsPaise(order.id, tx);
    const refundable = refundableAfterOpen(locked, openRefundsPaise);
    if (input.amountPaise > refundable) {
      throw new UnprocessableError(
        `Only ${refundable} paise can still be refunded on this order.`,
        'refund_exceeds_captured',
        {
          context: {
            refundablePaise: refundable,
            requestedPaise: input.amountPaise,
            alreadyCommittedPaise: openRefundsPaise,
          },
        },
      );
    }

    const refundNo = await repo.nextRefundNumber(tx, new Date().getFullYear());
    const row = await repo.insertRefund(tx, {
      refundNo,
      orderId: order.id,
      paymentId: captured?.id ?? null,
      amountPaise: input.amountPaise,
      // No gateway capture to reverse (a COD order, or a manual payment) means the
      // money has to go back another way; ops completes it and stamps the row.
      mode: captured ? 'original' : 'bank_transfer',
      status: 'initiated',
      reason: input.reason,
      approvedBy: input.approvedBy ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    if (locked.status !== 'refund_initiated' && locked.status !== 'refunded') {
      await repo.updateOrderPaymentState(tx, order.id, { status: 'refund_initiated' });
    }

    await repo.insertTimelineEvent(tx, {
      orderId: order.id,
      eventType: 'refund.initiated',
      label: `Refund initiated (${refundNo})`,
      note: input.reason,
      actorKind: input.approvedBy ? 'staff' : 'system',
      ...(input.approvedBy ? { actorStaffId: input.approvedBy } : {}),
      metadata: { amountPaise: input.amountPaise },
    });

    return { row, replayed: false as const };
  });

  const refund = outcome.row;

  // The winner of an idempotency race already called the gateway (or decided not
  // to). Calling it again with the same refund row is exactly the double refund
  // the key exists to prevent.
  if (outcome.replayed) {
    return {
      refundId: refund.id,
      refundNo: refund.refundNo,
      status: refund.status,
      gatewayRefundId: refund.gatewayRefundId,
    };
  }

  if (!captured?.gatewayPaymentId) {
    return { refundId: refund.id, refundNo: refund.refundNo, status: refund.status, gatewayRefundId: null };
  }

  try {
    const gatewayRefund = await createGatewayRefund({
      paymentId: captured.gatewayPaymentId,
      amountPaise: input.amountPaise,
      notes: { orderId: order.id, orderNo: order.orderNo, refundNo: refund.refundNo },
    });
    await repo.updateRefund(db, refund.id, {
      gatewayRefundId: gatewayRefund.id,
      status: 'processing',
    });
    return {
      refundId: refund.id,
      refundNo: refund.refundNo,
      status: 'processing',
      gatewayRefundId: gatewayRefund.id,
    };
  } catch (err) {
    await repo.updateRefund(db, refund.id, { status: 'failed' });
    logger.error({ err, orderId: order.id, refundNo: refund.refundNo }, 'gateway refund failed');
    throw err;
  }
}

/**
 * Gateway confirmation. Only this moves money on the order — `refund_initiated`
 * becomes `refunded` here and nowhere else.
 */
export async function applyRefundProcessed(input: {
  gatewayRefundId: string;
  gatewayPaymentId: string;
  amountPaise: number;
  raw: unknown;
}): Promise<ApplyOutcome> {
  const payment = await repo.findPaymentByGatewayPaymentId(input.gatewayPaymentId);
  if (!payment) {
    // Out-of-order delivery: `refund.processed` overtook the `payment.captured`
    // that would have created the row. Money has LEFT the account, so this event
    // must not be closed — it is deferred, stays unprocessed, and is replayable
    // once the capture lands.
    const reason =
      `Refund ${input.gatewayRefundId} references payment ${input.gatewayPaymentId}, which this system ` +
      'has not recorded yet. Left unprocessed for reconciliation.';
    logger.error({ gatewayPaymentId: input.gatewayPaymentId }, 'refund event for an unknown payment');
    return { orderId: null, paymentId: null, changed: false, deferred: reason };
  }

  const existing = await repo.findRefundByGatewayId(input.gatewayRefundId);
  if (existing?.status === 'completed') {
    return { orderId: existing.orderId, paymentId: payment.id, changed: false };
  }

  return db.transaction(async (tx) => {
    const order = await repo.lockOrder(tx, payment.orderId);
    if (!order) return { orderId: null, paymentId: payment.id, changed: false };

    const fresh = await repo.findRefundByGatewayId(input.gatewayRefundId, tx);
    if (fresh?.status === 'completed') {
      return { orderId: order.id, paymentId: payment.id, changed: false };
    }

    const completedAt = new Date();
    if (fresh) {
      await repo.updateRefund(tx, fresh.id, { status: 'completed', completedAt });
    } else {
      // Refunded straight from the Razorpay dashboard: the ledger still has to
      // show it, so the row is created here rather than the event being dropped.
      const refundNo = await repo.nextRefundNumber(tx, completedAt.getFullYear());
      await repo.insertRefund(tx, {
        refundNo,
        orderId: order.id,
        paymentId: payment.id,
        amountPaise: input.amountPaise,
        mode: 'original',
        status: 'completed',
        reason: 'Refunded at the gateway.',
        gatewayRefundId: input.gatewayRefundId,
        completedAt,
      });
    }

    const amountRefundedPaise = Math.min(
      order.amountPaidPaise,
      order.amountRefundedPaise + input.amountPaise,
    );
    const fully = amountRefundedPaise >= order.amountPaidPaise && order.amountPaidPaise > 0;

    await repo.updateOrderPaymentState(tx, order.id, {
      amountRefundedPaise,
      paymentStatus: fully ? 'refunded' : 'partially_refunded',
      ...(fully && (order.status === 'refund_initiated' || order.status === 'cancelled')
        ? { status: 'refunded' }
        : {}),
    });

    await repo.insertTimelineEvent(tx, {
      orderId: order.id,
      eventType: 'refund.processed',
      label: 'Refund processed',
      actorKind: 'gateway',
      actorLabel: 'Razorpay',
      metadata: { gatewayRefundId: input.gatewayRefundId, amountPaise: input.amountPaise },
    });

    return { orderId: order.id, paymentId: payment.id, changed: true };
  });
}

export async function applyRefundFailed(input: {
  gatewayRefundId: string;
  raw: unknown;
}): Promise<ApplyOutcome> {
  const existing = await repo.findRefundByGatewayId(input.gatewayRefundId);
  if (!existing) {
    // A refund this system never initiated failed at the gateway. Nothing to
    // update, but it is left unprocessed rather than closed — someone refunded
    // from the dashboard and it did not go through.
    return {
      orderId: null,
      paymentId: null,
      changed: false,
      deferred: `Refund ${input.gatewayRefundId} failed at the gateway but has no row here.`,
    };
  }
  if (existing.status === 'failed' || existing.status === 'completed') {
    return { orderId: existing.orderId, paymentId: null, changed: false };
  }
  await repo.updateRefund(db, existing.id, { status: 'failed' });
  return { orderId: existing.orderId, paymentId: existing.paymentId, changed: true };
}

/** Exposed so the webhook module can record which order an event belonged to. */
export async function findOrderIdForGatewayOrder(gatewayOrderId: string | null): Promise<string | null> {
  if (!gatewayOrderId) return null;
  const session = await repo.findPaymentByGatewayOrderId(gatewayOrderId);
  return session?.orderId ?? null;
}

/** Type re-export so the webhook module never has to touch `config/db`. */
export type PaymentsTx = Tx;
