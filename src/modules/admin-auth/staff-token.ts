import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';

const secret = new TextEncoder().encode(env.JWT_STAFF_SECRET);
const AUDIENCE = 'admin';

export type StaffClaims = {
  staffId: string;
  sessionId: string;
  role: string;
  permissions: ReadonlySet<string>;
};

/**
 * Staff tokens carry `aud: "admin"` and are signed with a DIFFERENT secret from
 * customer tokens. Both matter: a customer token can never be replayed against
 * an admin route even if the audience check were ever relaxed.
 *
 * Permissions are embedded so the hot path does not hit the database on every
 * request. The cost is that a revoked grant survives until the token expires —
 * which is why staff access tokens are 10 minutes, not 15.
 */
export async function signStaffToken(claims: StaffClaims): Promise<string> {
  return new SignJWT({
    sid: claims.sessionId,
    role: claims.role,
    perms: [...claims.permissions],
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.staffId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.JWT_STAFF_TTL)
    .sign(secret);
}

export async function verifyStaffToken(token: string): Promise<StaffClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: env.JWT_ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });

  const sub = payload.sub;
  const sid = payload.sid;
  const role = payload.role;
  const perms = payload.perms;

  if (typeof sub !== 'string' || typeof sid !== 'string' || typeof role !== 'string' || !Array.isArray(perms)) {
    throw new Error('Malformed staff token payload');
  }

  return {
    staffId: sub,
    sessionId: sid,
    role,
    permissions: new Set(perms.filter((p): p is string => typeof p === 'string')),
  };
}
