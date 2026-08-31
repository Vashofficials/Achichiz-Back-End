/**
 * Translate PostgreSQL integrity violations into the API's own errors.
 *
 * The generic resource layer builds INSERT/UPDATE statements from a descriptor,
 * so it cannot pre-validate what only the database knows: that a handle is
 * already taken, that `state_code` must exist in `gst_states`, or that an active
 * product needs an HSN code. Without this, every one of those surfaced as a 500
 * "Something went wrong on our end" — which tells the caller nothing, tells the
 * operator nothing, and reads as a server fault when the request was simply
 * wrong.
 *
 * Verified against the live database: creating a duplicate collection, a
 * warehouse with an unknown state code, and an active product with no HSN code
 * all produced 500s before this existed.
 *
 * Only integrity violations are mapped. A genuine server fault — a syntax error,
 * a dead connection — must still escape as a 500, because it IS one.
 */

import { ConflictError, ValidationError } from '../../lib/errors.js';

/** https://www.postgresql.org/docs/current/errcodes-appendix.html */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';

type PgError = { code?: string; constraint?: string; column?: string; detail?: string };

/**
 * Drizzle wraps the driver error, so the useful one is usually on `cause`.
 * Walks the chain rather than assuming a depth, because the number of wrappers
 * has changed between drizzle versions before.
 */
export function pgErrorOf(err: unknown): PgError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as PgError;
    if (typeof candidate.code === 'string' && /^\d{5}$/.test(candidate.code)) return candidate;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * `warehouses_state_code_fkey` -> `stateCode`, so the message names the field the
 * caller actually sent rather than a column they have never seen. Falls back to
 * the constraint name when the shape is unfamiliar — a slightly awkward message
 * beats a wrong one.
 */
export function fieldFromConstraint(constraint: string | undefined, table: string): string | null {
  if (!constraint) return null;
  const trimmed = constraint
    .replace(new RegExp(`^${table}_`), '')
    .replace(/_(fkey|key|check|idx)$/, '');
  if (!trimmed || trimmed === constraint) return null;
  return trimmed.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Conditional requirements the database enforces but no schema can express.
 *
 * These constraints all have the shape "if field A is X, field B is mandatory",
 * so a body built strictly from `/schema` — which marks only unconditional
 * fields required — is still rejected. Without this map the caller received
 * `This combination of values is not allowed (product_active_needs_hsn)`, which
 * names the constraint and not the fix.
 *
 * `field` is the CAMELCASE key the client actually sent, so the console can
 * highlight the right input rather than a column name it never rendered.
 */
const CONDITIONAL_REQUIREMENTS: Record<string, { field: string; message: string }> = {
  product_active_needs_hsn: {
    field: 'hsnCode',
    message: 'An active product needs an HSN code. Save it as a draft, or supply hsnCode.',
  },
  product_active_needs_publish: {
    field: 'publishedAt',
    message: 'An active product needs a publish date. Save it as a draft, or supply publishedAt.',
  },
  coupon_percent_needs_bp: {
    field: 'discountBp',
    message: 'A percent coupon needs discountBp — the discount in basis points (1000 = 10%).',
  },
  coupon_flat_needs_paise: {
    field: 'discountPaise',
    message: 'A flat coupon needs discountPaise — the amount off, in paise.',
  },
  coupon_bogo_needs_qty: {
    field: 'bogoBuyQty',
    message: 'A BOGO coupon needs both bogoBuyQty and bogoGetQty.',
  },
  coupon_gift_needs_variant: {
    field: 'freeGiftVariantId',
    message: 'A free-gift coupon needs freeGiftVariantId — the variant given away.',
  },
  coupon_window: {
    field: 'endsAt',
    message: 'endsAt must be later than startsAt.',
  },
  coupons_code_check: {
    field: 'code',
    message: 'A coupon code is 3–32 characters, UPPERCASE, using A–Z, 0–9, hyphen or underscore.',
  },
};

/**
 * The API error for a database integrity violation, or null when the error is
 * not one and should keep propagating.
 */
export function translateConstraintError(err: unknown, table: string): Error | null {
  const pg = pgErrorOf(err);
  if (!pg?.code) return null;

  const field = fieldFromConstraint(pg.constraint, table) ?? pg.column ?? 'body';

  switch (pg.code) {
    case UNIQUE_VIOLATION:
      return new ConflictError(`A ${table} record with that ${field} already exists.`, {
        context: { constraint: pg.constraint },
      });

    case FOREIGN_KEY_VIOLATION:
      return new ValidationError(`1 field is invalid.`, {
        issues: [
          {
            path: field,
            code: 'not_found',
            message: `That ${field} does not refer to an existing record.`,
          },
        ],
        context: { constraint: pg.constraint },
      });

    case CHECK_VIOLATION: {
      const known = CONDITIONAL_REQUIREMENTS[pg.constraint ?? ''];
      return new ValidationError(`1 field is invalid.`, {
        issues: [
          {
            path: known?.field ?? field,
            code: known ? 'required' : 'invalid_value',
            message:
              known?.message ??
              `This combination of values is not allowed (${pg.constraint ?? 'check constraint'}).`,
          },
        ],
        context: { constraint: pg.constraint },
      });
    }

    case NOT_NULL_VIOLATION:
      return new ValidationError(`1 field is invalid.`, {
        issues: [{ path: field, code: 'required', message: `${field} is required.` }],
        context: { column: pg.column },
      });

    default:
      return null;
  }
}
