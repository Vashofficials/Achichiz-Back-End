import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';
import * as repo from './media.repository.js';
import { ulid } from 'ulid';
import { UnprocessableError, UpstreamError } from '../../lib/errors.js';

let s3Client: S3Client | null = null;

function getS3Client() {
  if (!s3Client) {
    if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY || !env.S3_BUCKET) {
      throw new Error('S3 is not configured in this environment.');
    }
    s3Client = new S3Client({
      region: env.AWS_REGION || 'ap-south-1',
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: !!env.S3_ENDPOINT,
    });
  }
  return s3Client;
}

function getMediaKind(mimeType: string): 'image' | 'video' | 'pdf' | 'other' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'other';
}

export async function uploadMedia(file: Express.Multer.File, staffUserId: string | null) {
  // Use ULID for sortable, unique storage keys
  const extension = file.originalname.includes('.') 
    ? `.${file.originalname.split('.').pop()}` 
    : '';
  const storageKey = `uploads/${ulid()}${extension}`;

  let url: string;
  if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET) {
    const client = getS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: storageKey,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000',
      })
    );

    url = env.S3_PUBLIC_BASE_URL 
      ? `${env.S3_PUBLIC_BASE_URL}/${storageKey}`
      : `https://${env.S3_BUCKET}.s3.${env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${storageKey}`;
  } else {
    // Local development only. A data: URL is stored inline in `media_assets.url` and then
    // shipped in every catalogue response that references it, so it is refused where it
    // would do real damage: in production (an unconfigured bucket must fail loudly, not
    // quietly bloat the database), and for video (a 50 MB clip becomes a 67 MB text column).
    if (env.isProduction) {
      throw new UpstreamError('Media storage is not configured on this server (S3 bucket/credentials missing).');
    }
    if (getMediaKind(file.mimetype) === 'video') {
      throw new UnprocessableError(
        'Video upload needs S3 storage, which is not configured in this environment.',
        'media_storage_unavailable',
      );
    }
    url = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  }

  const asset = await repo.insertMediaAsset({
    storageKey,
    url,
    filename: file.originalname,
    mimeType: file.mimetype,
    kind: getMediaKind(file.mimetype),
    bytes: file.size,
    uploadedBy: staffUserId,
  });

  return {
    id: asset.id,
    url: asset.url,
    cdnUrl: asset.cdnUrl,
    filename: asset.filename,
    mimeType: asset.mimeType,
    kind: asset.kind,
    bytes: asset.bytes,
    widthPx: asset.widthPx,
    heightPx: asset.heightPx,
    createdAt: asset.createdAt.toISOString(),
  };
}
