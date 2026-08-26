/**
 * Bundles — the merchandising side of component composition.
 *
 * Three rules shape this file.
 *
 * **1. A bundle has no stock (§91).** Nothing here writes an `inventory_levels`
 * row for a bundle and nothing reads one. `getAvailability` computes the answer
 * from the components on every call. A stored bundle quantity is a second
 * opinion about stock that drifts the first time somebody buys a component on
 * its own, and that drift is how the Build Your Own Hamper flow oversells today.
 *
 * **2. The saving is derived.** `bundles` has no `savings` column on purpose.
 * A component's price can change without the bundle being touched, and a stored
 * saving would then be advertising a discount that no longer exists.
 *
 * **3. Contents are replaced, never patched.** `bundle_items` is keyed by
 * `(bundle_id, variant_id)` with no surrogate id, so `items` in a PATCH replaces
 * the list inside one transaction. Omitting `items` leaves the contents alone.
 */

import { and, type SQL } from 'drizzle-orm';
import { db } from '../../config/db.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
  type FieldIssue,
} from '../../lib/errors.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import { BUNDLE_STATUSES, type BundleStatus } from '../../db/schema/index.js';
import * as repo from './admin-bundles.repository.js';
import { bundleAvailability, bundleSavingsPaise } from './admin-bundles.availability.js';
import type {
  BundleAvailabilityQuery,
  BundleAvailabilityResponse,
  BundleArchiveResponse,
  BundleDetail,
  BundleListQuery,
  BundleSummary,
  CreateBundleBody,
  UpdateBundleBody,
} from './admin-bundles.schemas.js';

/* ------------------------------------------------------------- utilities */

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);
const likePattern = (term: string): string => `%${escapeLike(term)}%`;
const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

const SORTABLE = ['createdAt', 'name', 'handle', 'bundlePricePaise', 'startsAt'] as const;

/** `?status=active,draft` → checked against the live vocabulary. A typo is a 400, not an empty page. */
function statusCsv(raw: string | undefined): BundleStatus[] {
  const values = (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (values.length === 0) return [];

  const unknown = values.filter((v) => !(BUNDLE_STATUSES as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Unknown bundle status: ${unknown.join(', ')}. Valid values: ${BUNDLE_STATUSES.join(', ')}.`,
    );
  }
  return values as BundleStatus[];
}

const parseInstant = (raw: string | null | undefined): Date | null => (raw ? new Date(raw) : null);

/** Sellable right now. Evaluated, never stored — `status` alone does not expire. */
const isLiveNow = (row: { status: BundleStatus; startsAt: Date | null; endsAt: Date | null }, now: Date): boolean =>
  row.status === 'active' &&
  (row.startsAt === null || row.startsAt <= now) &&
  (row.endsAt === null || row.endsAt > now);

/* --------------------------------------------------------------- mappers */

function toSummary(row: repo.BundleRow, now: Date): BundleSummary {
  const { savingsPaise, savingsBp } = bundleSavingsPaise(
    // The SQL subquery already produced the component total; re-deriving it from
    // a single synthetic line keeps ONE implementation of the saving formula.
    [{ quantity: 1, unitPricePaise: row.componentTotalPaise }],
    row.bundlePricePaise,
  );

  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    bundlePricePaise: row.bundlePricePaise,
    componentTotalPaise: row.componentTotalPaise,
    savingsPaise,
    savingsBp,
    status: row.status,
    isLive: isLiveNow(row, now),
    itemCount: row.itemCount,
    unitCount: row.unitCount,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    archivedAt: iso(row.deletedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ list */

export async function listBundles(query: BundleListQuery): Promise<{ items: BundleSummary[]; total: number }> {
  const now = new Date();
  const filters: (SQL | undefined)[] = [];

  if (query.includeArchived !== 'true') filters.push(repo.bundleNotArchived());
  filters.push(repo.bundleStatusIn(statusCsv(query.status)));
  if (query.live === 'true') filters.push(repo.bundleIsLive(now));
  if (query.variantId) filters.push(repo.bundleContainsVariant(query.variantId));
  if (query.q) filters.push(repo.bundleMatchesText(likePattern(query.q)));

  const where = and(...filters.filter((f): f is SQL => f !== undefined));
  const { field, direction } = parseSort(query.sort, SORTABLE, { field: 'createdAt', direction: 'desc' });

  const rows = await repo.listBundles(
    where,
    repo.bundleOrderBy(field, direction),
    query.perPage,
    offsetOf(query.page, query.perPage),
  );
  const total = await repo.countBundles(where);

  return { items: rows.map((r) => toSummary(r, now)), total };
}

/* ------------------------------------------------------------------- get */

export async function getBundle(bundleId: string): Promise<BundleDetail> {
  const row = await repo.findBundle(bundleId);
  if (!row) throw new NotFoundError('Bundle', bundleId);

  const items = await repo.findBundleItems(bundleId);
  return { ...toSummary(row, new Date()), items };
}

/* ---------------------------------------------------------------- create */

/**
 * Validate the item list before anything is written.
 *
 * Two things the database would catch later and one it would not: duplicate
 * variants collide with `PRIMARY KEY (bundle_id, variant_id)` and a missing
 * variant violates the foreign key, but a SOFT-DELETED variant satisfies both
 * and produces a bundle that can never ship. All three come back as field-level
 * issues rather than as a constraint violation from three layers down.
 */
async function assertItemsUsable(items: readonly { variantId: string }[]): Promise<void> {
  const issues: FieldIssue[] = [];

  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.variantId)) {
      issues.push({
        path: `items.${index}.variantId`,
        code: 'duplicate_variant',
        message:
          `Variant ${item.variantId} appears twice. bundle_items is keyed by (bundleId, variantId) — ` +
          'put the total in one line\'s `quantity` instead.',
      });
    }
    seen.add(item.variantId);
  });

  const live = await repo.liveVariantIds([...seen]);
  items.forEach((item, index) => {
    if (!live.has(item.variantId)) {
      issues.push({
        path: `items.${index}.variantId`,
        code: 'unknown_variant',
        message: `Variant ${item.variantId} does not exist or has been discontinued.`,
      });
    }
  });

  if (issues.length > 0) {
    throw new UnprocessableError(
      'The bundle contents are not usable. Nothing was written.',
      'invalid_bundle_items',
      { issues },
    );
  }
}

function assertWindowSane(startsAt: Date | null, endsAt: Date | null): void {
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw new UnprocessableError(
      `The bundle ends at ${endsAt.toISOString()}, which is not after it starts (${startsAt.toISOString()}). ` +
        'That window is never open.',
      'invalid_schedule_window',
      { context: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } },
    );
  }
}

export async function createBundle(body: CreateBundleBody): Promise<BundleDetail> {
  const startsAt = parseInstant(body.startsAt);
  const endsAt = parseInstant(body.endsAt);
  assertWindowSane(startsAt, endsAt);
  await assertItemsUsable(body.items);

  const clash = await repo.findBundleByHandle(body.handle, null);
  if (clash) {
    throw new ConflictError(
      `The handle '${body.handle}' is already in use by another live bundle. Handles are the URL, so they ` +
        'have to be unique among bundles that have not been archived.',
    );
  }

  const created = await db.transaction(async (tx) => {
    const bundle = await repo.insertBundle(tx, {
      handle: body.handle,
      name: body.name,
      bundlePricePaise: body.bundlePricePaise,
      status: body.status,
      startsAt,
      endsAt,
    });

    await repo.replaceBundleItems(
      tx,
      bundle.id,
      body.items.map((i, index) => ({
        variantId: i.variantId,
        quantity: i.quantity,
        position: i.position || index,
      })),
    );

    return bundle;
  });

  return getBundle(created.id);
}

/* ---------------------------------------------------------------- update */

export async function updateBundle(bundleId: string, body: UpdateBundleBody): Promise<BundleDetail> {
  if (body.items) await assertItemsUsable(body.items);

  await db.transaction(async (tx) => {
    const bundle = await repo.lockBundle(tx, bundleId);
    if (!bundle) throw new NotFoundError('Bundle', bundleId);
    if (bundle.deletedAt) {
      throw new UnprocessableError(
        'This bundle is archived. Archiving frees its handle for reuse, so editing it could resurrect a ' +
          'row that now collides with a live bundle. Create a new one.',
        'bundle_archived',
        { context: { bundleId } },
      );
    }

    const startsAt = body.startsAt === undefined ? bundle.startsAt : parseInstant(body.startsAt);
    const endsAt = body.endsAt === undefined ? bundle.endsAt : parseInstant(body.endsAt);
    assertWindowSane(startsAt, endsAt);

    if (body.handle && body.handle !== bundle.handle) {
      const clash = await repo.findBundleByHandle(body.handle, bundleId, tx);
      if (clash) {
        throw new ConflictError(`The handle '${body.handle}' is already in use by another live bundle.`);
      }
    }

    await repo.updateBundle(tx, bundleId, {
      ...(body.handle ? { handle: body.handle } : {}),
      ...(body.name ? { name: body.name } : {}),
      ...(body.bundlePricePaise !== undefined ? { bundlePricePaise: body.bundlePricePaise } : {}),
      ...(body.status ? { status: body.status } : {}),
      ...(body.startsAt === undefined ? {} : { startsAt }),
      ...(body.endsAt === undefined ? {} : { endsAt }),
      updatedAt: new Date(),
    });

    if (body.items) {
      await repo.replaceBundleItems(
        tx,
        bundleId,
        body.items.map((i, index) => ({
          variantId: i.variantId,
          quantity: i.quantity,
          position: i.position || index,
        })),
      );
    }
  });

  return getBundle(bundleId);
}

/* --------------------------------------------------------------- archive */

/**
 * Soft delete (§96). The row stays, because orders that already contain the
 * bundle still name it, and the handle is freed for a replacement by the partial
 * unique index.
 *
 * Archiving an already-archived bundle is a no-op rather than an error — a
 * double-click is not a mistake worth a 422, and there is no second effect to
 * guard against the way there is when releasing a stock hold twice.
 */
export async function archiveBundle(bundleId: string): Promise<BundleArchiveResponse> {
  const archivedAt = await db.transaction(async (tx) => {
    const bundle = await repo.lockBundle(tx, bundleId);
    if (!bundle) throw new NotFoundError('Bundle', bundleId);
    if (bundle.deletedAt) return bundle.deletedAt;

    const now = new Date();
    await repo.updateBundle(tx, bundleId, { status: 'archived', deletedAt: now, updatedAt: now });
    return now;
  });

  const row = await repo.findBundle(bundleId);
  if (!row) throw new NotFoundError('Bundle', bundleId);

  return {
    id: row.id,
    handle: row.handle,
    status: 'archived',
    archivedAt: archivedAt.toISOString(),
  };
}

/* ---------------------------------------------------------- availability */

/**
 * The §91 endpoint: how many of this bundle could we ship, computed from the
 * components, right now.
 *
 * A component with no `inventory_levels` row is read as zero rather than skipped.
 * Skipping it would quietly remove the scarcest item from the MIN and report a
 * bundle as fulfillable because nobody has ever stocked one of its parts.
 */
export async function getAvailability(
  bundleId: string,
  query: BundleAvailabilityQuery,
): Promise<BundleAvailabilityResponse> {
  const bundle = await repo.findBundle(bundleId);
  if (!bundle) throw new NotFoundError('Bundle', bundleId);

  if (query.warehouseId) {
    const warehouse = await repo.findWarehouse(query.warehouseId);
    if (!warehouse) throw new NotFoundError('Warehouse', query.warehouseId);
  }

  const items = await repo.findBundleItems(bundleId);
  const stock = await repo.variantStock(
    items.map((i) => i.variantId),
    query.warehouseId ?? null,
  );

  const computed = bundleAvailability(
    items.map((i) => ({
      variantId: i.variantId,
      requiredQty: i.quantity,
      availableQty: stock.get(i.variantId)?.availableQty ?? 0,
    })),
    query.quantity,
  );

  const byVariant = new Map(computed.components.map((c) => [c.variantId, c]));

  return {
    bundleId: bundle.id,
    handle: bundle.handle,
    warehouseId: query.warehouseId ?? null,
    requestedQty: computed.requestedQty,
    fulfillableQty: computed.fulfillableQty,
    canFulfil: computed.canFulfil,
    limitingVariantIds: computed.limitingVariantIds,
    components: items.map((item) => {
      const row = byVariant.get(item.variantId);
      const position = stock.get(item.variantId);
      return {
        variantId: item.variantId,
        sku: item.sku,
        title: item.title,
        required: item.quantity,
        available: row?.available ?? 0,
        onHand: position?.onHandQty ?? 0,
        reserved: position?.reservedQty ?? 0,
        shortage: row?.shortage ?? item.quantity * computed.requestedQty,
        fulfillableQty: row?.fulfillableQty ?? 0,
        isLimiting: row?.isLimiting ?? true,
      };
    }),
  };
}
