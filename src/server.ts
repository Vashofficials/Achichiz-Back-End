import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDb } from './config/db.js';
import { closeRedis } from './config/redis.js';

const app = createApp();
const server = createServer(app);

server.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, docs: `${env.API_PUBLIC_URL}/docs` },
    'achichiz-api listening',
  );
});

/**
 * Graceful shutdown.
 *
 * Order matters: stop accepting new connections, let in-flight requests finish,
 * THEN close the pool. Closing the pool first turns every in-flight request into
 * a 500 — including, on a bad day, one that is halfway through capturing a payment.
 */
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const forced = setTimeout(() => {
    logger.error('graceful shutdown timed out after 15s, forcing exit');
    process.exit(1);
  }, 15_000);
  forced.unref();

  // `close` takes a void callback, so the async work goes in an explicitly-voided
  // IIFE rather than making the callback itself async — an async callback here
  // returns a floating promise that Node never awaits, so a cleanup failure would
  // be swallowed instead of logged.
  server.close((err) => {
    if (err) logger.error({ err }, 'error closing http server');
    void (async () => {
      try {
        await closeDb();
        await closeRedis();
        logger.info('shutdown complete');
        process.exit(err ? 1 : 0);
      } catch (closeErr) {
        logger.error({ err: closeErr }, 'error during resource cleanup');
        process.exit(1);
      }
    })();
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Log loudly, but do NOT exit.
 *
 * This used to call shutdown(), and a live boot test proved that wrong: Redis was
 * unreachable, the rate-limit store rejected, the rejection arrived here, and the
 * whole API died — because of a cache blip, on a request that should simply have
 * returned 401.
 *
 * A stray rejection is almost always a missed `.catch()` on one request, not
 * process-wide corruption. Killing the server drops every in-flight request with
 * it, and on this service some of those are mid-payment. Page on the alert; do
 * not take down checkout.
 */
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection — investigate, process kept alive');
});

/**
 * uncaughtException IS different: the stack unwound through unknown code and
 * process state can no longer be trusted, so fail fast and let the orchestrator
 * restart us. Graceful shutdown still drains in-flight requests first.
 */
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception — shutting down');
  shutdown('uncaughtException');
});
