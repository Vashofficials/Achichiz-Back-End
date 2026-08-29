import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet, { type HelmetOptions } from 'helmet';
import hpp from 'hpp';
// Named import, not default: pino-http is CJS and under NodeNext its callable
// export is only reachable as the named `pinoHttp` binding.
import { pinoHttp } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { requestContextMiddleware } from './middleware/request-context.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { namedLimiter } from './middleware/rate-limit.js';
import { mountSwagger } from './lib/openapi/swagger.js';
import { apiRouter } from './routes.js';

type HelmetCallable = (
  options?: Readonly<HelmetOptions>,
) => (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;

/**
 * Assembles the app. Deliberately does NOT call listen() — that lives in
 * server.ts, so tests can import this and drive it with supertest without
 * binding a port.
 */
export function createApp(): Express {
  const app = express();

  // Behind Netlify/Cloudflare/nginx. Without this, req.ip is the proxy and every
  // rate limit becomes global.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestContextMiddleware);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req: IncomingMessage) => (req as unknown as Request).requestId,
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: {
        // Probes and docs assets would otherwise dominate the log volume.
        ignore: (req: IncomingMessage) => {
          const url = req.url ?? '';
          return url.startsWith('/healthz') || url.startsWith('/readyz') || url.startsWith('/docs/');
        },
      },
    }),
  );

  const helmetMiddleware = (
    typeof helmet === 'function'
      ? helmet
      : (helmet as unknown as { default: HelmetCallable }).default
  ) as HelmetCallable;

  app.use(
    helmetMiddleware({
      // Swagger UI needs inline styles/scripts; it is the only HTML this API serves.
      contentSecurityPolicy: env.isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'https:'],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin, curl and server-to-server requests have no Origin header.
        if (!origin) return callback(null, true);
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        logger.warn({ origin }, 'CORS origin rejected');
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'X-Cart-Token'],
      exposedHeaders: ['X-Request-Id', 'X-Cart-Token', 'Idempotent-Replay', 'RateLimit'],
      maxAge: 86_400,
    }),
  );

  /**
   * Razorpay signs the RAW body. Parsing it to JSON first and re-serialising
   * changes the bytes and every signature check fails. So webhook routes get the
   * raw buffer, mounted before the JSON parser.
   */
  app.use(
    '/v1/webhooks',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req: Request, _res: Response, next: NextFunction) => {
      if (Buffer.isBuffer(req.body)) {
        req.rawBody = req.body;
        try {
          req.body = JSON.parse(req.body.toString('utf8')) as unknown;
        } catch {
          req.body = {};
        }
      }
      next();
    },
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(hpp());

  // Blanket limiter. Individual routes declare tighter named limiters.
  app.use('/v1', namedLimiter('default'));

  mountSwagger(app);

  /**
   * Mounted at ROOT, not at '/v1'.
   *
   * Every route declares its full path (`/v1/products/:handle`), so the string in
   * the OpenAPI document is the string Express matches — no prefix arithmetic,
   * and `tests/openapi-coverage.test.ts` can compare them literally. A mount
   * prefix would silently make every documented path wrong by exactly '/v1'.
   */
  app.use(apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
