import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';

const secret = new TextEncoder().encode(env.JWT_CUSTOMER_SECRET);
const AUDIENCE = 'customer';

export type CustomerClaims = {
  customerId: string;
  sessionId: string;
};

export async function signCustomerToken(claims: CustomerClaims): Promise<string> {
  return new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.customerId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.JWT_CUSTOMER_TTL)
    .sign(secret);
}

export async function verifyCustomerToken(token: string): Promise<CustomerClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: env.JWT_ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });

  const sub = payload.sub;
  const sid = payload.sid;
  if (typeof sub !== 'string' || typeof sid !== 'string') {
    throw new Error('Malformed customer token payload');
  }
  return { customerId: sub, sessionId: sid };
}
