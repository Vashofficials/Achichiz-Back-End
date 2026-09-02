/**
 * Derived fields for the collections list.
 */

import { inArray } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { collections, designers } from '../../db/schema/index.js';

type Row = Record<string, unknown>;

const idsIn = (rows: Row[], key: string): string[] => [
  ...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === 'string')),
];

export async function enrichCollections(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  const parentIds = idsIn(rows, 'parentId');
  const designerIds = idsIn(rows, 'designerId');

  const [parentRows, designerRows] = await Promise.all([
    parentIds.length
      ? db
          .select({ id: collections.id, title: collections.title })
          .from(collections)
          .where(inArray(collections.id, parentIds))
      : Promise.resolve([]),
    designerIds.length
      ? db
          .select({ id: designers.id, name: designers.name })
          .from(designers)
          .where(inArray(designers.id, designerIds))
      : Promise.resolve([]),
  ]);

  const parentById = new Map(parentRows.map((p) => [p.id, p]));
  const designerById = new Map(designerRows.map((d) => [d.id, d]));

  return rows.map((row) => {
    const enriched = { ...row };
    
    if (typeof row.parentId === 'string') {
      const parent = parentById.get(row.parentId);
      if (parent) enriched.parentTitle = parent.title;
    }

    if (typeof row.designerId === 'string') {
      const designer = designerById.get(row.designerId);
      if (designer) enriched.designerName = designer.name;
    }

    return enriched;
  });
}
