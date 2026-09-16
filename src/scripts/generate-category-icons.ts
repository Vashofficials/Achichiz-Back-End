import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { db } from '../config/db.js';
import { collections, mediaAssets } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

const s3Client = new S3Client({
  region: env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
  },
  endpoint: env.S3_ENDPOINT || undefined,
  forcePathStyle: !!env.S3_ENDPOINT,
});

const MAX_BYTES = 30 * 1024; // 30 KB limit

async function compressUnder30Kb(inputPath: string): Promise<{ buffer: Buffer; bytes: number }> {
  let quality = 80;
  let buffer = await sharp(inputPath)
    .resize(400, 400, { fit: 'cover', position: 'center' })
    .webp({ quality })
    .toBuffer();

  while (buffer.length > MAX_BYTES && quality > 20) {
    quality -= 10;
    buffer = await sharp(inputPath)
      .resize(400, 400, { fit: 'cover', position: 'center' })
      .webp({ quality })
      .toBuffer();
  }

  if (buffer.length > MAX_BYTES) {
    // If still > 30kb, resize slightly smaller
    buffer = await sharp(inputPath)
      .resize(320, 320, { fit: 'cover', position: 'center' })
      .webp({ quality: 65 })
      .toBuffer();
  }

  return { buffer, bytes: buffer.length };
}

async function uploadToS3(storageKey: string, buffer: Buffer, contentType: string): Promise<string> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: storageKey,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000',
    })
  );

  return env.S3_PUBLIC_BASE_URL
    ? `${env.S3_PUBLIC_BASE_URL}/${storageKey}`
    : `https://${env.S3_BUCKET}.s3.${env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${storageKey}`;
}

async function createMediaAsset(storageKey: string, url: string, filename: string, bytes: number) {
  const [asset] = await db
    .insert(mediaAssets)
    .values({
      storageKey,
      url,
      cdnUrl: url,
      filename,
      mimeType: 'image/webp',
      kind: 'image',
      bytes,
      widthPx: 400,
      heightPx: 400,
      folder: 'category-icons',
    })
    .returning();
  if (!asset) throw new Error(`Failed to insert media asset ${filename}`);
  return asset;
}

async function main() {
  console.log('=== GENERATING & OPTIMIZING CATEGORY ICONS UNDER 30KB ===\n');

  const artifactDir = 'C:\\Users\\terab\\.gemini\\antigravity-ide\\brain\\c70b7c50-8160-45b8-bef4-38a302b533f4';
  const compressRoot = 'C:\\Achichiz\\40 KB compress image';

  // Define Category specifications
  const categoryDefs = [
    // 1. Root Collections
    {
      handle: 'jewellery-collection',
      title: 'Jewellery Collection',
      kind: 'category',
      parentId: null,
      sourceImage: path.join(artifactDir, 'jewellery_collection_icon_1789541083522.jpg'),
    },
    {
      handle: 'workspace-collection',
      title: 'Workspace Collection',
      kind: 'category',
      parentId: null,
      sourceImage: path.join(artifactDir, 'workspace_collection_icon_1789541101246.jpg'),
    },
    {
      handle: 'earth-aroma-collection',
      title: 'Earth & Aroma Collection',
      kind: 'category',
      parentId: null,
      sourceImage: path.join(artifactDir, 'earth_aroma_icon_1789541125001.jpg'),
    },

    // 2. Subcategories under Jewellery Collection
    {
      handle: 'necklaces-long',
      title: 'Necklaces (Long)',
      kind: 'category',
      parentHandle: 'jewellery-collection',
      sourceImage: path.join(compressRoot, 'jewellery collection', 'Black long necklace', 'img 2 (6).jpeg'),
    },
    {
      handle: 'necklace-set-long',
      title: 'Necklace Set Long',
      kind: 'category',
      parentHandle: 'jewellery-collection',
      sourceImage: path.join(compressRoot, 'jewellery collection', 'Necklace set lavender', 'IMG 2 (3).jpeg'),
    },
    {
      handle: 'short-necklace-set',
      title: 'Short Necklace Set',
      kind: 'category',
      parentHandle: 'jewellery-collection',
      sourceImage: path.join(compressRoot, 'jewellery collection', 'golden triangular necklace', 'img 2 (1).jpeg'),
    },
    {
      handle: 'temple-jewellery',
      title: 'Temple Jewellery',
      kind: 'category',
      parentHandle: 'jewellery-collection',
      sourceImage: path.join(compressRoot, 'jewellery collection', 'green golden blue necklace', 'img 2.jpeg'),
    },
    {
      handle: 'drop-earring',
      title: 'Drop Earring',
      kind: 'category',
      parentHandle: 'jewellery-collection',
      sourceImage: path.join(compressRoot, 'jewellery collection', 'Floral Earrings daisy', 'img 2 (12).jpeg'),
    },
    {
      handle: 'jhumkas',
      title: 'Jhumkas',
      kind: 'category',
      parentHandle: 'jewellery-collection',
      sourceImage: path.join(compressRoot, 'jewellery collection', 'Bird jhumka', 'img 2.jpeg'),
    },
    {
      handle: 'danglers',
      title: 'Danglers',
      kind: 'category',
      parentHandle: 'jewellery-collection',
      sourceImage: path.join(compressRoot, 'jewellery collection', 'Black & Blue earrings', 'img 2 (1).jpeg'),
    },

    // 3. Subcategories under Workspace Collection
    {
      handle: 'all-bamboo-product-workspace-collection',
      title: 'All Bamboo Product (Workspace Collection)',
      kind: 'category',
      parentHandle: 'workspace-collection',
      sourceImage: path.join(compressRoot, 'Workspace collection', 'Bamboo bottle', 'img 2.jpeg'),
    },

    // 4. Subcategories under Earth & Aroma Collection
    {
      handle: 'all-candle-product-earth-aroma-collection',
      title: 'All Candle Product (Earth & Aroma Collection)',
      kind: 'category',
      parentHandle: 'earth-aroma-collection',
      sourceImage: path.join(compressRoot, 'Earth and aroma collection', 'coconut shell rose candle', 'image 2 (4).jpg'),
    },
  ];

  const parentMap: Record<string, string> = {};

  // First pass: Process roots and get their IDs
  for (const cat of categoryDefs) {
    if (!fs.existsSync(cat.sourceImage)) {
      console.error(`Source image missing for ${cat.handle}: ${cat.sourceImage}`);
      continue;
    }

    console.log(`Processing icon for "${cat.title}" (${cat.handle})...`);
    const { buffer, bytes } = await compressUnder30Kb(cat.sourceImage);
    const sizeKb = (bytes / 1024).toFixed(2);
    console.log(`  ✓ Compressed to WebP: ${sizeKb} KB (Under 30KB: ${bytes < MAX_BYTES})`);

    // Upload to S3
    const storageKey = `collections/icons/${cat.handle}.webp`;
    const url = await uploadToS3(storageKey, buffer, 'image/webp');
    console.log(`  ✓ Uploaded to S3: ${url}`);

    // Insert Media Asset
    const asset = await createMediaAsset(storageKey, url, `${cat.handle}.webp`, bytes);

    // Get parentId if applicable
    let parentId: string | null = null;
    if (cat.parentHandle) {
      parentId = parentMap[cat.parentHandle] || null;
      if (!parentId) {
        const [pRow] = await db
          .select({ id: collections.id })
          .from(collections)
          .where(eq(collections.handle, cat.parentHandle));
        parentId = pRow?.id || null;
      }
    }

    // Upsert Collection
    const existing = await db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.handle, cat.handle));

    let colId: string;
    const existingRow = existing[0];
    if (existingRow) {
      colId = existingRow.id;
      await db
        .update(collections)
        .set({
          title: cat.title,
          kind: 'category',
          parentId: parentId ?? undefined,
          heroMediaId: asset.id,
          status: 'live',
        })
        .where(eq(collections.id, colId));
      console.log(`  ✓ Updated existing collection with heroMediaId: ${colId}`);
    } else {
      const [newCol] = await db
        .insert(collections)
        .values({
          handle: cat.handle,
          title: cat.title,
          kind: 'category',
          parentId,
          heroMediaId: asset.id,
          status: 'live',
        })
        .returning();
      if (!newCol) throw new Error(`Failed to create collection ${cat.handle}`);
      colId = newCol.id;
      console.log(`  ✓ Created new collection with heroMediaId: ${colId}`);
    }

    parentMap[cat.handle] = colId;
  }

  console.log('\n=== CATEGORY ICONS GENERATED, COMPRESSED (<30KB), & LINKED SUCCESSFULLY ===\n');
}

main()
  .catch((err) => {
    console.error('Fatal category icons error:', err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
