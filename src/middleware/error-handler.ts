import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { isAppError } from '../lib/errors.js';

const ERROR_BASE = 'https://api.achichiz.com/errors';

/** Postgres error codes we can turn into a decent client message. */
const PG_CODES: Record<string, { status: number; code: string; title: string }> = {
  '23505': { status: 409, code: 'already_exists', title: 'Already exists' },
  '23503': { status: 409, code: 'referenced_record_missing', title: 'Referenced record missing' },
  '23514': { status: 422, code: 'constraint_violated', title: 'Constraint violated' },
  '40001': { status: 409, code: 'serialization_failure', title: 'Concurrent update, please retry' },
  '40P01': { status: 409, code: 'deadlock_detected', title: 'Concurrent update, please retry' },
  '57014': { status: 504, code: 'statement_timeout', title: 'Query timed out' },
};

const pgCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err && typeof (err).code === 'string'
    ? err.code
    : undefined;

export function notFoundHandler(req: Request, res: Response): void {
  res
    .status(404)
    .type('application/problem+json')
    .json({
      type: `${ERROR_BASE}/route-not-found`,
      title: 'Route not found',
      status: 404,
      code: 'route_not_found',
      detail: `${req.method} ${req.path} is not an endpoint on this API.`,
      instance: req.originalUrl,
      requestId: req.requestId,
    });
}

/**
 * The terminal handler. The ONLY place in the codebase that knows about HTTP
 * status codes for errors.
 *
 * Note what is deliberately absent: `err.message` never reaches the client for a
 * non-AppError. That is how DB constraint text, file paths and connection
 * strings leak.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (isAppError(err)) {
    const e = err;
    const level = e.status >= 500 ? 'error' : 'warn';
    logger[level]({ err: e, status: e.status, code: e.code, ctx: e.context }, 'request failed');

    res
      .status(e.status)
      .type('application/problem+json')
      .json({
        type: `${ERROR_BASE}/${e.code.replace(/_/g, '-')}`,
        title: e.name.replace(/Error$/, '').replace(/([a-z])([A-Z])/g, '$1 $2') || 'Error',
        status: e.status,
        code: e.code,
        detail: e.message,
        instance: req.originalUrl,
        requestId: req.requestId,
        ...(e.issues ? { errors: e.issues } : {}),
      });
    return;
  }

  const mapped = PG_CODES[pgCode(err) ?? ''];
  if (mapped) {
    logger.warn({ err, pgCode: pgCode(err) }, 'database constraint failure');
    res
      .status(mapped.status)
      .type('application/problem+json')
      .json({
        type: `${ERROR_BASE}/${mapped.code.replace(/_/g, '-')}`,
        title: mapped.title,
        status: mapped.status,
        code: mapped.code,
        detail: 'The request conflicts with existing data.',
        instance: req.originalUrl,
        requestId: req.requestId,
      });
    return;
  }

  logger.error({ err }, 'unhandled error');

  res
    .status(500)
    .type('application/problem+json')
    .json({
      type: `${ERROR_BASE}/internal`,
      title: 'Internal server error',
      status: 500,
      code: 'internal_error',
      detail: 'Something went wrong on our end. Quote the requestId if you contact support.',
      instance: req.originalUrl,
      requestId: req.requestId,
      // Stack only outside production, and only ever for a genuinely unknown error.
      ...(env.isProduction ? {} : { stack: err instanceof Error ? err.stack : String(err) }),
    });
}
