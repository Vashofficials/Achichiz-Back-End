import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { UnauthenticatedError, UnprocessableError } from '../../lib/errors.js';

export async function signInWithPassword(email: string, password: string): Promise<{ localId: string; email: string }> {
  if (!env.FIREBASE_API_KEY) {
    throw new Error('FIREBASE_API_KEY is required for password authentication.');
  }

  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_API_KEY}`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });

  const data = (await res.json()) as any;
  if (!res.ok) {
    logger.warn({ error: data.error }, 'auth.firebase_rest_login_failed');
    throw new UnauthenticatedError('That email and password combination is not valid.');
  }

  return { localId: data.localId, email: data.email };
}

export async function sendPasswordResetEmail(email: string): Promise<void> {
  if (!env.FIREBASE_API_KEY) {
    throw new Error('FIREBASE_API_KEY is required for sending password reset emails.');
  }

  const url = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${env.FIREBASE_API_KEY}`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
  });

  if (!res.ok) {
    const data = (await res.json()) as any;
    logger.warn({ error: data.error, email }, 'auth.firebase_rest_reset_failed');
    // We don't throw here to avoid email enumeration, just log it.
  }
}

export async function confirmPasswordReset(oobCode: string, newPassword: string): Promise<{ email: string }> {
  if (!env.FIREBASE_API_KEY) {
    throw new Error('FIREBASE_API_KEY is required for password resets.');
  }

  const url = `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${env.FIREBASE_API_KEY}`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oobCode, newPassword }),
  });

  const data = (await res.json()) as any;
  if (!res.ok) {
    logger.warn({ error: data.error }, 'auth.firebase_rest_confirm_reset_failed');
    throw new UnprocessableError('That reset link is invalid or has expired.');
  }

  return { email: data.email };
}
