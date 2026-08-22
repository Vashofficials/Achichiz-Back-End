import { describe, expect, it } from 'vitest';
import { MAX_PER_PAGE, parseSort } from '../../lib/pagination.js';
import {
  MAX_TERMS,
  PRICE_BUCKETS_PAISE,
  SEARCH_SORT_FALLBACK,
  SEARCH_SORT_FIELDS,
  assembleDidYouMean,
  buildTsQuery,
  likeContains,
  likePrefix,
  tokenise,
  trigramTarget,
} from './search.query.js';
import { searchListQuery, searchSuggestQuery, searchSuggestionsQuery } from './search.schemas.js';

/**
 * Pure tests over the query builders. These are the functions that turn a
 * shopper's raw string into a `tsquery`, a `LIKE` pattern and an `ORDER BY` —
 * every one of them a place where an untrusted string meets SQL.
 */

describe('tokenise', () => {
  it('lowercases and splits on punctuation', () => {
    expect(tokenise('Chocolate Hamper')).toEqual(['chocolate', 'hamper']);
    expect(tokenise('gift-box, premium!')).toEqual(['gift', 'box', 'premium']);
  });

  it('drops single characters, which match everything and rank nothing', () => {
    expect(tokenise('a chocolate')).toEqual(['chocolate']);
  });

  it('dedupes', () => {
    expect(tokenise('gift gift GIFT')).toEqual(['gift']);
  });

  it('keeps digits', () => {
    expect(tokenise('set of 12')).toEqual(['set', 'of', '12']);
  });

  it('caps the term count', () => {
    const many = Array.from({ length: MAX_TERMS + 5 }, (_, i) => `term${i}`).join(' ');
    expect(tokenise(many)).toHaveLength(MAX_TERMS);
  });

  it('yields nothing for punctuation-only input', () => {
    expect(tokenise('!!! ???')).toEqual([]);
    expect(tokenise('')).toEqual([]);
  });
});

describe('buildTsQuery', () => {
  it('makes every term a prefix, so a half-typed word still matches', () => {
    expect(buildTsQuery('choc')).toBe('choc:*');
    expect(buildTsQuery('choc gift')).toBe('choc:* & gift:*');
  });

  it('returns null when nothing survives tokenisation', () => {
    expect(buildTsQuery('   ')).toBeNull();
    expect(buildTsQuery('%')).toBeNull();
    expect(buildTsQuery('a')).toBeNull();
  });

  it('cannot carry a tsquery operator through', () => {
    // to_tsquery() parses its argument as an expression language. If any of
    // these survived, a shopper could rewrite the query the server runs.
    for (const attack of [
      'choc & !gift',
      'choc | gift',
      "choc' | 'gift",
      'choc <-> gift',
      '(choc)',
      'choc:*&*',
    ]) {
      const built = buildTsQuery(attack);
      expect(built).not.toBeNull();
      // Only [a-z0-9] terms, each suffixed `:*`, joined by ` & `.
      expect(built).toMatch(/^[a-z0-9]+:\*( & [a-z0-9]+:\*)*$/);
    }
  });
});

describe('trigram helpers', () => {
  it('normalises to a plain lowercase phrase', () => {
    expect(trigramTarget('  Chocolate-Hamper!  ')).toBe('chocolate hamper');
  });

  it('escapes LIKE wildcards so `%` is a literal percent, not "match everything"', () => {
    expect(likeContains('50%')).toBe('%50%');
    expect(likePrefix('a_b')).toBe('a b%');
    expect(likeContains('100% silk')).toBe('%100 silk%');
  });

  it('brackets a contains pattern and anchors a prefix pattern', () => {
    expect(likeContains('gift')).toBe('%gift%');
    expect(likePrefix('gift')).toBe('gift%');
  });
});

describe('assembleDidYouMean', () => {
  it('returns null when nothing was corrected', () => {
    expect(assembleDidYouMean(['chocolate'], new Map())).toBeNull();
  });

  it('returns null when the only correction is the term itself', () => {
    expect(assembleDidYouMean(['chocolate'], new Map([['chocolate', 'chocolate']]))).toBeNull();
  });

  it('rewrites only the corrected terms and preserves order', () => {
    const corrections = new Map([['chcoolate', 'chocolate']]);
    expect(assembleDidYouMean(['chcoolate', 'hamper'], corrections)).toBe('chocolate hamper');
  });

  it('handles several corrections in one query', () => {
    const corrections = new Map([
      ['chcoolate', 'chocolate'],
      ['hampr', 'hamper'],
    ]);
    expect(assembleDidYouMean(['chcoolate', 'hampr'], corrections)).toBe('chocolate hamper');
  });
});

describe('PRICE_BUCKETS_PAISE', () => {
  it('is contiguous, ascending and open-ended at the top', () => {
    expect(PRICE_BUCKETS_PAISE[0]?.minPaise).toBe(0);
    expect(PRICE_BUCKETS_PAISE.at(-1)?.maxPaise).toBeNull();

    for (let i = 1; i < PRICE_BUCKETS_PAISE.length; i++) {
      const previous = PRICE_BUCKETS_PAISE[i - 1];
      const current = PRICE_BUCKETS_PAISE[i];
      expect(current?.minPaise).toBe(previous?.maxPaise);
    }
  });

  it('is integer paise throughout — no float rupee ever reaches the response', () => {
    for (const bucket of PRICE_BUCKETS_PAISE) {
      expect(Number.isInteger(bucket.minPaise)).toBe(true);
      if (bucket.maxPaise !== null) expect(Number.isInteger(bucket.maxPaise)).toBe(true);
    }
  });
});

describe('search sort allowlist', () => {
  it('accepts the three advertised orderings', () => {
    expect(parseSort('price', SEARCH_SORT_FIELDS, SEARCH_SORT_FALLBACK)).toEqual({
      field: 'price',
      direction: 'asc',
    });
    expect(parseSort('-price', SEARCH_SORT_FIELDS, SEARCH_SORT_FALLBACK)).toEqual({
      field: 'price',
      direction: 'desc',
    });
    expect(parseSort('-publishedAt', SEARCH_SORT_FIELDS, SEARCH_SORT_FALLBACK)).toEqual({
      field: 'publishedAt',
      direction: 'desc',
    });
  });

  it('defaults to relevance, best first', () => {
    expect(parseSort(undefined, SEARCH_SORT_FIELDS, SEARCH_SORT_FALLBACK)).toEqual({
      field: 'relevance',
      direction: 'desc',
    });
  });

  it('falls back rather than letting an unknown field reach ORDER BY', () => {
    expect(parseSort('costPaise', SEARCH_SORT_FIELDS, SEARCH_SORT_FALLBACK)).toEqual(SEARCH_SORT_FALLBACK);
  });
});

describe('searchListQuery', () => {
  it('requires a query', () => {
    expect(searchListQuery.safeParse({}).success).toBe(false);
    expect(searchListQuery.safeParse({ q: '' }).success).toBe(false);
    expect(searchListQuery.safeParse({ q: '   ' }).success).toBe(false);
  });

  it('trims the query', () => {
    expect(searchListQuery.parse({ q: '  chocolate  ' }).q).toBe('chocolate');
  });

  it('rejects a paste-length query', () => {
    expect(searchListQuery.safeParse({ q: 'x'.repeat(121) }).success).toBe(false);
  });

  it('rejects a sort value outside the enum', () => {
    expect(searchListQuery.safeParse({ q: 'gift', sort: 'relevance' }).success).toBe(true);
    expect(searchListQuery.safeParse({ q: 'gift', sort: '-price' }).success).toBe(true);
    expect(searchListQuery.safeParse({ q: 'gift', sort: 'costPaise' }).success).toBe(false);
  });

  it('honours the shared per-page ceiling', () => {
    expect(searchListQuery.safeParse({ q: 'gift', perPage: String(MAX_PER_PAGE + 1) }).success).toBe(false);
  });
});

describe('searchSuggestQuery', () => {
  it('defaults to six autocomplete rows', () => {
    expect(searchSuggestQuery.parse({ q: 'choc' }).perPage).toBe(6);
  });

  it('caps autocomplete well below the list ceiling', () => {
    expect(searchSuggestQuery.safeParse({ q: 'choc', perPage: '20' }).success).toBe(true);
    expect(searchSuggestQuery.safeParse({ q: 'choc', perPage: '21' }).success).toBe(false);
  });
});

describe('searchSuggestionsQuery', () => {
  it('needs only a query', () => {
    expect(searchSuggestionsQuery.parse({ q: 'chcoolate' })).toEqual({ q: 'chcoolate' });
  });
});
