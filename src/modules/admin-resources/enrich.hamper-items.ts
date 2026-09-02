/**
 * Derived fields for the hamper-items list.
 */

import { inArray } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { suppliers } from '../../db/schema/index.js';

type Row = Record<string, unknown>;

const idsIn = (rows: Row[], key: string): string[] => [
  ...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === 'string')),
];

export async function enrichHamperItems(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  const supplierIds = idsIn(rows, 'supplierId');

  const supplierRows = supplierIds.length
    ? await db
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
        .where(inArray(suppliers.id, supplierIds))
    : [];

  const supplierById = new Map(supplierRows.map((s) => [s.id, s]));

  return rows.map((row) => {
    const enriched = { ...row };
    
    if (typeof row.supplierId === 'string') {
      const supplier = supplierById.get(row.supplierId);
      if (supplier) enriched.supplierName = supplier.name;
    }

    return enriched;
  });
}
