/**
 * Pure query shaping for product search. No database, no HTTP — everything here
 * is a total function over strings, which is why it is the part that is unit
 * tested.
 *
 * The storefront ships a client-side Damerau-Levenshtein index
 * (`src/lib/search.ts` in the web front-end). This module reproduces its
 * BEHAVIOUR — typo tolerance, prefix bias, title-over-body weighting,
 * "did you mean", suggestion buckets — using PostgreSQL `tsvector` for matching
 * and `pg_trgm` for fuzziness. It deliberately does not reproduce its algorithm:
 * an in-process edit-distance scan over every row is exactly what a database
 * index exists to avoid.
 */

/** A query longer than this is a paste, not a search. */
export const MAX_QUERY_LENGTH = 120;
/** Beyond this, extra terms only cost planning time. */
export const MAX_TERMS = 8;

/**
 * Relevance weights, carried over from the storefront so ranking does not
 * visibly change when search moves server-side.
 */
export const MATCH_EXACT = 6;
export const MATCH_PREFIX = 4;
export const MATCH_BODY = 1;
export const BEST_SELLER_BOOST = 0.5;
/** Trigram similarity contribution — what buys typo tolerance. */
export const FUZZY_WEIGHT = 3;

/**
 * Lowercases, splits on anything that is not a letter or digit, drops
 * single-character noise, dedupes and caps the term count.
 *
 * The `[a-z0-9]`-only output is also what makes `buildTsQuery` injection-proof:
 * no `&`, `|`, `!`, `(`, `)` or `:` can survive tokenisation, so the string
 * handed to `to_tsquery()` cannot carry an operator the caller did not intend.
 */
export function tokenise(raw: string): string[] {
  const terms = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

/**
 * `['choc', 'gift']` → `'choc:* & gift:*'`.
 *
 * Every term gets the `:*` prefix operator: a shopper who has typed "choc" is
 * mid-word, and `to_tsquery('chocolate')` would not match it. Returns `null`
 * when nothing survives tokenisation, which callers must read as "fall back to
 * trigram matching alone".
 */
export function buildTsQuery(raw: string): string | null {
  const terms = tokenise(raw);
  if (terms.length === 0) return null;
  return terms.map((t) => `${t}:*`).join(' & ');
}

/** Normalised subject for `similarity()` / `%`. Collapses whitespace, keeps order. */
export function trigramTarget(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `%term%` — matched against `lower(title)`, so `%` and `_` must be escaped. */
export function likeContains(raw: string): string {
  return `%${escapeLike(trigramTarget(raw))}%`;
}

/** `term%` — the title-prefix bonus, worth `MATCH_EXACT` on the storefront. */
export function likePrefix(raw: string): string {
  return `${escapeLike(trigramTarget(raw))}%`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Price windows offered when a query returns nothing under the current filters.
 * Open-ended at the top (`maxPaise: null`) so the last bucket never has to be
 * recalculated as the catalogue's ceiling moves.
 */
export const PRICE_BUCKETS_PAISE: readonly { minPaise: number; maxPaise: number | null }[] = [
  { minPaise: 0, maxPaise: 250_000 },
  { minPaise: 250_000, maxPaise: 500_000 },
  { minPaise: 500_000, maxPaise: 1_000_000 },
  { minPaise: 1_000_000, maxPaise: null },
];

/** Sort allowlist for search. `relevance` is always best-first. */
export const SEARCH_SORT_FIELDS = ['relevance', 'price', 'publishedAt'] as const;
export const SEARCH_SORT_FALLBACK = { field: 'relevance', direction: 'desc' } as const;

/**
 * Recombines a "did you mean" phrase from the per-term corrections the database
 * returned. Returns `null` when nothing was corrected — the storefront only
 * renders the prompt when the query actually changed.
 */
export function assembleDidYouMean(
  terms: readonly string[],
  corrections: ReadonlyMap<string, string>,
): string | null {
  let changed = false;
  const out = terms.map((term) => {
    const fix = corrections.get(term);
    if (fix && fix !== term) {
      changed = true;
      return fix;
    }
    return term;
  });
  return changed ? out.join(' ') : null;
}
