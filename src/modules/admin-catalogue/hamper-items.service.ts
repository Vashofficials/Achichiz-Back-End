/**
 * Hamper Items service. Business logic only; no HTTP, no Express.
 *
 * Throws `AppError` subclasses from `lib/errors.js`. The route layer converts
 * these to the standard error envelope.
 */

import { ConflictError, NotFoundError } from '../../lib/errors.js';
import * as repo from './hamper-items.repository.js';
import type {
  CreateHamperItemBody,
  HamperItemListQuery,
  HamperItemResponse,
  UpdateHamperItemBody,
} from './hamper-items.schemas.js';

/* ---------------------------------------------------------------- helpers */

const toResponse = (row: repo.HamperItemRow): HamperItemResponse => ({
  id: row.id,
  sku: row.sku,
  name: row.name,
  supplierId: row.supplierId,
  supplierName: row.supplierName,
  category: row.category,
  costPaise: row.costPaise,
  unit: row.unit as HamperItemResponse['unit'],
  weightGrams: row.weightGrams,
  isPerishable: row.isPerishable,
  shelfLifeDays: row.shelfLifeDays,
  status: row.status as HamperItemResponse['status'],
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/* --------------------------------------------------------------- service */

export async function listHamperItems(
  query: HamperItemListQuery,
): Promise<{ items: HamperItemResponse[]; total: number }> {
  const [rows, total] = await Promise.all([
    repo.listHamperItems(query),
    repo.countHamperItems(query),
  ]);
  return { items: rows.map(toResponse), total };
}

export async function getHamperItem(id: string): Promise<HamperItemResponse> {
  const row = await repo.findHamperItemById(id);
  if (!row) throw new NotFoundError('Hamper item', id);
  return toResponse(row);
}

export async function createHamperItem(body: CreateHamperItemBody): Promise<HamperItemResponse> {
  const exists = await repo.skuExists(body.sku);
  if (exists) {
    throw new ConflictError(`A hamper item with SKU '${body.sku}' already exists.`);
  }

  const id = await repo.insertHamperItem({
    sku: body.sku,
    name: body.name,
    supplierId: body.supplierId ?? null,
    category: body.category ?? null,
    costPaise: body.costPaise,
    unit: body.unit,
    weightGrams: body.weightGrams ?? null,
    isPerishable: body.isPerishable,
    shelfLifeDays: body.shelfLifeDays ?? null,
    status: body.status,
  });

  const row = await repo.findHamperItemById(id);
  if (!row) throw new NotFoundError('Hamper item', id);
  return toResponse(row);
}

export async function updateHamperItem(
  id: string,
  body: UpdateHamperItemBody,
): Promise<HamperItemResponse> {
  const existing = await repo.findHamperItemById(id);
  if (!existing) throw new NotFoundError('Hamper item', id);

  if (body.sku && body.sku !== existing.sku) {
    const conflict = await repo.skuExists(body.sku, id);
    if (conflict) {
      throw new ConflictError(`A hamper item with SKU '${body.sku}' already exists.`);
    }
  }

  await repo.updateHamperItem(id, {
    sku: body.sku,
    name: body.name,
    supplierId: body.supplierId ?? undefined,
    category: body.category ?? undefined,
    costPaise: body.costPaise,
    unit: body.unit,
    weightGrams: body.weightGrams ?? undefined,
    isPerishable: body.isPerishable,
    shelfLifeDays: body.shelfLifeDays ?? undefined,
    status: body.status,
  });

  const row = await repo.findHamperItemById(id);
  if (!row) throw new NotFoundError('Hamper item', id);
  return toResponse(row);
}

export async function deleteHamperItem(id: string): Promise<void> {
  const deleted = await repo.softDeleteHamperItem(id);
  if (!deleted) throw new NotFoundError('Hamper item', id);
}
