/**
 * The response envelope, in one place.
 *
 * Single resource:  { type: 'success', result: {...} }
 * Collection:       { type: 'success', result: [...], meta: { page, perPage, total, totalPages } }
 * Deletes:          204, no body
 * Errors:           { type: 'error', result: { title, status, code, detail, instance, requestId, errors? } }
 *                   — same two keys, served as application/json. See middleware/error-handler.ts.
 *
 * `meta` is a SIBLING of `result`, not nested inside it.
 *
 * This comment said `{ data: … }` until it was caught by a documentation pass that
 * had trusted it over the code below. The key is `result`; there is no `data` key
 * anywhere in this API.
 */
export type PageMeta = {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
};

export type Envelope<T> = { type: 'success'; result: T };
export type PagedEnvelope<T> = { type: 'success'; result: T[]; meta: PageMeta };

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
  body: { type: 'success', result: data } satisfies Envelope<T>,
});

export const created = <T>(data: T): HandlerResult => ({
  kind: 'json',
  status: 201,
  body: { type: 'success', result: data } satisfies Envelope<T>,
});

export const accepted = <T>(data: T): HandlerResult => ({
  kind: 'json',
  status: 202,
  body: { type: 'success', result: data } satisfies Envelope<T>,
});

export const noContent = (): HandlerResult => ({ kind: 'noContent' });

/** The handler wrote to `res` itself (file streams, redirects, raw webhook acks). */
export const raw = (): HandlerResult => ({ kind: 'raw' });

export function paginated<T>(rows: T[], meta: PageMeta): HandlerResult {
  return {
    kind: 'json',
    status: 200,
    body: { type: 'success', result: rows, meta } satisfies PagedEnvelope<T>,
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
