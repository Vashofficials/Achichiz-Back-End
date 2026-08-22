/**
 * Drizzle queries for authentication. No business rules, no HTTP.
 *
 * Two things worth knowing before reading:
 *
 *  - `customers.email` is **CITEXT** in the database (declared `text()` in
 *    Drizzle because Drizzle has no CITEXT type). `eq(customers.email, value)` is
 *    therefore already case-insensitive, and wrapping it in `lower()` would
 *    defeat `uq_customers_email`. See `db/schema/README.md`.
 *  - Every customer lookup filters `deleted_at IS NULL`. The uniqueness indexes
 *    are partial on the same predicate (§7 correction 2), so a soft-deleted row
 *    can legitimately share an email with a live one — a lookup that forgets the
 *    filter can authenticate a deleted account.
 */

import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import {
  customerSessions,
  customers,
  otpChallenges,
  type OtpChannel,
  type OtpPurpose,
} from '../../db/schema/index.js';

/* ------------------------------------------------------------------ types */

export type CustomerRow = typeof customers.$inferSelect;
export type SessionRow = typeof customerSessions.$inferSelect;
export type OtpChallengeRow = typeof otpChallenges.$inferSelect;

/* -------------------------------------------------------------- customers */

const live = isNull(customers.deletedAt);

export async function findCustomerByEmail(
  emailAddress: string,
  exec: Executor = db,
): Promise<CustomerRow | null> {
  const rows = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.email, emailAddress), live))
    .limit(1);
  return rows[0] ?? null;
}

export async function findCustomerByMobile(
  mobile: string,
  exec: Executor = db,
): Promise<CustomerRow | null> {
  const rows = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.mobile, mobile), live))
    .limit(1);
  return rows[0] ?? null;
}

export async function findCustomerById(
  customerId: string,
  exec: Executor = db,
): Promise<CustomerRow | null> {
  const rows = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), live))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertCustomer(
  values: typeof customers.$inferInsert,
  exec: Executor = db,
): Promise<CustomerRow> {
  const rows = await exec.insert(customers).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('customer insert returned no row');
  return row;
}

export async function updateCustomer(
  customerId: string,
  patch: Partial<typeof customers.$inferInsert>,
  exec: Executor = db,
): Promise<CustomerRow | null> {
  const rows = await exec
    .update(customers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(customers.id, customerId))
    .returning();
  return rows[0] ?? null;
}

/* --------------------------------------------------------------- sessions */

export async function insertSession(
  values: {
    customerId: string;
    refreshTokenHash: string;
    deviceLabel: string | null;
    ip: string | null;
    expiresAt: Date;
  },
  exec: Executor = db,
): Promise<SessionRow> {
  const rows = await exec.insert(customerSessions).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('customer session insert returned no row');
  return row;
}

export async function findSessionByHash(
  refreshTokenHash: string,
  exec: Executor = db,
): Promise<SessionRow | null> {
  const rows = await exec
    .select()
    .from(customerSessions)
    .where(eq(customerSessions.refreshTokenHash, refreshTokenHash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Rotation, as one conditional UPDATE.
 *
 * The `revoked_at IS NULL AND refresh_token_hash = <old>` predicate is what makes
 * two simultaneous refreshes with the same token safe: exactly one of them
 * matches a row and rotates, the other updates nothing and gets `false` back —
 * at which point it is a replay and the caller treats it as one. Doing this as
 * SELECT-then-UPDATE would let both win.
 */
export async function rotateSession(
  sessionId: string,
  previousHash: string,
  nextHash: string,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .update(customerSessions)
    .set({ refreshTokenHash: nextHash, lastActiveAt: new Date() })
    .where(
      and(
        eq(customerSessions.id, sessionId),
        eq(customerSessions.refreshTokenHash, previousHash),
        isNull(customerSessions.revokedAt),
      ),
    )
    .returning({ id: customerSessions.id });
  return rows.length > 0;
}

export async function revokeSessionRow(sessionId: string, exec: Executor = db): Promise<void> {
  await exec
    .update(customerSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(customerSessions.id, sessionId), isNull(customerSessions.revokedAt)));
}

/** Returns the ids it revoked, so the caller can push them onto the Redis denylist. */
export async function revokeAllSessionsFor(
  customerId: string,
  exec: Executor = db,
): Promise<string[]> {
  const rows = await exec
    .update(customerSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(customerSessions.customerId, customerId), isNull(customerSessions.revokedAt)))
    .returning({ id: customerSessions.id });
  return rows.map((r) => r.id);
}

/* --------------------------------------------------------- otp challenges */

export async function insertOtpChallenge(
  values: {
    channel: OtpChannel;
    destination: string;
    codeHash: string;
    purpose: OtpPurpose;
    expiresAt: Date;
  },
  exec: Executor = db,
): Promise<OtpChallengeRow> {
  const rows = await exec.insert(otpChallenges).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('otp challenge insert returned no row');
  return row;
}

/**
 * The newest unconsumed challenge for this destination and purpose.
 *
 * Newest wins: a customer who taps "resend" and then types the code from the
 * first SMS is a support ticket, not a security event — but honouring the older
 * challenge would mean a code stays live after it has been superseded. The
 * partial index `idx_otp_dest (destination, purpose, created_at DESC) WHERE
 * consumed_at IS NULL` exists for exactly this query.
 */
export async function findLatestOtpChallenge(
  destination: string,
  purpose: OtpPurpose,
  exec: Executor = db,
): Promise<OtpChallengeRow | null> {
  const rows = await exec
    .select()
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.destination, destination),
        eq(otpChallenges.purpose, purpose),
        isNull(otpChallenges.consumedAt),
      ),
    )
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function findOtpChallengeById(
  challengeId: string,
  exec: Executor = db,
): Promise<OtpChallengeRow | null> {
  const rows = await exec
    .select()
    .from(otpChallenges)
    .where(eq(otpChallenges.id, challengeId))
    .limit(1);
  return rows[0] ?? null;
}

/** Per-destination send throttle. The IP-keyed `otp` limiter cannot see this. */
export async function countOtpChallengesSince(
  destination: string,
  purpose: OtpPurpose,
  since: Date,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.destination, destination),
        eq(otpChallenges.purpose, purpose),
        gte(otpChallenges.createdAt, since),
      ),
    );
  return rows[0]?.n ?? 0;
}

export async function incrementOtpAttempts(
  challengeId: string,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec
    .update(otpChallenges)
    .set({ attempts: sql`${otpChallenges.attempts} + 1` })
    .where(eq(otpChallenges.id, challengeId))
    .returning({ attempts: otpChallenges.attempts });
  return rows[0]?.attempts ?? 0;
}

export async function consumeOtpChallenge(challengeId: string, exec: Executor = db): Promise<void> {
  await exec
    .update(otpChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(otpChallenges.id, challengeId));
}
