/**
 * The inbound gateway event log. No business rules, no HTTP.
 *
 * `payment_events` is the idempotency boundary for every webhook this API
 * receives, and `UNIQUE (gateway, gateway_event_id)` is what makes it one. The
 * INSERT *is* the claim: exactly one caller can create the row, and everyone
 * else finds it already there.
 */

import { and, eq } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import { paymentEvents, type PaymentEvent } from '../../db/schema/index.js';

export type EventClaim = { id: bigint; alreadyProcessed: boolean };

/**
 * Claim an event for processing.
 *
 * Returns the row id plus whether a previous delivery already finished with it.
 * The distinction matters: a replay of a *processed* event must do nothing,
 * while a replay of an event whose processing crashed must be allowed to run
 * again — otherwise the first failure silently becomes permanent, since Razorpay
 * would keep resending an id we already recorded.
 */
export async function claimEvent(
  input: {
    gateway: string;
    gatewayEventId: string;
    eventType: string;
    signatureValid: boolean;
    payload: unknown;
  },
  exec: Executor = db,
): Promise<EventClaim> {
  const inserted = await exec
    .insert(paymentEvents)
    .values({
      gateway: input.gateway,
      gatewayEventId: input.gatewayEventId,
      eventType: input.eventType,
      signatureValid: input.signatureValid,
      payload: input.payload,
    })
    .onConflictDoNothing({ target: [paymentEvents.gateway, paymentEvents.gatewayEventId] })
    .returning({ id: paymentEvents.id });

  const row = inserted[0];
  if (row) return { id: row.id, alreadyProcessed: false };

  const existing = await findEvent(input.gateway, input.gatewayEventId, exec);
  if (!existing) {
    // Vanishingly unlikely: the conflicting row was created and removed between
    // the two statements. Treat it as processed rather than looping.
    return { id: 0n, alreadyProcessed: true };
  }
  return { id: existing.id, alreadyProcessed: existing.processedAt !== null };
}

export async function findEvent(
  gateway: string,
  gatewayEventId: string,
  exec: Executor = db,
): Promise<PaymentEvent | null> {
  const rows = await exec
    .select()
    .from(paymentEvents)
    .where(and(eq(paymentEvents.gateway, gateway), eq(paymentEvents.gatewayEventId, gatewayEventId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function markProcessed(
  eventId: bigint,
  outcome: { orderId?: string | null; paymentId?: string | null },
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(paymentEvents)
    .set({
      processedAt: new Date(),
      processError: null,
      ...(outcome.orderId ? { orderId: outcome.orderId } : {}),
      ...(outcome.paymentId ? { paymentId: outcome.paymentId } : {}),
    })
    .where(eq(paymentEvents.id, eventId));
}

/**
 * Record the failure but leave `processed_at` NULL, so the next delivery of the
 * same event re-runs it and `idx_payment_events_unprocessed` can find it.
 */
export async function markFailed(eventId: bigint, error: string, exec: Executor = db): Promise<void> {
  await exec
    .update(paymentEvents)
    .set({ processError: error.slice(0, 2000) })
    .where(eq(paymentEvents.id, eventId));
}
