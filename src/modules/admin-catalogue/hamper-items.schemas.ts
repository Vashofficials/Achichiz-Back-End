/**
 * Hamper Items admin contracts.
 *
 * `hamper_items` are the raw physical components that go INTO customer hampers —
 * Kashmiri Saffron, Belgian Truffles, Aromatherapy Candles. They are stock items,
 * not sellable products; they live in `inventory_levels` alongside product variants.
 *
 * All monetary values are integer paise. There is no rupee field anywhere here.
 */

import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';
import { HAMPER_ITEM_UNITS } from '../../db/schema/index.js';

/* ----------------------------------------------------------------- params */

export const hamperItemIdParam = z.object({
  id: z.uuid().describe('Hamper item id.'),
});

/* ---------------------------------------------------------------- queries */

export const hamperItemListQuery = listQuery.extend({
  q: z.string().trim().min(1).max(120).optional().describe('Matches name or SKU, case-insensitively.'),
  category: z.string().trim().min(1).max(80).optional().describe('Filter by category (exact match).'),
  isPerishable: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
    .describe('`true` = perishable items only, `false` = non-perishable only.'),
  status: z.enum(['active', 'inactive']).optional().describe('Filter by status.'),
  supplierId: z.uuid().optional().describe('Filter to one supplier.'),
});

/* ----------------------------------------------------------------- bodies */

export const createHamperItemBody = z.object({
  sku: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'SKU may only contain letters, digits, hyphens and underscores.')
    .describe('Partial-unique SKU. Must be unique among non-deleted hamper items.'),
  name: z.string().trim().min(1).max(200).describe('Display name of the item.'),
  supplierId: z.uuid().optional().describe('Preferred supplier. Can be set later.'),
  category: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe('Free-text category, e.g. `Gourmet & Sweets`, `Decor`, `Wellness`.'),
  costPaise: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Unit cost in integer paise. Used for stock valuation. Does not affect order price.'),
  unit: z
    .enum(HAMPER_ITEM_UNITS)
    .default('pcs')
    .describe('Unit of measure: `pcs`, `box`, `pack`, `kg`, `g`, `ml`, `l`.'),
  weightGrams: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Weight per unit in grams. Used for shipping calculations.'),
  isPerishable: z.boolean().default(false).describe('Whether the item has a shelf-life.'),
  shelfLifeDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Shelf life in days. Required when `isPerishable` is true.'),
  status: z
    .enum(['active', 'inactive'])
    .default('active')
    .describe('`active` items appear in the hamper builder. `inactive` items are hidden from operators.'),
});

export const updateHamperItemBody = createHamperItemBody
  .partial()
  .omit({ sku: true })
  .extend({
    sku: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional()
      .describe('SKU. Can only be changed while there is no inventory record referencing it.'),
  });

/* --------------------------------------------------------------- responses */

export const hamperItemResponse = z.object({
  id: z.uuid().describe('Hamper item id.'),
  sku: z.string().describe('Stock-keeping unit.'),
  name: z.string().describe('Display name.'),
  supplierId: z.uuid().nullable().describe('Preferred supplier id.'),
  supplierName: z.string().nullable().describe('Preferred supplier name.'),
  category: z.string().nullable().describe('Free-text category.'),
  costPaise: z.number().int().describe('Unit cost in integer paise.'),
  unit: z.enum(HAMPER_ITEM_UNITS).describe('Unit of measure.'),
  weightGrams: z.number().int().nullable().describe('Weight per unit in grams.'),
  isPerishable: z.boolean().describe('Whether the item has a shelf-life.'),
  shelfLifeDays: z.number().int().nullable().describe('Shelf life in days.'),
  status: z.enum(['active', 'inactive']).describe('Item status.'),
  createdAt: z.iso.datetime().describe('When the item was created.'),
  updatedAt: z.iso.datetime().describe('When the item was last modified.'),
});

/* ---------------------------------------------------------- inferred types */

export type HamperItemListQuery = z.infer<typeof hamperItemListQuery>;
export type CreateHamperItemBody = z.infer<typeof createHamperItemBody>;
export type UpdateHamperItemBody = z.infer<typeof updateHamperItemBody>;
export type HamperItemResponse = z.infer<typeof hamperItemResponse>;
