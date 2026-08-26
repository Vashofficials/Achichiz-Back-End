import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFIX,
  EAN13_LENGTH,
  INTERNAL_PREFIXES,
  bodyLengthFor,
  buildEan13,
  completeEan13,
  ean13CheckDigit,
  ean13WeightedSum,
  isValidEan13,
  mintDistinctEan13,
  mintEan13,
  type DigitSource,
} from './admin-barcodes.ean13.js';
import { QR_VERSION, qrPayload } from './admin-barcodes.service.js';

/**
 * EAN-13, pinned against published symbols rather than against itself.
 *
 * A check digit implementation tested only against its own output is a test that
 * passes whatever the arithmetic does. These two codes are standard EAN-13
 * examples with known check digits, so a weighting error fails here rather than
 * on a shelf.
 */
const KNOWN_GOOD = {
  '4006381333931': { payload: '400638133393', sum: 89, check: 1 },
  '5901234123457': { payload: '590123412345', sum: 83, check: 7 },
} as const;

/**
 * Deterministic digit source: cycles a fixed string. The generator must not need luck.
 *
 * The seed length must be coprime with the body length (10 here), or every draw
 * lands on the same offset and returns an identical code — which would be a
 * property of this helper, not of the minter.
 */
const cyclingDigits = (seed: string): DigitSource => {
  let cursor = 0;
  return (length: number) => {
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += seed[cursor % seed.length];
      cursor += 1;
    }
    return out;
  };
};

/* ============================================================ check digit */

describe('ean13WeightedSum', () => {
  it('matches the published sums', () => {
    for (const [, expected] of Object.entries(KNOWN_GOOD)) {
      expect(ean13WeightedSum(expected.payload)).toBe(expected.sum);
    }
  });

  it('weights odd 1-indexed positions by 1 and even by 3', () => {
    // 12 ones: six at weight 1, six at weight 3 = 24.
    expect(ean13WeightedSum('111111111111')).toBe(24);
    // A single 1 in the first (odd) position weighs 1.
    expect(ean13WeightedSum('100000000000')).toBe(1);
    // A single 1 in the second (even) position weighs 3.
    expect(ean13WeightedSum('010000000000')).toBe(3);
  });

  it('throws rather than returning NaN on malformed input', () => {
    // A silently-wrong check digit is a barcode that scans and means the wrong
    // thing, which is worse than a 500.
    expect(() => ean13WeightedSum('12345')).toThrow();
    expect(() => ean13WeightedSum('40063813339')).toThrow(); // 11 digits
    expect(() => ean13WeightedSum('4006381333933')).toThrow(); // 13 digits
    expect(() => ean13WeightedSum('40063813339X')).toThrow();
    expect(() => ean13WeightedSum('')).toThrow();
  });
});

describe('ean13CheckDigit', () => {
  it('matches the published check digits', () => {
    for (const [, expected] of Object.entries(KNOWN_GOOD)) {
      expect(ean13CheckDigit(expected.payload)).toBe(expected.check);
    }
  });

  it('is 0, not 10, when the weighted sum is already a multiple of ten', () => {
    // The classic off-by-one: `10 - 0` produces a 14-character "EAN-13" that no
    // scanner accepts. 2 + 6*3 = 20, so the check digit must be 0.
    expect(ean13WeightedSum('260000000000')).toBe(20);
    expect(ean13CheckDigit('260000000000')).toBe(0);
    expect(completeEan13('260000000000')).toHaveLength(EAN13_LENGTH);
  });

  it('always returns a single digit', () => {
    for (let d = 0; d <= 9; d += 1) {
      const check = ean13CheckDigit(String(d).repeat(12));
      expect(check).toBeGreaterThanOrEqual(0);
      expect(check).toBeLessThanOrEqual(9);
    }
  });
});

describe('completeEan13', () => {
  it('reproduces the published symbols from their payloads', () => {
    for (const [code, expected] of Object.entries(KNOWN_GOOD)) {
      expect(completeEan13(expected.payload)).toBe(code);
    }
  });

  it('always produces 13 characters', () => {
    expect(completeEan13('000000000000')).toHaveLength(EAN13_LENGTH);
    expect(completeEan13('999999999999')).toHaveLength(EAN13_LENGTH);
  });
});

describe('isValidEan13', () => {
  it('accepts the published symbols', () => {
    for (const code of Object.keys(KNOWN_GOOD)) {
      expect(isValidEan13(code)).toBe(true);
    }
  });

  it('rejects a single corrupted digit', () => {
    // 4006381333931 with the twelfth digit 3 changed to 4 — the check digit no
    // longer agrees with the payload.
    expect(isValidEan13('4006381333941')).toBe(false);
  });

  it('rejects anything that is not 13 digits', () => {
    expect(isValidEan13('400638133393')).toBe(false); // 12
    expect(isValidEan13('40063813339311')).toBe(false); // 14
    expect(isValidEan13('400638133393X')).toBe(false);
    expect(isValidEan13('')).toBe(false);
    expect(isValidEan13('   4006381333931')).toBe(false);
  });

  it('does NOT catch an adjacent transposition of digits differing by 5', () => {
    // A real, documented limitation of the 1/3 weighting, not a bug here: 3 and 8
    // swapped changes the weighted sum by 10, which a mod-10 check cannot see.
    // Recorded so nobody later mistakes the check digit for a uniqueness
    // guarantee it was never able to make — `uq_variants_barcode` is what stops
    // two SKUs sharing a code.
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('4006831333931')).toBe(true);
    expect('4006381333931').not.toBe('4006831333931');
  });
});

/* ================================================================ minting */

describe('prefixes', () => {
  it('only mints inside the GS1 restricted-circulation range', () => {
    // 2xx is reserved for codes meaningful inside one company. Minting outside it
    // would print a code that collides with somebody's registered GS1 prefix.
    for (const prefix of INTERNAL_PREFIXES) {
      expect(prefix).toMatch(/^2\d$/);
    }
    expect(INTERNAL_PREFIXES).toContain(DEFAULT_PREFIX);
  });

  it('leaves ten digits of body for a two-digit prefix', () => {
    expect(bodyLengthFor('29')).toBe(10);
    expect(bodyLengthFor('290')).toBe(9);
  });
});

describe('buildEan13', () => {
  it('appends the check digit to prefix + body', () => {
    const code = buildEan13('29', '0000000000');
    expect(code).toHaveLength(EAN13_LENGTH);
    expect(code.startsWith('29')).toBe(true);
    expect(isValidEan13(code)).toBe(true);
  });

  it('refuses a prefix and body that do not add up to 12', () => {
    expect(() => buildEan13('29', '000')).toThrow();
    expect(() => buildEan13('29', '00000000000')).toThrow();
  });
});

describe('mintEan13 / mintDistinctEan13', () => {
  it('is deterministic under an injected digit source', () => {
    // The whole reason the source is injected: a generator that can only be
    // tested statistically is a generator nobody tests.
    const a = mintEan13('29', cyclingDigits('123456789'));
    const b = mintEan13('29', cyclingDigits('123456789'));
    expect(a).toBe(b);
    expect(isValidEan13(a)).toBe(true);
  });

  it('mints the requested number of valid, distinct codes', () => {
    const codes = mintDistinctEan13('29', 5, cyclingDigits('918273645'));
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);
    for (const code of codes) expect(isValidEan13(code)).toBe(true);
  });

  it('honours the exclusion set — codes already in the table', () => {
    const first = mintDistinctEan13('29', 3, cyclingDigits('918273645'));
    const second = mintDistinctEan13('29', 3, cyclingDigits('918273645'), {
      exclude: new Set(first),
    });
    expect(second.some((c) => first.includes(c))).toBe(false);
  });

  it('gives up instead of looping forever on a degenerate source', () => {
    // A source that always returns the same digits can never produce a second
    // distinct code. Bounded attempts, then a throw.
    const constant: DigitSource = (length) => '7'.repeat(length);
    expect(() => mintDistinctEan13('29', 2, constant, { maxAttempts: 20 })).toThrowError(
      /distinct/i,
    );
  });

  it('mints one code from a degenerate source without complaining', () => {
    const constant: DigitSource = (length) => '7'.repeat(length);
    expect(mintDistinctEan13('29', 1, constant)).toHaveLength(1);
  });
});

/* ============================================================= QR payload */

describe('qrPayload', () => {
  it('is version | sku | barcode', () => {
    expect(qrPayload('ACH-CAN-001', '2900000000008')).toBe(`${QR_VERSION}|ACH-CAN-001|2900000000008`);
  });

  it('keeps the field count stable when there is no barcode', () => {
    // An empty trailing field rather than a dropped one: a scanner splitting on
    // `|` must see the same shape whether or not the SKU has been labelled.
    const payload = qrPayload('ACH-CAN-001', null);
    expect(payload).toBe(`${QR_VERSION}|ACH-CAN-001|`);
    expect(payload.split('|')).toHaveLength(3);
  });

  it('carries no cost, supplier or quantity', () => {
    // A label travels on the outside of a box into somebody else's yard.
    const payload = qrPayload('ACH-CAN-001', '2900000000008');
    expect(payload).not.toMatch(/cost|price|supplier|qty|warehouse/i);
  });

  it('is versioned, so a future format change is recognisable', () => {
    expect(qrPayload('X', null).startsWith(`${QR_VERSION}|`)).toBe(true);
  });
});
