import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../src/config/env.js';
import fs from 'fs';
import path from 'path';

async function uploadFolder(localDir: string, s3Prefix: string) {
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
  const files = fs.readdirSync(localDir);

  for (const f of files) {
    const filePath = path.join(localDir, f);
    const body = fs.readFileSync(filePath);
    const key = `${s3Prefix}/${f}`;
    console.log(`Uploading ${f} (${body.length} bytes) to ${key}...`);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000',
      })
    );
    console.log(`✅ Uploaded to ${baseUrl}/${key}`);
  }
}

async function main() {
  console.log('--- Uploading subcategories to S3 ---');
  await uploadFolder(path.resolve('./scratch/optimized_subcategories'), 'subcategories');

  console.log('\n--- Uploading categories to S3 ---');
  await uploadFolder(path.resolve('./scratch/optimized_categories'), 'categories');

  console.log('\n🎉 ALL S3 UPLOADS COMPLETED!');
}

main().catch(console.error);
