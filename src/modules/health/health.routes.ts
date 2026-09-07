import { Router } from 'express';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { cache } from '../../config/redis.js';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, raw } from '../../lib/http.js';

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
  description:
    'Returns 200 whenever the process is running. Deliberately does NOT touch the database — a liveness probe that fails on a DB blip gets your healthy container killed during an outage.',
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
  description:
    'Checks Postgres and Redis. Returns 503 when a dependency is down so the load balancer stops sending traffic without the container being restarted.',
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

