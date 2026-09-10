import { db } from '../../config/db.js';
import { appSettings } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import type { Tx } from '../../config/db.js';

/**
 * Get the JSON value for a specific settings group.
 * If not found, returns an empty object.
 */
export async function getSettingsGroup(key: string, tx: any = db): Promise<Record<string, any>> {
  const [row] = await tx
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key));

  return row ? (row.value as Record<string, any>) : {};
}

/**
 * Upsert the JSON value for a specific settings group.
 */
export async function upsertSettingsGroup(
  key: string,
  value: any,
  actorId: string,
  isPublic?: boolean,
  tx: any = db
): Promise<any> {
  const [row] = await tx
    .insert(appSettings)
    .values({
      key,
      value,
      updatedBy: actorId,
      ...(isPublic !== undefined ? { isPublic } : {}),
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value,
        updatedBy: actorId,
        updatedAt: new Date(),
        ...(isPublic !== undefined ? { isPublic } : {}),
      },
    })
    .returning({ value: appSettings.value });

  return row?.value ?? null;
}

