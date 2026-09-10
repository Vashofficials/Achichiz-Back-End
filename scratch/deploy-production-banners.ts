import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import fs from 'fs';
import path from 'path';

const bannersData = [
  {
    key: 'workspace',
    filename: 'hero-slider-workspace.webp',
    title: 'Sustainable Workspaces',
    subtitle: 'Eco-friendly desk essentials & daily lifestyle accessories',
    ctaLabel: 'Explore Workspace',
    collectionHandle: 'workspace-collection',
    position: 1,
    altText: 'Sustainable bamboo water bottle, cork diary, and executive desk accessories',
  },
  {
    key: 'earth-aroma',
    filename: 'hero-slider-earth-aroma.webp',
    title: 'Earth & Aroma Sanctuary',
    subtitle: 'Hand-poured soy wax candles & calming aromatherapy',
    ctaLabel: 'Discover Aromas',
    collectionHandle: 'earth-aroma-collection',
    position: 2,
    altText: 'Handcrafted coconut shell candles and botanical soy wax aroma sachets',
  },
  {
    key: 'jewellery',
    filename: 'hero-slider-jewellery.webp',
    title: 'Artisanal Adornments',
    subtitle: 'Handcrafted statement ethnic & modern jewellery',
    ctaLabel: 'View Jewellery',
    collectionHandle: 'jewellery-collection',
    position: 3,
    altText: 'Handcrafted temple jewellery, antique jhumkas, and chokers',
  },
  {
    key: 'gift-hampers',
    filename: 'hero-slider-gift-hampers.webp',
    title: 'Gifts Crafted with Care',
    subtitle: 'Thoughtful gift hampers for life’s memorable moments',
    ctaLabel: 'Shop Best Sellers',
    collectionHandle: 'best-sellers',
    position: 4,
    altText: 'Luxury curated gift hamper with bamboo drinkware, scented candle, and treats',
  },
  {
    key: 'corporate',
    filename: 'hero-slider-corporate.webp',
    title: 'Mindful Corporate Gifting',
    subtitle: 'Bespoke sustainable executive kits & client hampers',
    ctaLabel: 'Corporate Gifting',
    collectionHandle: 'corporate-connection',
    position: 5,
    altText: 'Executive bamboo tumbler, cork folder journal, and luxury pen corporate gift set',
  },
];

async function main() {
  console.log('--- Connecting to AWS S3 ---');
  const s3Client = new S3Client({
    region: env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
    },
    endpoint: env.S3_ENDPOINT || undefined,
  });

  const bucket = env.S3_BUCKET || 'achichiz-media';
  const baseUrl = env.S3_PUBLIC_BASE_URL || `https://${bucket}.s3.${env.AWS_REGION || 'ap-south-1'}.amazonaws.com`;
  const bannersDir = path.resolve('./scratch/optimized_banners');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch collection IDs
    console.log('--- Fetching Collection IDs ---');
    const handles = bannersData.map((b) => b.collectionHandle);
    const collectionsRes = await client.query(
      `SELECT id, handle FROM collections WHERE handle = ANY($1::text[])`,
      [handles]
    );
    const collectionMap = new Map<string, string>();
    for (const row of collectionsRes.rows) {
      collectionMap.set(row.handle, row.id);
    }
    console.log('Found collections:', Object.fromEntries(collectionMap));

    // 2. Upload to S3 & upsert media_assets
    const createdMedia = [];
    for (const b of bannersData) {
      const filePath = path.join(bannersDir, b.filename);
      const fileBuffer = fs.readFileSync(filePath);
      const storageKey = `banners/${b.filename}`;
      const s3Url = `${baseUrl}/${storageKey}`;

      console.log(`Uploading ${b.filename} (${fileBuffer.length} bytes) to S3 at ${storageKey}...`);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storageKey,
          Body: fileBuffer,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000',
        })
      );
      console.log(`✅ Uploaded to S3: ${s3Url}`);

      // Upsert media_assets
      const mediaRes = await client.query(
        `INSERT INTO media_assets (
          storage_key, url, filename, mime_type, kind, bytes, width_px, height_px, alt_text
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (storage_key) WHERE deleted_at IS NULL
        DO UPDATE SET
          url = EXCLUDED.url,
          bytes = EXCLUDED.bytes,
          width_px = EXCLUDED.width_px,
          height_px = EXCLUDED.height_px,
          alt_text = EXCLUDED.alt_text,
          updated_at = now()
        RETURNING id, url`,
        [
          storageKey,
          s3Url,
          b.filename,
          'image/webp',
          'image',
          fileBuffer.length,
          1920,
          1080,
          b.altText,
        ]
      );
      const mediaId = mediaRes.rows[0].id;
      createdMedia.push({ ...b, mediaId, url: s3Url });
    }

    // 3. Remove/Archive all existing homepage_hero banners
    console.log('--- Removing existing homepage_hero sliders ---');
    const deleteRes = await client.query(
      `DELETE FROM banners WHERE placement = 'homepage_hero'`
    );
    console.log(`Deleted ${deleteRes.rowCount} existing homepage_hero banners.`);

    // 4. Insert the 5 new production banners
    console.log('--- Inserting 5 new production banners ---');
    for (const item of createdMedia) {
      const collectionId = collectionMap.get(item.collectionHandle) || null;
      await client.query(
        `INSERT INTO banners (
          title, subtitle, placement, device, media_id, collection_id, cta_label, position, status, starts_at
        ) VALUES ($1, $2, 'homepage_hero', 'all', $3, $4, $5, $6, 'live', now())`,
        [
          item.title,
          item.subtitle,
          item.mediaId,
          collectionId,
          item.ctaLabel,
          item.position,
        ]
      );
      console.log(`✅ Inserted banner #${item.position}: "${item.title}" -> collection: ${item.collectionHandle}`);
    }

    await client.query('COMMIT');
    console.log('\n🎉 ALL 5 PRODUCTION BANNERS DEPLOYED SUCCESSFULLY!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Deployment failed, rolled back:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
