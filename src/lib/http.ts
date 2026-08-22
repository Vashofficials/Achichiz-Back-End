/**
 * The response envelope, in one place.
 *
 * Single resource:  { data: {...} }
 * Collection:       { data: [...], meta: { page, perPage, total, totalPages } }
 * Deletes:          204, no body
 * Errors:           RFC 9457 problem+json — see middleware/error-handler.ts
 */
export type PageMeta = {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
};

export type Envelope<T> = { data: T };
export type PagedEnvelope<T> = { data: T[]; meta: PageMeta };

/**
 * What a route handler may return. `defineRoute` unwraps it.
 *
 * Deliberately NOT generic: the body has already been serialised into the
 * envelope by the time it gets here, so a type parameter would be decorative —
 * it would appear in the signature without constraining anything. The response
 * type is pinned by the route's `responses` zod schema instead, which is the
 * declaration that actually reaches the OpenAPI document.
 */
export type HandlerResult =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'noContent' }
  | { kind: 'raw' };

export const ok = <T>(data: T): HandlerResult => ({
  kind: 'json',
  status: 200,
  body: { data } satisfies Envelope<T>,
});

export const created = <T>(data: T): HandlerResult => ({
  kind: 'json',
  status: 201,
  body: { data } satisfies Envelope<T>,
});

export const accepted = <T>(data: T): HandlerResult => ({
  kind: 'json',
  status: 202,
  body: { data } satisfies Envelope<T>,
});

export const noContent = (): HandlerResult => ({ kind: 'noContent' });

/** The handler wrote to `res` itself (file streams, redirects, raw webhook acks). */
export const raw = (): HandlerResult => ({ kind: 'raw' });

export function paginated<T>(rows: T[], meta: PageMeta): HandlerResult {
  return {
    kind: 'json',
    status: 200,
    body: { data: rows, meta } satisfies PagedEnvelope<T>,
  };
}

export function pageMeta(total: number, page: number, perPage: number): PageMeta {
  return {
    page,
    perPage,
    total,
    totalPages: perPage > 0 ? Math.ceil(total / perPage) : 0,
  };
}
