/**
 * Drizzle queries for the address book. No business rules, no HTTP.
 *
 * Every read filters `deleted_at IS NULL`, and every write is scoped by
 * `customer_id` in the same predicate as the id. Scoping in the WHERE clause
 * rather than checking ownership after the row comes back means a mismatched id
 * returns zero rows and the service turns that into a 404 — there is no code path
 * where a row belonging to someone else is loaded and then discarded.
 */

import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import { addresses } from '../../db/schema/index.js';

export type AddressRow = typeof addresses.$inferSelect;

const mine = (customerId: string, addressId?: string) =>
  addressId
    ? and(
        eq(addresses.id, addressId),
        eq(addresses.customerId, customerId),
        isNull(addresses.deletedAt),
      )
    : and(eq(addresses.customerId, customerId), isNull(addresses.deletedAt));

export async function listForCustomer(
  customerId: string,
  exec: Executor = db,
): Promise<AddressRow[]> {
  return exec
    .select()
    .from(addresses)
    .where(mine(customerId))
    // Default first — it is the one checkout pre-selects, so it is the one the
    // list should lead with.
    .orderBy(desc(addresses.isDefault), asc(addresses.createdAt));
}

export async function findForCustomer(
  customerId: string,
  addressId: string,
  exec: Executor = db,
): Promise<AddressRow | null> {
  const rows = await exec.select().from(addresses).where(mine(customerId, addressId)).limit(1);
  return rows[0] ?? null;
}

export async function countForCustomer(customerId: string, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(addresses)
    .where(mine(customerId));
  return rows[0]?.n ?? 0;
}

/**
 * Stand down every other default for this customer.
 *
 * `uq_one_default_address_per_customer` is a **partial unique index**, and a
 * unique index cannot be deferred to COMMIT. So this must run *before* the row
 * that is becoming the new default is written, inside the same transaction —
 * setting the new one first raises 23505 even though the end state would have
 * been legal (`db/schema/README.md`, "Default flags").
 */
export async function clearDefault(
  customerId: string,
  exceptId: string | null,
  exec: Executor = db,
): Promise<void> {
  const predicate = exceptId
    ? and(
        eq(addresses.customerId, customerId),
        eq(addresses.isDefault, true),
        isNull(addresses.deletedAt),
        ne(addresses.id, exceptId),
      )
    : and(
        eq(addresses.customerId, customerId),
        eq(addresses.isDefault, true),
        isNull(addresses.deletedAt),
      );

  await exec.update(addresses).set({ isDefault: false, updatedAt: new Date() }).where(predicate);
}

export async function insertAddress(
  values: typeof addresses.$inferInsert,
  exec: Executor = db,
): Promise<AddressRow> {
  const rows = await exec.insert(addresses).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('address insert returned no row');
  return row;
}

export async function updateAddress(
  customerId: string,
  addressId: string,
  patch: Partial<typeof addresses.$inferInsert>,
  exec: Executor = db,
): Promise<AddressRow | null> {
  const rows = await exec
    .update(addresses)
    .set({ ...patch, updatedAt: new Date() })
    .where(mine(customerId, addressId))
    .returning();
  return rows[0] ?? null;
}

/**
 * Soft delete — `addresses` is Tier 2.
 *
 * `is_default` is cleared in the same statement. The row would drop out of the
 * partial unique index anyway (it is predicated on `deleted_at IS NULL`), but
 * leaving a deleted row flagged default means any later query that forgets the
 * `deleted_at` filter reads a ghost as the customer's default address.
 *
 * `trg_ensure_default_address` fires AFTER this and promotes the oldest surviving
 * address, so the customer is never left with addresses and no default.
 */
export async function softDelete(
  customerId: string,
  addressId: string,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .update(addresses)
    .set({ isDefault: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(mine(customerId, addressId))
    .returning({ id: addresses.id });
  return rows.length > 0;
}
