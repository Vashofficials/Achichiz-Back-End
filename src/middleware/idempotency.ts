import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createHash } from 'node:crypto';
import { cache } from '../config/redis.js';
import { BadRequestError, ConflictError } from '../lib/errors.js';

/**
 * `Idempotency-Key` replay for money-moving POSTs.
 *
 * The problem this solves: a customer taps "Place order", the network stalls,
 * they tap again. Without this you have two orders and one confused customer.
 *
 * Semantics (Stripe-compatible):
 *  - First request with a key: reserve the key, run the handler, store the response.
 *  - Replay with the same key AND the same body: return the stored response verbatim.
 *  - Replay with the same key but a DIFFERENT body: 409. The client has a bug,
 *    and silently returning the first response would hide it.
 *  - Replay while the first is still in flight: 409, retry shortly.
 */
const TTL_SECONDS = 24 * 60 * 60;
const key = (scope: string, k: string): string => `idem:${scope}:${k}`;

type Stored = { status: number; body: unknown; fingerprint: string };

const fingerprintOf = (req: Request): string =>
  createHash('sha256')
    .update(JSON.stringify({ path: req.path, body: (req.body as unknown) ?? null }))
    .digest('hex');

export function idempotency(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;

    if (!idempotencyKey) {
      next(
        new BadRequestError(
          'An Idempotency-Key header is required for this endpoint. Use a UUID, and reuse it when retrying.',
        ),
      );
      return;
    }
    if (idempotencyKey.length < 8 || idempotencyKey.length > 255) {
      next(new BadRequestError('Idempotency-Key must be between 8 and 255 characters.'));
      return;
    }

    const scope = req.auth?.kind === 'customer' ? req.auth.customerId : 'anon';
    const redisKey = key(scope, idempotencyKey);
    const fingerprint = fingerprintOf(req);

    const existing = await cache.get(redisKey);
    if (existing) {
      const stored = JSON.parse(existing) as Stored | { pending: true };

      if ('pending' in stored) {
        next(new ConflictError('A request with this Idempotency-Key is still being processed. Retry shortly.'));
        return;
      }
      if (stored.fingerprint !== fingerprint) {
        next(
          new ConflictError(
            'This Idempotency-Key was already used with a different request body. Use a new key for a new request.',
          ),
        );
        return;
      }
      res.setHeader('Idempotent-Replay', 'true');
      res.status(stored.status).json(stored.body);
      return;
    }

    // Reserve. NX so two concurrent first-attempts cannot both proceed.
    const reserved = await cache.set(redisKey, JSON.stringify({ pending: true }), 'EX', 300, 'NX');
    if (reserved === null) {
      next(new ConflictError('A request with this Idempotency-Key is already in flight. Retry shortly.'));
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void cache.set(
          redisKey,
          JSON.stringify({ status: res.statusCode, body, fingerprint } satisfies Stored),
          'EX',
          TTL_SECONDS,
        );
      } else {
        // Failed — release the key so a corrected retry is allowed.
        void cache.del(redisKey);
      }
      return originalJson(body);
    };

    next();
  };
}
