import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { cache } from '../src/config/redis.js';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('🚀 Starting S3 upload and Database binding for 54 products...');

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
  const localDir = path.resolve('scratch/optimized_products');
  const files = fs.readdirSync(localDir);

  // 1. Upload to S3
  console.log(`\n--- Uploading ${files.length} images to S3 (${bucket}/products/) ---`);
  for (const f of files) {
    const filePath = path.join(localDir, f);
    const body = fs.readFileSync(filePath);
    const key = `products/${f}`;
    console.log(`Uploading ${f} (${body.length} B) to ${key}...`);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000',
      })
    );
  }

  // Also upload chain-pendant-set.webp (alias with 'a')
  const chainPendantBody = fs.readFileSync(path.join(localDir, 'chain-pendent-set.webp'));
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: 'products/chain-pendant-set.webp',
      Body: chainPendantBody,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000',
    })
  );
  console.log('Uploaded products/chain-pendant-set.webp alias');

  // 2. Bind to Database
  console.log('\n--- Binding products in PostgreSQL ---');
  const parsed = JSON.parse(fs.readFileSync('scratch/inventory_products_parsed.json', 'utf-8'));
  let updatedCount = 0;

  for (const p of parsed) {
    let handle = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    
    // Check product in DB
    let prodRes = await pool.query('SELECT id, handle, title FROM products WHERE handle = $1', [handle]);
    if (prodRes.rows.length === 0) {
      // Try replacing -pendent- with -pendant-
      const altHandle = handle.replace('-pendent-', '-pendant-');
      prodRes = await pool.query('SELECT id, handle, title FROM products WHERE handle = $1', [altHandle]);
      if (prodRes.rows.length > 0) {
        handle = altHandle;
      }
    }

    if (prodRes.rows.length === 0) {
      console.warn(`⚠️ Could not find product with handle "${handle}" in DB!`);
      continue;
    }

    const prod = prodRes.rows[0];
    const imageFilename = `${handle}.webp`;
    const imageLocalPath = fs.existsSync(path.join(localDir, imageFilename))
      ? path.join(localDir, imageFilename)
      : path.join(localDir, `${handle.replace('-pendant-', '-pendent-')}.webp`);

    const imageBytes = fs.existsSync(imageLocalPath) ? fs.statSync(imageLocalPath).size : 25000;
    const s3Url = `${baseUrl}/products/${imageFilename}`;
    const storageKey = `products/${imageFilename}`;

    // Check if media_asset exists
    const existingMedia = await pool.query(
      'SELECT id FROM media_assets WHERE storage_key = $1 AND deleted_at IS NULL LIMIT 1',
      [storageKey]
    );

    let mediaId: string;
    if (existingMedia.rows.length > 0) {
      mediaId = existingMedia.rows[0].id;
      await pool.query(
        'UPDATE media_assets SET url = $1, bytes = $2, alt_text = $3, updated_at = NOW() WHERE id = $4',
        [s3Url, imageBytes, prod.title, mediaId]
      );
    } else {
      const insertRes = await pool.query(
        `INSERT INTO media_assets (storage_key, url, filename, mime_type, kind, bytes, alt_text)
         VALUES ($1, $2, $3, 'image/webp', 'image', $4, $5)
         RETURNING id`,
        [storageKey, s3Url, imageFilename, imageBytes, prod.title]
      );
      mediaId = insertRes.rows[0].id;
    }

    // Remove old media links
    await pool.query('DELETE FROM product_media WHERE product_id = $1', [prod.id]);

    // Insert new primary media
    await pool.query(`
      INSERT INTO product_media (product_id, media_id, position, alt_text)
      VALUES ($1, $2, 0, $3);
    `, [prod.id, mediaId, prod.title]);

    // If this is chain-pendant-set, insert the 3 extra gallery angles!
    if (handle.includes('chain-pendant') || handle.includes('chain-pendent')) {
      console.log(`Attaching 3 extra gallery angles for ${handle}...`);
      for (let angle = 1; angle <= 3; angle++) {
        const angleFilename = `chain-pendant-set-${angle}.webp`;
        const angleBytes = fs.statSync(path.join(localDir, angleFilename)).size;
        const angleStorageKey = `products/${angleFilename}`;
        const angleUrl = `${baseUrl}/products/${angleFilename}`;

        const existingAngle = await pool.query(
          'SELECT id FROM media_assets WHERE storage_key = $1 AND deleted_at IS NULL LIMIT 1',
          [angleStorageKey]
        );

        let angleMediaId: string;
        if (existingAngle.rows.length > 0) {
          angleMediaId = existingAngle.rows[0].id;
          await pool.query(
            'UPDATE media_assets SET url = $1, bytes = $2, alt_text = $3, updated_at = NOW() WHERE id = $4',
            [angleUrl, angleBytes, `${prod.title} Detail ${angle}`, angleMediaId]
          );
        } else {
          const insertAngle = await pool.query(
            `INSERT INTO media_assets (storage_key, url, filename, mime_type, kind, bytes, alt_text)
             VALUES ($1, $2, $3, 'image/webp', 'image', $4, $5)
             RETURNING id`,
            [angleStorageKey, angleUrl, angleFilename, angleBytes, `${prod.title} Detail ${angle}`]
          );
          angleMediaId = insertAngle.rows[0].id;
        }

        await pool.query(`
          INSERT INTO product_media (product_id, media_id, position, alt_text)
          VALUES ($1, $2, $3, $4);
        `, [prod.id, angleMediaId, angle, `${prod.title} Angle ${angle}`]);
      }
    }

    updatedCount++;
    console.log(`[${updatedCount}/54] Attached media to "${prod.title}" (${handle}) -> ${s3Url}`);
  }

  // 3. Clear Redis Cache
  console.log('\n--- Clearing Redis catalogue cache ---');
  try {
    const keys = await cache.keys('cat:v1:*');
    if (keys.length > 0) {
      await cache.del(...keys);
      console.log(`Cleared ${keys.length} cache keys from Redis.`);
    } else {
      console.log('No cache keys to clear.');
    }
  } catch (e) {
    console.warn('Redis cache clear warning:', e);
  }

  console.log(`\n🎉 Successfully uploaded all images to S3 and updated ${updatedCount} products in DB!`);
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
