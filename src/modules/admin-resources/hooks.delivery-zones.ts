/**
 * Syncs the delivery zone pincodes array on save.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { deliveryZonePincodes } from '../../db/schema/index.js';

export async function syncDeliveryZonePincodes(id: string, body: Record<string, unknown>): Promise<void> {
  const pincodes = Array.isArray(body.pincodes)
    ? body.pincodes.filter((p) => typeof p === 'string' && p.length > 0)
    : undefined;

  if (pincodes === undefined) return;

  await db.transaction(async (tx) => {
    await tx.delete(deliveryZonePincodes).where(eq(deliveryZonePincodes.zoneId, id));

    if (pincodes.length > 0) {
      await tx.insert(deliveryZonePincodes).values(
        pincodes.map((pincode) => ({
          zoneId: id,
          pincode,
          isServiceable: true,
          codAllowed: true,
        }))
      );
    }
  });
}
