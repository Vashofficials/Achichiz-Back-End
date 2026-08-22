import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { ValidationError, type FieldIssue } from '../lib/errors.js';

type Schemas = {
  params?: ZodType | undefined;
  query?: ZodType | undefined;
  body?: ZodType | undefined;
};

const toIssues = (error: { issues: readonly { path: PropertyKey[]; code: string; message: string }[] }, prefix: string): FieldIssue[] =>
  error.issues.map((i) => ({
    path: [prefix, ...i.path.map(String)].filter(Boolean).join('.').replace(/^(params|query|body)\./, ''),
    code: i.code,
    message: i.message,
  }));

/**
 * Parses into `req.valid` rather than mutating `req.params/query/body`.
 *
 * Two reasons: Express 5 makes `req.query` a getter that cannot be assigned, and
 * keeping the parsed value separate means a handler reading `req.valid.body` is
 * provably reading validated, coerced, stripped data — not whatever the client sent.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const issues: FieldIssue[] = [];

    if (schemas.params) {
      const r = schemas.params.safeParse(req.params);
      if (r.success) req.valid.params = r.data;
      else issues.push(...toIssues(r.error, 'params'));
    }

    if (schemas.query) {
      const r = schemas.query.safeParse(req.query);
      if (r.success) req.valid.query = r.data;
      else issues.push(...toIssues(r.error, 'query'));
    }

    if (schemas.body) {
      const r = schemas.body.safeParse(req.body);
      if (r.success) req.valid.body = r.data;
      else issues.push(...toIssues(r.error, 'body'));
    }

    if (issues.length > 0) {
      next(
        new ValidationError(`${issues.length} field${issues.length === 1 ? ' is' : 's are'} invalid.`, {
          issues,
        }),
      );
      return;
    }

    next();
  };
}
