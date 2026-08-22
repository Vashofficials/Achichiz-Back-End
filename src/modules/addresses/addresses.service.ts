/**
 * Address-book business rules.
 *
 * ## The one-default invariant, and who actually enforces it
 *
 * Three mechanisms, doing three different jobs — it is worth being precise about
 * which is which, because "the schema guarantees it" is only two-thirds true:
 *
 * | Rule | Enforced by |
 * |---|---|
 * | **At most one** default per customer | `uq_one_default_address_per_customer`, a partial unique index on `(customer_id) WHERE is_default AND deleted_at IS NULL` |
 * | **At least one** default, once any address exists | `trg_ensure_default_address`, which promotes the oldest survivor after an insert, a flag change or a delete |
 * | The **write order** that keeps the first two satisfiable | this file |
 *
 * That third row is the point. A partial unique index **cannot be deferred to
 * COMMIT**. Setting the new default and then clearing the old one raises 23505 in
 * between, even though the end state is legal. So every path that hands the flag
 * to a different row does it in one transaction, old default cleared first
 * (`db/schema/README.md`, "Default flags"). This service cooperates with the
 * index rather than fighting it — no retry loop, no `ON CONFLICT`, no
 * "clear-everything-then-set" dance outside a transaction.
 *
 * The trigger is a safety net for the paths this service does not own (an admin
 * write, a bulk import). It is not the mechanism, and code that relies on it to
 * pick the right address is code that has stopped deciding.
 */

import { db } from '../../config/db.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import * as repo from './addresses.repository.js';
import type { AddressBody, AddressResponse, UpdateAddressBody } from './addresses.schemas.js';

/* ------------------------------------------------------------ projection */

export function toAddress(row: repo.AddressRow): AddressResponse {
  return {
    id: row.id,
    label: row.label,
    contactName: row.contactName,
    mobile: row.mobile,
    line1: row.line1,
    line2: row.line2,
    area: row.area,
    city: row.city,
    stateCode: row.stateCode,
    pincode: row.pincode,
    countryCode: row.countryCode,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------- the pure decision */

export type DefaultPlan = {
  /** The value `is_default` should take on the row being written. */
  isDefault: boolean;
  /**
   * True when some *other* row currently holds the flag and must be stood down
   * first — the ordering the partial unique index forces.
   */
  clearExistingDefault: boolean;
};

/**
 * Should this address become the default, and does something have to move first?
 *
 * Pure, and exhaustively tested — this is the decision the index will punish us
 * for getting wrong, so it is worth having somewhere it can be reasoned about
 * without a database.
 *
 * The "first address is automatically the default" rule is server-side here on
 * purpose: the storefront does it in the browser today
 * (`store/src/lib/account.ts:116-122`), which means an address created through
 * any other path — checkout's `saveToAddressBook`, an admin, an import — misses
 * it.
 */
export function planDefault(input: {
  /** What the request asked for. `undefined` means "no opinion". */
  requested: boolean | undefined;
  /** Does the customer have any other live address? */
  hasOtherAddresses: boolean;
  /** Does this row already hold the flag? Always false on create. */
  alreadyDefault: boolean;
}): DefaultPlan {
  // Explicitly asked for it: take it, standing down the incumbent — unless the
  // incumbent is this very row, or there is no other row that could be holding
  // the flag. Either way there is nothing to move, and issuing the UPDATE anyway
  // would be a pointless write inside the transaction that every checkout waits on.
  if (input.requested === true) {
    return {
      isDefault: true,
      clearExistingDefault: !input.alreadyDefault && input.hasOtherAddresses,
    };
  }

  // The only address there is. It is the default whether or not anybody asked —
  // otherwise checkout opens with nothing pre-selected.
  if (!input.hasOtherAddresses) {
    return { isDefault: true, clearExistingDefault: false };
  }

  // No opinion: leave the flag exactly as it is.
  return { isDefault: input.alreadyDefault, clearExistingDefault: false };
}

/* ------------------------------------------------------------------ reads */

export async function listMyAddresses(customerId: string): Promise<AddressResponse[]> {
  const rows = await repo.listForCustomer(customerId);
  return rows.map(toAddress);
}

export async function getMyAddress(customerId: string, addressId: string): Promise<AddressResponse> {
  const row = await repo.findForCustomer(customerId, addressId);
  // Somebody else's address is a 404, not a 403 — confirming that an id exists
  // is itself a leak, and it is the same answer the orders module gives.
  if (!row) throw new NotFoundError('Address', addressId);
  return toAddress(row);
}

/* ----------------------------------------------------------------- writes */

export async function createMyAddress(
  customerId: string,
  body: AddressBody,
): Promise<AddressResponse> {
  return db.transaction(async (tx) => {
    const existing = await repo.countForCustomer(customerId, tx);
    const plan = planDefault({
      requested: body.isDefault,
      hasOtherAddresses: existing > 0,
      alreadyDefault: false,
    });

    // BEFORE the insert. The index is not deferrable; the other order is a 23505.
    if (plan.clearExistingDefault) await repo.clearDefault(customerId, null, tx);

    const row = await repo.insertAddress(
      {
        customerId,
        label: body.label,
        contactName: body.contactName,
        mobile: body.mobile,
        line1: body.line1,
        line2: body.line2 ?? null,
        area: body.area ?? null,
        city: body.city,
        stateCode: body.stateCode,
        pincode: body.pincode,
        countryCode: body.countryCode,
        isDefault: plan.isDefault,
      },
      tx,
    );

    return toAddress(row);
  });
}

export async function updateMyAddress(
  customerId: string,
  addressId: string,
  body: UpdateAddressBody,
): Promise<AddressResponse> {
  return db.transaction(async (tx) => {
    const current = await repo.findForCustomer(customerId, addressId, tx);
    if (!current) throw new NotFoundError('Address', addressId);

    /*
     * `isDefault: false` on the address that currently holds the flag is refused.
     *
     * There is no such thing as "no default while addresses exist" — the trigger
     * would immediately promote some other row, so honouring the request would
     * produce a result the customer did not ask for and cannot predict. Making
     * a different address the default is the operation they actually want, and
     * it has its own endpoint.
     */
    if (body.isDefault === false && current.isDefault) {
      throw new UnprocessableError(
        'An address cannot stop being the default on its own. Make another address the default instead.',
        'default_address_required',
      );
    }

    const others = (await repo.countForCustomer(customerId, tx)) - 1;
    const plan = planDefault({
      requested: body.isDefault,
      hasOtherAddresses: others > 0,
      alreadyDefault: current.isDefault,
    });

    if (plan.clearExistingDefault) await repo.clearDefault(customerId, addressId, tx);

    const patch: Partial<typeof current> = { isDefault: plan.isDefault };
    if (body.label !== undefined) patch.label = body.label;
    if (body.contactName !== undefined) patch.contactName = body.contactName;
    if (body.mobile !== undefined) patch.mobile = body.mobile;
    if (body.line1 !== undefined) patch.line1 = body.line1;
    if (body.line2 !== undefined) patch.line2 = body.line2;
    if (body.area !== undefined) patch.area = body.area;
    if (body.city !== undefined) patch.city = body.city;
    if (body.stateCode !== undefined) patch.stateCode = body.stateCode;
    if (body.pincode !== undefined) patch.pincode = body.pincode;
    if (body.countryCode !== undefined) patch.countryCode = body.countryCode;

    const row = await repo.updateAddress(customerId, addressId, patch, tx);
    if (!row) throw new NotFoundError('Address', addressId);
    return toAddress(row);
  });
}

/**
 * Hand the default flag to a specific address.
 *
 * The whole operation is two statements in one transaction, in the only order
 * the partial unique index permits: stand the incumbent down, then promote.
 */
export async function setDefaultAddress(
  customerId: string,
  addressId: string,
): Promise<AddressResponse[]> {
  await db.transaction(async (tx) => {
    const current = await repo.findForCustomer(customerId, addressId, tx);
    if (!current) throw new NotFoundError('Address', addressId);
    if (current.isDefault) return;

    await repo.clearDefault(customerId, addressId, tx);
    await repo.updateAddress(customerId, addressId, { isDefault: true }, tx);
  });

  // The whole list comes back: exactly one row's `isDefault` changed to true and
  // at most one changed to false, and a client that re-renders from this cannot
  // end up showing two ticks.
  return listMyAddresses(customerId);
}

export async function deleteMyAddress(customerId: string, addressId: string): Promise<void> {
  const removed = await repo.softDelete(customerId, addressId);
  if (!removed) throw new NotFoundError('Address', addressId);
  // No explicit promotion here: `trg_ensure_default_address` fires on the
  // `deleted_at` change and hands the flag to the oldest surviving address. Doing
  // it again in application code would be a second, competing implementation of
  // the same rule.
}
