/**
 * Syncs the delivery zone pincodes array on save.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { deliveryZonePincodes, deliveryZones } from '../../db/schema/index.js';

export async function syncDeliveryZonePincodes(id: string, body: Record<string, unknown>): Promise<void> {
  let rawPins: string[] | undefined;
  if (Array.isArray(body.pincodes)) {
    rawPins = body.pincodes.map((p) => String(p).trim());
  } else if (typeof body.pincodes === 'string' && body.pincodes.trim().length > 0) {
    rawPins = body.pincodes.split(/[\s,]+/).map((p) => p.trim());
  }

  if (rawPins === undefined) return;

  const validPincodes = [...new Set(rawPins.filter((p) => /^\d{6}$/.test(p)))];

  // Lookup the zone's city and stateCode so pincodes inherit them
  const [zone] = await db
    .select({ city: deliveryZones.city, stateCode: deliveryZones.stateCode })
    .from(deliveryZones)
    .where(eq(deliveryZones.id, id))
    .limit(1);

  await db.transaction(async (tx) => {
    await tx.delete(deliveryZonePincodes).where(eq(deliveryZonePincodes.zoneId, id));

    for (const pincode of validPincodes) {
      await tx
        .insert(deliveryZonePincodes)
        .values({
          zoneId: id,
          pincode,
          city: zone?.city ?? 'Lucknow',
          stateCode: zone?.stateCode ?? '09',
          isServiceable: true,
          codAllowed: true,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: deliveryZonePincodes.pincode,
          set: {
            zoneId: id,
            city: zone?.city ?? 'Lucknow',
            stateCode: zone?.stateCode ?? '09',
            isServiceable: true,
            codAllowed: true,
            updatedAt: new Date(),
          },
        });
    }
  });
}
