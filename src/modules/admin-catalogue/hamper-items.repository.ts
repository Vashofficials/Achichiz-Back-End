/**
 * Pure Drizzle queries for hamper items. No business logic, no HTTP.
 *
 * `hamper_items.supplier_id` is nullable — an item with no supplier is valid but
 * cannot generate a purchase order. The LEFT JOIN on suppliers means rows with no
 * supplier still appear in the list with `supplierName: null`.
 */

import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import { hamperItems, suppliers } from '../../db/schema/index.js';
import type { HamperItemListQuery } from './hamper-items.schemas.js';

/* -------------------------------------------------------------- selection */

const hamperItemSelection = {
  id: hamperItems.id,
  sku: hamperItems.sku,
  name: hamperItems.name,
  supplierId: hamperItems.supplierId,
  supplierName: suppliers.name,
  category: hamperItems.category,
  costPaise: hamperItems.costPaise,
  unit: hamperItems.unit,
  weightGrams: hamperItems.weightGrams,
  isPerishable: hamperItems.isPerishable,
  shelfLifeDays: hamperItems.shelfLifeDays,
  status: hamperItems.status,
  createdAt: hamperItems.createdAt,
  updatedAt: hamperItems.updatedAt,
} as const;

export type HamperItemRow = {
  id: string;
  sku: string;
  name: string;
  supplierId: string | null;
  supplierName: string | null;
  category: string | null;
  costPaise: number;
  unit: string;
  weightGrams: number | null;
  isPerishable: boolean;
  shelfLifeDays: number | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

/* ------------------------------------------------------------ predicates */

function buildWhere(query: HamperItemListQuery): SQL | undefined {
  const conditions: (SQL | undefined)[] = [
    isNull(hamperItems.deletedAt),
    query.q
      ? or(
          ilike(hamperItems.name, `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
          ilike(hamperItems.sku, `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
        )
      : undefined,
    query.category ? eq(hamperItems.category, query.category) : undefined,
    query.isPerishable !== undefined ? eq(hamperItems.isPerishable, query.isPerishable) : undefined,
    query.status ? eq(hamperItems.status, query.status) : undefined,
    query.supplierId ? eq(hamperItems.supplierId, query.supplierId) : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  return present.length > 0 ? and(...present) : isNull(hamperItems.deletedAt);
}

/* ------------------------------------------------------------- reads */

export async function listHamperItems(
  query: HamperItemListQuery,
  exec: Executor = db,
): Promise<HamperItemRow[]> {
  const where = buildWhere(query);
  const offset = (query.page - 1) * query.perPage;
  return exec
    .select(hamperItemSelection)
    .from(hamperItems)
    .leftJoin(suppliers, eq(suppliers.id, hamperItems.supplierId))
    .where(where)
    .orderBy(asc(hamperItems.name), asc(hamperItems.sku))
    .limit(query.perPage)
    .offset(offset) as Promise<HamperItemRow[]>;
}

export async function countHamperItems(
  query: HamperItemListQuery,
  exec: Executor = db,
): Promise<number> {
  const where = buildWhere(query);
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(hamperItems)
    .where(where);
  return rows[0]?.n ?? 0;
}

export async function findHamperItemById(id: string, exec: Executor = db): Promise<HamperItemRow | null> {
  const rows = await exec
    .select(hamperItemSelection)
    .from(hamperItems)
    .leftJoin(suppliers, eq(suppliers.id, hamperItems.supplierId))
    .where(and(eq(hamperItems.id, id), isNull(hamperItems.deletedAt)))
    .limit(1) as HamperItemRow[];
  return rows[0] ?? null;
}

export async function skuExists(sku: string, excludeId?: string, exec: Executor = db): Promise<boolean> {
  const conditions: SQL[] = [eq(hamperItems.sku, sku), isNull(hamperItems.deletedAt)];
  if (excludeId) conditions.push(sql`${hamperItems.id} != ${excludeId}`);
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(hamperItems)
    .where(and(...conditions));
  return (rows[0]?.n ?? 0) > 0;
}

/* ------------------------------------------------------------ writes */

export async function insertHamperItem(
  data: {
    sku: string;
    name: string;
    supplierId?: string | null;
    category?: string | null;
    costPaise: number;
    unit: string;
    weightGrams?: number | null;
    isPerishable: boolean;
    shelfLifeDays?: number | null;
    status: string;
  },
  exec: Executor = db,
): Promise<string> {
  const rows = await exec
    .insert(hamperItems)
    .values({
      sku: data.sku,
      name: data.name,
      supplierId: data.supplierId ?? null,
      category: data.category ?? null,
      costPaise: data.costPaise,
      unit: data.unit as typeof hamperItems.$inferInsert['unit'],
      weightGrams: data.weightGrams ?? null,
      isPerishable: data.isPerishable,
      shelfLifeDays: data.shelfLifeDays ?? null,
      status: data.status as typeof hamperItems.$inferInsert['status'],
    })
    .returning({ id: hamperItems.id });
  return rows[0]!.id;
}

export async function updateHamperItem(
  id: string,
  patch: Partial<{
    sku: string;
    name: string;
    supplierId: string | null;
    category: string | null;
    costPaise: number;
    unit: string;
    weightGrams: number | null;
    isPerishable: boolean;
    shelfLifeDays: number | null;
    status: string;
  }>,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .update(hamperItems)
    .set({ ...patch, updatedAt: new Date() } as Partial<typeof hamperItems.$inferInsert>)
    .where(and(eq(hamperItems.id, id), isNull(hamperItems.deletedAt)))
    .returning({ id: hamperItems.id });
  return rows.length > 0;
}

export async function softDeleteHamperItem(id: string, exec: Executor = db): Promise<boolean> {
  const rows = await exec
    .update(hamperItems)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(hamperItems.id, id), isNull(hamperItems.deletedAt)))
    .returning({ id: hamperItems.id });
  return rows.length > 0;
}
