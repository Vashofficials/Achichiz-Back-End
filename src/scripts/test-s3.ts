import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

async function main() {
  try {
    const client = new S3Client({
      region: env.AWS_REGION || 'ap-south-1',
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
      },
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: !!env.S3_ENDPOINT,
    });

    const res = await client.send(new ListObjectsV2Command({
      Bucket: env.S3_BUCKET,
      MaxKeys: 10,
    }));

    console.log('S3 Connection SUCCESS!');
    console.log('Bucket:', env.S3_BUCKET);
    console.log('KeyCount:', res.KeyCount);
    console.log('Sample Keys:', res.Contents?.map((c) => c.Key));
  } catch (err) {
    console.error('S3 Connection FAILED:', err);
  } finally {
    process.exit(0);
  }
}

main();
