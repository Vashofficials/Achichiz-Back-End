import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Two clients on purpose. BullMQ requires `maxRetriesPerRequest: null` and holds
 * blocking connections; sharing that client with the cache means a blocked
 * BRPOPLPUSH stalls every cache read behind it.
 */
/**
 * `lazyConnect: true` on both clients is deliberate, not an optimisation.
 *
 * Importing this module must not dial out. Tooling that only needs the route
 * declarations — `openapi:generate`, a unit test importing one service — pulls in
 * the whole module graph transitively. With eager connect those processes open a
 * socket and then never exit, because an open ioredis handle keeps the event loop
 * alive forever. The OpenAPI CI gate would hang on every build.
 *
 * The connection is established on first command instead. `readyz` is what
 * actually proves Redis is reachable.
 */
export const cache = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
  keyPrefix: 'ach:',
});

export const queueConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

for (const [name, client] of [
  ['cache', cache],
  ['queue', queueConnection],
] as const) {
  client.on('error', (err) => logger.error({ err, client: name }, 'redis error'));
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([cache.quit(), queueConnection.quit()]);
}
