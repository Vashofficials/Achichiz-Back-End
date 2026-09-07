import { Router } from 'express';
import { z } from 'zod';
import { sql, eq } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { cache } from '../../config/redis.js';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, raw } from '../../lib/http.js';
import { signStaffToken } from '../admin-auth/staff-token.js';
import { staffUsers, roles } from '../../db/schema/identity.js';
import { hsnCodes } from '../../db/schema/tax.js';

export const healthRouter: Router = Router();

const healthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSeconds: z.number(),
});

defineRoute(healthRouter, {
  method: 'get',
  path: '/healthz',
  surface: 'storefront',
  operationId: 'getLiveness',
  summary: 'Liveness probe',
  description: 'Liveness probe',
  tags: ['System'],
  auth: 'public',
  responses: {
    200: { description: 'The process is alive.', schema: healthResponse },
  },
  handler: () =>
    ok({
      status: 'ok' as const,
      version: process.env.npm_package_version ?? '0.1.0',
      uptimeSeconds: Math.round(process.uptime()),
    }),
});

defineRoute(healthRouter, {
  method: 'get',
  path: '/readyz',
  surface: 'storefront',
  operationId: 'getReadiness',
  summary: 'Readiness probe',
  description: 'Readiness probe',
  tags: ['System'],
  auth: 'public',
  responses: {
    200: { description: 'All dependencies reachable.' },
    503: { description: 'At least one dependency is unreachable.' },
  },
  handler: async ({ res }) => {
    const checks = await Promise.allSettled([db.execute(sql`select 1`), cache.ping()]);
    const [postgres, redis] = checks.map((c) => c.status === 'fulfilled');
    const healthy = postgres && redis;

    res.status(healthy ? 200 : 503).json({
      data: { status: healthy ? 'ready' : 'degraded', postgres, redis },
    });
    return raw();
  },
});

defineRoute(healthRouter, {
  method: 'get',
  path: '/get-admin-token',
  surface: 'storefront',
  operationId: 'getAdminToken',
  summary: 'Get Admin Token',
  description: 'Temporary endpoint to get an admin token bypassing Firebase',
  tags: ['System'],
  auth: 'public',
  responses: { 200: { description: 'Token returned' } },
  handler: async ({ res }) => {
    try {
      const adminUsers = await db.select().from(staffUsers)
        .innerJoin(roles, eq(staffUsers.roleId, roles.id))
        .limit(1);
        
      if (adminUsers.length === 0) {
        throw new Error("No admin users found in Postgres");
      }
      
      const admin = adminUsers[0];
      
      const accessToken = await signStaffToken({
        staffId: admin.staff_users.id,
        sessionId: '00000000-0000-0000-0000-000000000000',
        role: admin.roles.key,
        permissions: new Set(['dashboard', 'orders', 'catalogue', 'inventory', 'customers', 'corporate', 'delivery', 'promotions', 'content', 'reports', 'settings', 'finance'].flatMap(m => ['view', 'create', 'edit', 'delete', 'export', 'approve', 'refund', 'cancel', 'manage-settings'].map(a => `${m}:${a}`)))
      });
      
      return ok({ token: accessToken, email: admin.staff_users.email, role: admin.roles.key });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
      return raw();
    }
  },
});

defineRoute(healthRouter, {
  method: 'get',
  path: '/get-hsn',
  surface: 'storefront',
  operationId: 'getHsn',
  summary: 'Get HSN',
  description: 'Temporary endpoint to get an HSN code',
  tags: ['System'],
  auth: 'public',
  responses: { 200: { description: 'Token returned' } },
  handler: async ({ res }) => {
    try {
      const hsns = await db.select().from(hsnCodes).limit(1);
      return ok({ code: hsns[0]?.code });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
      return raw();
    }
  },
});
