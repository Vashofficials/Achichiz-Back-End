import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../src/config/env.js';

async function main() {
  console.log('S3_BUCKET:', env.S3_BUCKET);
  console.log('AWS_REGION:', env.AWS_REGION);
  console.log('S3_PUBLIC_BASE_URL:', env.S3_PUBLIC_BASE_URL);

  const client = new S3Client({
    region: env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
    },
    endpoint: env.S3_ENDPOINT || undefined,
  });

  const testKey = 'test/ping.txt';
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: testKey,
        Body: Buffer.from('ping'),
        ContentType: 'text/plain',
      })
    );
    console.log('Successfully wrote to S3!');
  } catch (err: any) {
    console.error('S3 write failed:', err.message);
  }
}

main().catch(console.error);
