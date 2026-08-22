/**
 * Services throw these. Only `middleware/error-handler.ts` knows about HTTP.
 *
 * `code` is a STABLE machine-readable string — frontends switch on it. Changing
 * one is a breaking API change; adding one is not.
 */
export type FieldIssue = {
  path: string;
  code: string;
  message: string;
};

export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  /** Field-level detail, only for validation-shaped failures. */
  readonly issues?: FieldIssue[];
  /** Non-enumerable extra context for logs. Never serialised to the client. */
  readonly context?: Record<string, unknown>;

  constructor(message: string, options?: { issues?: FieldIssue[]; context?: Record<string, unknown>; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    if (options?.issues) this.issues = options.issues;
    if (options?.context) this.context = options.context;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  readonly status = 422;
  readonly code = 'validation_failed';
}

export class BadRequestError extends AppError {
  readonly status = 400;
  readonly code = 'bad_request';
}

export class UnauthenticatedError extends AppError {
  readonly status = 401;
  readonly code = 'unauthenticated';
}

export class ForbiddenError extends AppError {
  readonly status = 403;
  readonly code = 'forbidden';
}

export class NotFoundError extends AppError {
  readonly status = 404;
  readonly code = 'not_found';

  constructor(resource: string, id?: string) {
    super(id ? `${resource} '${id}' was not found.` : `${resource} was not found.`);
  }
}

export class ConflictError extends AppError {
  readonly status = 409;
  readonly code = 'conflict';
}

/** Stock ran out, a coupon hit its cap, an order changed under you. */
export class UnprocessableError extends AppError {
  readonly status = 422;
  readonly code = 'unprocessable';

  constructor(message: string, code?: string, options?: ConstructorParameters<typeof AppError>[1]) {
    super(message, options);
    if (code) Object.defineProperty(this, 'code', { value: code, enumerable: true });
  }
}

export class PaymentError extends AppError {
  readonly status = 402;
  readonly code = 'payment_failed';
}

export class RateLimitError extends AppError {
  readonly status = 429;
  readonly code = 'rate_limited';
}

/** A vendor (Razorpay, MSG91, courier) failed or timed out. */
export class UpstreamError extends AppError {
  readonly status = 502;
  readonly code = 'upstream_failed';
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
