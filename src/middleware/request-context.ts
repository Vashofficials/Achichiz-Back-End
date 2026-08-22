import type { NextFunction, Request, Response } from 'express';
import { ulid } from 'ulid';
import { requestContext } from '../config/logger.js';

const REQUEST_ID_HEADER = 'x-request-id';
/** Accept an inbound id only if it looks sane — never echo arbitrary client input into logs. */
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const requestId = candidate && SAFE_ID.test(candidate) ? candidate : ulid();

  req.requestId = requestId;
  req.valid = { params: {}, query: {}, body: {} };
  req.auth = undefined;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  requestContext.run({ requestId }, () => next());
}
