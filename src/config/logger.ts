import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger } from 'pino';
import { env } from './env.js';

export type RequestContext = {
  requestId: string;
  /** Set once authenticate() has run. */
  actorId?: string;
  actorKind?: 'customer' | 'staff';
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Redaction is central and non-negotiable. A secret that reaches a log line is a
 * secret in every downstream log sink, forever.
 */
export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.otp',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
      '*.razorpay_signature',
      '*.razorpaySignature',
      '*.card',
      '*.cvv',
      'body.password',
      'body.otp',
    ],
    censor: '[redacted]',
  },
  base: { service: 'achichiz-api' },
  // Attach the request id to every line emitted inside a request.
  mixin() {
    const ctx = requestContext.getStore();
    return ctx ? { requestId: ctx.requestId, actorId: ctx.actorId, actorKind: ctx.actorKind } : {};
  },
  transport: env.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
});
