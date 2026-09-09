/**
 * Derived fields for the delivery-zones list.
 */

import { eq, inArray, sql, count } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { deliveryZonePincodes } from '../../db/schema/index.js';

type Row = Record<string, unknown>;

export async function enrichDeliveryZones(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  const zoneIds = [...new Set(rows.map((r) => r.id).filter((v): v is string => typeof v === 'string'))];

  const pincodeCounts = zoneIds.length
    ? await db
        .select({
          zoneId: deliveryZonePincodes.zoneId,
          pincodes: count(),
        })
        .from(deliveryZonePincodes)
        .where(inArray(deliveryZonePincodes.zoneId, zoneIds))
        .groupBy(deliveryZonePincodes.zoneId)
    : [];

  const countById = new Map(pincodeCounts.map((s) => [s.zoneId, Number(s.pincodes || 0)]));

  // If fetching a single zone (e.g. edit form or detail page), fetch the full list of PIN codes
  let singleZonePincodes: string[] = [];
  const first = rows[0];
  if (rows.length === 1 && first && typeof first.id === 'string') {
    const pins = await db
      .select({ pincode: deliveryZonePincodes.pincode })
      .from(deliveryZonePincodes)
      .where(eq(deliveryZonePincodes.zoneId, first.id))
      .orderBy(deliveryZonePincodes.pincode);
    singleZonePincodes = pins.map((p) => p.pincode);
  }

  return rows.map((row) => {
    const enriched = { ...row };
    
    if (typeof row.id === 'string') {
      if (rows.length === 1) {
        enriched.pincodes = singleZonePincodes.join(', ');
        enriched.pincodeCount = singleZonePincodes.length;
      } else {
        enriched.pincodes = countById.get(row.id) || 0;
      }
    }

    return enriched;
  });
}
