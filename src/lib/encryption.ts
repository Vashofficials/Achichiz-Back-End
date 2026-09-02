import crypto from 'crypto';
import { env } from '../config/env.js';

const ENCRYPTION_KEY = Buffer.from(
  process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64'),
  'base64'
);
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export function encryptString(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  
  // Format: iv:authTag:encryptedData
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decryptString(encryptedText: string): string {
  try {
    const parts = encryptedText.split(':');
    const ivHex = parts[0] as string;
    const authTagHex = parts[1] as string;
    const encryptedData = parts[2] as string;
    
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (err) {
    // Return original string if decryption fails (e.g. if key changed or data was plain)
    return encryptedText;
  }
}
