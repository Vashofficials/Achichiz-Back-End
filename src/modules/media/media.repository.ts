import { eq } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { mediaAssets, type MediaKind } from '../../db/schema/content.js';

export async function insertMediaAsset(asset: {
  storageKey: string;
  url: string;
  filename: string;
  mimeType: string;
  kind: MediaKind;
  bytes: number;
  uploadedBy: string | null;
}) {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      ...asset,
      // For now we don't compute blurhash or dimensions in this pass
      widthPx: null,
      heightPx: null,
    })
    .returning();

  return row!;
}
