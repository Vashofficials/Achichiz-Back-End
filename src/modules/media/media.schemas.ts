import { z } from 'zod';

export const mediaAssetSummary = z.object({
  id: z.string().uuid(),
  url: z.string(),
  cdnUrl: z.string().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  kind: z.enum(['image', 'video', 'pdf', 'other']),
  bytes: z.number(),
  widthPx: z.number().nullable(),
  heightPx: z.number().nullable(),
  createdAt: z.string(),
});

export type MediaAssetSummary = z.infer<typeof mediaAssetSummary>;
