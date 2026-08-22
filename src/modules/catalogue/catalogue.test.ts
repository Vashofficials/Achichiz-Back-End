import { describe, expect, it } from 'vitest';
import { MAX_PER_PAGE, parseSort } from '../../lib/pagination.js';
import {
  ADD_ON_SORT_FALLBACK,
  ADD_ON_SORT_FIELDS,
  COLLECTION_SORT_FALLBACK,
  COLLECTION_SORT_FIELDS,
  DESIGNER_SORT_FALLBACK,
  DESIGNER_SORT_FIELDS,
  PRODUCT_SORT_FALLBACK,
  PRODUCT_SORT_FIELDS,
  addOnListQuery,
  collectionListQuery,
  handleParam,
  productListQuery,
  productSummary,
  serviceabilityQuery,
} from './catalogue.schemas.js';
import {
  addWorkingDays,
  isBeforeCutoff,
  istDate,
  istTime,
  stockStateOf,
  toHandleList,
} from './catalogue.service.js';

/**
 * Pure tests only — no database, no Redis. What is worth testing here is the
 * boundary between an untrusted query string and a SQL clause, and the derived
 * values that no column stores.
 */

describe('productListQuery', () => {
  it('applies pagination defaults', () => {
    const parsed = productListQuery.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(25);
  });

  it('refuses to page past the ceiling', () => {
    expect(productListQuery.safeParse({ perPage: String(MAX_PER_PAGE + 1) }).success).toBe(false);
    expect(productListQuery.safeParse({ perPage: String(MAX_PER_PAGE) }).success).toBe(true);
  });

  it('reads `inStock=false` as false', () => {
    // The trap this guards: `Boolean('false')` is true, so `z.coerce.boolean()`
    // would turn an explicit opt-out into an opt-in and hide every out-of-stock
    // product from a shopper who asked to see them.
    expect(productListQuery.parse({ inStock: 'false' }).inStock).toBe(false);
    expect(productListQuery.parse({ inStock: '0' }).inStock).toBe(false);
    expect(productListQuery.parse({ inStock: 'true' }).inStock).toBe(true);
    expect(productListQuery.parse({ inStock: '1' }).inStock).toBe(true);
    expect(productListQuery.parse({}).inStock).toBeUndefined();
  });

  it('rejects a boolean filter that is neither', () => {
    expect(productListQuery.safeParse({ sameDay: 'yes' }).success).toBe(false);
  });

  it('coerces price bounds to integers and rejects negatives', () => {
    expect(productListQuery.parse({ minPricePaise: '149900' }).minPricePaise).toBe(149900);
    expect(productListQuery.safeParse({ minPricePaise: '-1' }).success).toBe(false);
  });

  it('accepts a collection handle but not a path traversal', () => {
    expect(productListQuery.safeParse({ collection: 'festivals-diwali' }).success).toBe(true);
    expect(productListQuery.safeParse({ collection: '../admin' }).success).toBe(false);
    expect(productListQuery.safeParse({ collection: "diwali'; DROP TABLE products--" }).success).toBe(false);
  });
});

describe('collectionListQuery', () => {
  it('reads `featured=false` as false', () => {
    expect(collectionListQuery.parse({ featured: 'false' }).featured).toBe(false);
  });

  it('restricts kind to the six taxonomy kinds', () => {
    expect(collectionListQuery.safeParse({ kind: 'occasion' }).success).toBe(true);
    expect(collectionListQuery.safeParse({ kind: 'brand' }).success).toBe(false);
  });
});

describe('addOnListQuery', () => {
  it('accepts a product handle filter', () => {
    expect(addOnListQuery.parse({ product: 'bamboo-water-bottle' }).product).toBe('bamboo-water-bottle');
  });

  it('rejects a malformed product handle', () => {
    expect(addOnListQuery.safeParse({ product: 'Bamboo Bottle' }).success).toBe(false);
  });
});

describe('handleParam', () => {
  it.each([
    ['bamboo-water-bottle', true],
    ['a1', true],
    ['Bamboo-Bottle', false],
    ['double--hyphen', false],
    ['-leading', false],
    ['trailing-', false],
    ['has space', false],
    ['a', false],
  ])('%s → %s', (handle, valid) => {
    expect(handleParam.safeParse({ handle }).success).toBe(valid);
  });
});

describe('serviceabilityQuery', () => {
  it.each([
    ['400053', true],
    ['110001', true],
    ['012345', false], // Indian PIN codes never start with 0
    ['40005', false],
    ['4000531', false],
    ['40005a', false],
  ])('%s → %s', (pincode, valid) => {
    expect(serviceabilityQuery.safeParse({ pincode }).success).toBe(valid);
  });
});

describe('sort allowlists', () => {
  it('accepts every advertised product sort field, ascending and descending', () => {
    for (const field of PRODUCT_SORT_FIELDS) {
      expect(parseSort(field, PRODUCT_SORT_FIELDS, PRODUCT_SORT_FALLBACK)).toEqual({
        field,
        direction: 'asc',
      });
      expect(parseSort(`-${field}`, PRODUCT_SORT_FIELDS, PRODUCT_SORT_FALLBACK)).toEqual({
        field,
        direction: 'desc',
      });
    }
  });

  it('falls back rather than letting an unknown field reach ORDER BY', () => {
    // These are the ones that matter: cost_paise is a column that exists and is
    // never exposed, and the third is an injection attempt.
    for (const attack of ['costPaise', 'id); DROP TABLE products--', 'random()', '']) {
      expect(parseSort(attack, PRODUCT_SORT_FIELDS, PRODUCT_SORT_FALLBACK)).toEqual(PRODUCT_SORT_FALLBACK);
    }
  });

  it('never exposes a cost or margin field on any storefront resource', () => {
    const allFields = [
      ...PRODUCT_SORT_FIELDS,
      ...COLLECTION_SORT_FIELDS,
      ...DESIGNER_SORT_FIELDS,
      ...ADD_ON_SORT_FIELDS,
    ];
    for (const field of allFields) {
      expect(field.toLowerCase()).not.toContain('cost');
      expect(field.toLowerCase()).not.toContain('margin');
    }
  });

  it('uses its own fallback per resource', () => {
    expect(parseSort(undefined, COLLECTION_SORT_FIELDS, COLLECTION_SORT_FALLBACK)).toEqual({
      field: 'sortOrder',
      direction: 'asc',
    });
    expect(parseSort(undefined, DESIGNER_SORT_FIELDS, DESIGNER_SORT_FALLBACK)).toEqual({
      field: 'name',
      direction: 'asc',
    });
    expect(parseSort(undefined, ADD_ON_SORT_FIELDS, ADD_ON_SORT_FALLBACK)).toEqual({
      field: 'name',
      direction: 'asc',
    });
  });
});

describe('toHandleList', () => {
  it('accepts the repeated-parameter form', () => {
    expect(toHandleList(['drinkware', 'candles'])).toEqual(['drinkware', 'candles']);
  });

  it('accepts the comma form, which is what survives a proxy that collapses duplicates', () => {
    expect(toHandleList('drinkware,candles')).toEqual(['drinkware', 'candles']);
    expect(toHandleList(['drinkware,candles', 'trays'])).toEqual(['drinkware', 'candles', 'trays']);
  });

  it('dedupes and lowercases', () => {
    expect(toHandleList('Drinkware,drinkware')).toEqual(['drinkware']);
  });

  it('drops anything that is not a well-formed handle', () => {
    expect(toHandleList("drinkware,'; DROP TABLE products--")).toEqual(['drinkware']);
    expect(toHandleList('%')).toBeUndefined();
    expect(toHandleList('')).toBeUndefined();
    expect(toHandleList(undefined)).toBeUndefined();
  });
});

describe('stockStateOf', () => {
  it('is `out` at zero and below', () => {
    expect(stockStateOf(0, 10)).toBe('out');
    expect(stockStateOf(-3, 10)).toBe('out');
  });

  it('is `low` at or below the threshold', () => {
    expect(stockStateOf(1, 10)).toBe('low');
    expect(stockStateOf(10, 10)).toBe('low');
  });

  it('is `in` above the threshold', () => {
    expect(stockStateOf(11, 10)).toBe('in');
  });

  it('treats a zero threshold as "never low"', () => {
    expect(stockStateOf(1, 0)).toBe('in');
    expect(stockStateOf(0, 0)).toBe('out');
  });
});

describe('Asia/Kolkata clock', () => {
  it('rolls the date over at 18:30 UTC, not midnight UTC', () => {
    expect(istDate(new Date('2026-08-07T18:29:00Z'))).toBe('2026-08-07');
    expect(istDate(new Date('2026-08-07T18:30:00Z'))).toBe('2026-08-08');
  });

  it('formats the time zero-padded and 24-hour', () => {
    expect(istTime(new Date('2026-08-07T18:30:00Z'))).toBe('00:00:00');
    expect(istTime(new Date('2026-08-07T07:30:00Z'))).toBe('13:00:00');
  });
});

describe('addWorkingDays', () => {
  it('skips Sundays', () => {
    // 2026-08-07 is a Friday: +1 → Saturday, +2 → Monday (Sunday skipped).
    expect(addWorkingDays('2026-08-07', 1)).toBe('2026-08-08');
    expect(addWorkingDays('2026-08-07', 2)).toBe('2026-08-10');
  });

  it('returns the same day for zero or negative days', () => {
    expect(addWorkingDays('2026-08-07', 0)).toBe('2026-08-07');
    expect(addWorkingDays('2026-08-07', -5)).toBe('2026-08-07');
  });

  it('crosses a month boundary', () => {
    expect(addWorkingDays('2026-08-29', 1)).toBe('2026-08-31');
  });
});

describe('isBeforeCutoff', () => {
  it('is permissive when the zone has no cutoff', () => {
    expect(isBeforeCutoff('23:59:59', null)).toBe(true);
  });

  it('compares zero-padded 24-hour strings lexicographically', () => {
    expect(isBeforeCutoff('12:59:59', '13:00:00')).toBe(true);
    expect(isBeforeCutoff('13:00:00', '13:00:00')).toBe(false);
    expect(isBeforeCutoff('13:00:01', '13:00:00')).toBe(false);
    // 09:00 must not sort above 13:00 — the reason the hour is padded.
    expect(isBeforeCutoff('09:00:00', '13:00:00')).toBe(true);
  });

  it('tolerates a PG `time` that carries fractional seconds', () => {
    expect(isBeforeCutoff('12:00:00', '13:00:00.000000')).toBe(true);
  });
});

describe('productSummary contract', () => {
  const valid = {
    id: '3f1e6b6e-9a0b-4f4c-9b1a-2c0d4e5f6a7b',
    handle: 'bamboo-water-bottle',
    sku: 'ACH-BWB-01',
    title: 'Bamboo water bottle',
    subtitle: null,
    kind: 'single_gift',
    designer: null,
    type: 'drinkware',
    typeLabel: 'Drinkware',
    pricePaise: 149900,
    compareAtPaise: null,
    image: null,
    collectionHandles: ['drinkware'],
    occasionHandles: [],
    recipientHandles: [],
    stock: 'in',
    stockQty: 42,
    sameDay: true,
    bestSeller: false,
    isNew: true,
    personalisable: false,
    tags: [],
    ratingAvg: 4.6,
    reviewCount: 12,
    publishedAt: '2026-07-01T00:00:00.000Z',
  };

  it('accepts a well-formed product', () => {
    expect(productSummary.safeParse(valid).success).toBe(true);
  });

  it('rejects a fractional rupee price where integer paise belong', () => {
    expect(productSummary.safeParse({ ...valid, pricePaise: 1499.0 }).success).toBe(true);
    expect(productSummary.safeParse({ ...valid, pricePaise: 1499.5 }).success).toBe(false);
  });

  it('rejects an unknown stock state', () => {
    expect(productSummary.safeParse({ ...valid, stock: 'maybe' }).success).toBe(false);
  });
});
