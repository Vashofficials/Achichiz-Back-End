import { describe, expect, it } from 'vitest';
import { UnprocessableError } from '../../lib/errors.js';
import { allocate } from '../../lib/money.js';
import {
  DELIVERY_SURCHARGE_PAISE,
  assertInvariants,
  computeShipping,
  evaluateCoupon,
  isPrepaid,
  priceCart,
  roundOffFor,
  splitInclusiveTax,
  type CouponRow,
  type PricedLineInput,
  type PricingInput,
} from './checkout.pricing.js';
import { checkoutQuoteBody, createOrderBody } from './checkout.schemas.js';

/**
 * Pure tests over the pricing engine and the checkout request contracts. No
 * database, no Redis, no gateway.
 *
 * The invariants tested here are the same four the deferred
 * `check_order_totals()` trigger enforces at COMMIT (03_schema.md §4.4). If any
 * of them can be broken by a legal combination of inputs, an order write fails
 * with a `23514` after a payment intent already exists — which is why the
 * randomised section exists rather than a handful of tidy examples.
 */

const SHIPPING = { freeThresholdPaise: 99_900, flatFeePaise: 14_900, zoneBaseFeePaise: null };

const line = (overrides: Partial<PricedLineInput> = {}): PricedLineInput => ({
  lineId: 'l1',
  variantId: 'v1',
  productId: 'p1',
  collectionIds: ['c1'],
  quantity: 1,
  unitPricePaise: 149_900,
  addOnsPaise: 0,
  gstRateBp: 1800,
  cessRateBp: 0,
  ...overrides,
});

const coupon = (overrides: Partial<CouponRow> = {}): CouponRow => ({
  id: 'coupon-1',
  code: 'ACHI10',
  discountType: 'percent',
  discountBp: 1000,
  discountPaise: null,
  maxDiscountPaise: null,
  minOrderPaise: 0,
  appliesTo: 'all',
  scopeProductIds: [],
  scopeCollectionIds: [],
  excludedProductIds: [],
  excludedCollectionIds: [],
  ...overrides,
});

const input = (overrides: Partial<PricingInput> = {}): PricingInput => ({
  lines: [line()],
  coupon: null,
  deliveryType: 'standard',
  paymentMethod: 'upi',
  shipping: SHIPPING,
  isInterstate: false,
  customerOrderCount: 0,
  ...overrides,
});

/* --------------------------------------------------------------------- tax */

describe('splitInclusiveTax', () => {
  it('back-computes taxable so that the parts reconstruct the gross exactly', () => {
    for (const gross of [1, 99, 100, 149_900, 333_333, 1_000_001]) {
      for (const rate of [0, 300, 500, 1200, 1800, 2800]) {
        const t = splitInclusiveTax(gross, rate, 0, false);
        expect(t.taxablePaise + t.cgstPaise + t.sgstPaise + t.igstPaise + t.cessPaise).toBe(gross);
      }
    }
  });

  it('keeps cgst = sgst even when the tax is an odd number of paise', () => {
    // The odd paisa is absorbed into `taxable`, because `cgst = sgst` is a CHECK
    // on both orders and invoices and is a matter of law, not rounding taste.
    for (let gross = 1; gross < 400; gross++) {
      const t = splitInclusiveTax(gross, 1800, 0, false);
      expect(t.cgstPaise).toBe(t.sgstPaise);
      expect(t.igstPaise).toBe(0);
      expect(t.taxablePaise + t.cgstPaise + t.sgstPaise + t.cessPaise).toBe(gross);
    }
  });

  it('puts the whole tax in IGST on an interstate supply', () => {
    const t = splitInclusiveTax(118_000, 1800, 0, true);
    expect(t.cgstPaise).toBe(0);
    expect(t.sgstPaise).toBe(0);
    expect(t.igstPaise).toBeGreaterThan(0);
    expect(t.taxablePaise + t.igstPaise).toBe(118_000);
  });

  it('handles cess without breaking the reconstruction', () => {
    const t = splitInclusiveTax(200_000, 1800, 1200, false);
    expect(t.cessPaise).toBeGreaterThan(0);
    expect(t.taxablePaise + t.cgstPaise + t.sgstPaise + t.cessPaise).toBe(200_000);
  });

  it('is exact at 0% — a nil-rated line is all taxable value', () => {
    const t = splitInclusiveTax(50_000, 0, 0, false);
    expect(t.taxablePaise).toBe(50_000);
    expect(t.cgstPaise + t.sgstPaise + t.igstPaise + t.cessPaise).toBe(0);
  });
});

/* ---------------------------------------------------------------- allocate */

describe('allocate', () => {
  it('distributes a remainder so the parts sum EXACTLY to the whole', () => {
    // ₹500 over three equal lines is 16666.67 paise each; the only correct answer
    // is 16667/16667/16666.
    const parts = allocate(50_000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(50_000);
    expect(parts).toEqual([16_667, 16_667, 16_666]);
  });

  it('gives zero-weight lines exactly zero', () => {
    const parts = allocate(1000, [3, 0, 1]);
    expect(parts[1]).toBe(0);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

/* ----------------------------------------------------------------- coupons */

describe('evaluateCoupon', () => {
  it('refuses when the minimum order value is no longer met', () => {
    expect(() =>
      evaluateCoupon(coupon({ minOrderPaise: 99_900 }), [line()], {
        merchandisePaise: 50_000,
        customerOrderCount: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'coupon_min_not_met' }));
  });

  it('refuses a first-order coupon to a returning customer', () => {
    expect(() =>
      evaluateCoupon(coupon({ appliesTo: 'first_order' }), [line()], {
        merchandisePaise: 149_900,
        customerOrderCount: 3,
      }),
    ).toThrowError(expect.objectContaining({ code: 'coupon_first_order_only' }));
  });

  it('refuses when nothing in the cart is in scope', () => {
    expect(() =>
      evaluateCoupon(coupon({ appliesTo: 'products', scopeProductIds: ['other'] }), [line()], {
        merchandisePaise: 149_900,
        customerOrderCount: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'coupon_not_applicable' }));
  });

  it('refuses BOGO and free-gift coupons rather than quietly discounting nothing', () => {
    for (const discountType of ['bogo', 'free_gift'] as const) {
      expect(() =>
        evaluateCoupon(coupon({ discountType }), [line()], {
          merchandisePaise: 149_900,
          customerOrderCount: 0,
        }),
      ).toThrowError(UnprocessableError);
    }
  });

  it('excludes a product even when the coupon applies to everything', () => {
    expect(() =>
      evaluateCoupon(coupon({ excludedProductIds: ['p1'] }), [line()], {
        merchandisePaise: 149_900,
        customerOrderCount: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'coupon_not_applicable' }));
  });

  it('discounts only the eligible lines, not the whole cart', () => {
    const lines = [
      line({ lineId: 'a', productId: 'p1', unitPricePaise: 100_000 }),
      line({ lineId: 'b', productId: 'p2', unitPricePaise: 100_000 }),
    ];
    const evaluation = evaluateCoupon(
      coupon({ appliesTo: 'products', scopeProductIds: ['p1'], discountBp: 1000 }),
      lines,
      { merchandisePaise: 200_000, customerOrderCount: 0 },
    );
    expect(evaluation.discountPaise).toBe(10_000);
    expect(evaluation.eligibleLineIds).toEqual(['a']);
  });

  it('caps a percentage coupon at maxDiscountPaise', () => {
    const evaluation = evaluateCoupon(
      coupon({ discountBp: 5000, maxDiscountPaise: 20_000 }),
      [line({ unitPricePaise: 500_000 })],
      { merchandisePaise: 500_000, customerOrderCount: 0 },
    );
    expect(evaluation.discountPaise).toBe(20_000);
  });

  it('clamps a flat coupon to the eligible value so a total can never go negative', () => {
    const evaluation = evaluateCoupon(
      coupon({ discountType: 'flat', discountBp: null, discountPaise: 50_000 }),
      [line({ unitPricePaise: 30_000 })],
      { merchandisePaise: 30_000, customerOrderCount: 0 },
    );
    expect(evaluation.discountPaise).toBe(30_000);
  });

  it('treats free shipping as zero discount plus a flag', () => {
    const evaluation = evaluateCoupon(coupon({ discountType: 'free_shipping', discountBp: null }), [line()], {
      merchandisePaise: 149_900,
      customerOrderCount: 0,
    });
    expect(evaluation.discountPaise).toBe(0);
    expect(evaluation.freeShipping).toBe(true);
  });
});

/* ---------------------------------------------------------------- shipping */

describe('computeShipping', () => {
  it('measures the free-shipping threshold AFTER the discount', () => {
    // The storefront tests the pre-discount subtotal (`cart.tsx:28`), which lets a
    // coupon drop an order below ₹999 while keeping free shipping it no longer
    // qualifies for.
    expect(computeShipping(99_900, 'standard', SHIPPING, false)).toBe(0);
    expect(computeShipping(99_899, 'standard', SHIPPING, false)).toBe(14_900);
  });

  it('prefers the zone fee over the flat fee when a zone is known', () => {
    expect(computeShipping(10_000, 'standard', { ...SHIPPING, zoneBaseFeePaise: 9_900 }, false)).toBe(9_900);
  });

  it('lets a free-shipping coupon waive the base fee but not a delivery upgrade', () => {
    expect(computeShipping(10_000, 'standard', SHIPPING, true)).toBe(0);
    expect(computeShipping(10_000, 'same_day', SHIPPING, true)).toBe(DELIVERY_SURCHARGE_PAISE.same_day);
  });

  it('adds the delivery surcharge even above the free-shipping threshold', () => {
    expect(computeShipping(500_000, 'scheduled', SHIPPING, false)).toBe(DELIVERY_SURCHARGE_PAISE.scheduled);
  });
});

describe('roundOffFor', () => {
  it('reconciles to the nearest rupee and stays inside the ±50 CHECK', () => {
    for (let paise = 0; paise < 1000; paise++) {
      const off = roundOffFor(paise);
      expect(Math.abs(off)).toBeLessThanOrEqual(50);
      expect((paise + off) % 100).toBe(0);
    }
  });
});

describe('isPrepaid', () => {
  it('treats every method except COD as prepaid', () => {
    expect(isPrepaid('upi')).toBe(true);
    expect(isPrepaid('credit_card')).toBe(true);
    expect(isPrepaid('cod')).toBe(false);
  });
});

/* --------------------------------------------------------------- priceCart */

describe('priceCart', () => {
  it('never reads a price from its input beyond the catalogue values it was given', () => {
    const breakdown = priceCart(input({ lines: [line({ quantity: 2, addOnsPaise: 10_000 })] }));
    // 2 x (149900 + 10000)
    expect(breakdown.merchandisePaise).toBe(319_800);
    expect(breakdown.subtotalPaise).toBe(319_800);
    expect(breakdown.totalPaise).toBe(319_800 + breakdown.roundOffPaise);
  });

  it('allocates an order-level discount across lines so the parts sum to the whole', () => {
    const breakdown = priceCart(
      input({
        lines: [
          line({ lineId: 'a', unitPricePaise: 100_001 }),
          line({ lineId: 'b', unitPricePaise: 100_001 }),
          line({ lineId: 'c', unitPricePaise: 100_001 }),
        ],
        coupon: coupon({ discountBp: 1000 }),
      }),
    );
    const allocated = breakdown.lines.reduce((a, l) => a + l.allocatedOrderDiscountPaise, 0);
    expect(allocated).toBe(breakdown.couponDiscountPaise);
    expect(() => assertInvariants(breakdown)).not.toThrow();
  });

  it('gives an ineligible line exactly zero of the discount', () => {
    const breakdown = priceCart(
      input({
        lines: [line({ lineId: 'a', productId: 'p1' }), line({ lineId: 'b', productId: 'p2' })],
        coupon: coupon({ appliesTo: 'products', scopeProductIds: ['p1'] }),
      }),
    );
    expect(breakdown.lines.find((l) => l.lineId === 'b')?.allocatedOrderDiscountPaise).toBe(0);
  });

  it('rejects a non-positive or non-integer quantity', () => {
    expect(() => priceCart(input({ lines: [line({ quantity: 0 })] }))).toThrowError(
      expect.objectContaining({ code: 'invalid_quantity' }),
    );
    expect(() => priceCart(input({ lines: [line({ quantity: 1.5 })] }))).toThrowError(UnprocessableError);
  });

  it('prices an empty cart as zero without dividing by anything', () => {
    const breakdown = priceCart(input({ lines: [] }));
    expect(breakdown.itemCount).toBe(0);
    expect(breakdown.subtotalPaise).toBe(0);
    expect(breakdown.totalPaise).toBe(breakdown.shippingPaise + breakdown.roundOffPaise);
    expect(() => assertInvariants(breakdown)).not.toThrow();
  });

  it('routes tax to IGST or CGST+SGST but never both', () => {
    const inter = priceCart(input({ isInterstate: true }));
    expect(inter.cgstPaise + inter.sgstPaise).toBe(0);
    const intra = priceCart(input({ isInterstate: false }));
    expect(intra.igstPaise).toBe(0);
    expect(intra.cgstPaise).toBe(intra.sgstPaise);
  });

  /**
   * The real test. Legal-but-awkward carts — odd prices, mixed GST slabs, big
   * add-ons, coupons that clamp — are exactly where a rounding rule quietly
   * drifts by a paisa and the constraint trigger rejects the order at COMMIT.
   */
  it('satisfies I1-I4 across two thousand randomised carts', () => {
    // Deterministic PRNG: a failing case must be reproducible, and a flaky money
    // test is worse than no money test.
    let seed = 0x2f6e2b1;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(values: readonly T[]): T => values[Math.floor(rand() * values.length)] as T;

    const rates = [0, 300, 500, 1200, 1800, 2800];
    const deliveries = ['standard', 'scheduled', 'same_day', 'midnight'] as const;

    for (let run = 0; run < 2000; run++) {
      const lineCount = 1 + Math.floor(rand() * 6);
      const lines = Array.from({ length: lineCount }, (_, i) =>
        line({
          lineId: `l${i}`,
          productId: `p${Math.floor(rand() * 3)}`,
          collectionIds: [`c${Math.floor(rand() * 3)}`],
          quantity: 1 + Math.floor(rand() * 5),
          unitPricePaise: 1 + Math.floor(rand() * 500_000),
          addOnsPaise: Math.floor(rand() * 30_000),
          gstRateBp: pick(rates),
          cessRateBp: rand() < 0.15 ? pick([100, 1200]) : 0,
        }),
      );

      const withCoupon = rand() < 0.6;
      const percent = rand() < 0.5;
      const candidate: CouponRow | null = withCoupon
        ? coupon({
            discountType: percent ? 'percent' : 'flat',
            discountBp: percent ? 100 + Math.floor(rand() * 9900) : null,
            discountPaise: percent ? null : 1 + Math.floor(rand() * 400_000),
            maxDiscountPaise: rand() < 0.3 ? 1 + Math.floor(rand() * 100_000) : null,
            appliesTo: pick(['all', 'products', 'collections'] as const),
            scopeProductIds: ['p0', 'p1'],
            scopeCollectionIds: ['c0'],
            excludedProductIds: rand() < 0.1 ? ['p2'] : [],
          })
        : null;

      let breakdown;
      try {
        breakdown = priceCart(
          input({
            lines,
            coupon: candidate,
            deliveryType: pick(deliveries),
            isInterstate: rand() < 0.5,
            shipping: { ...SHIPPING, zoneBaseFeePaise: rand() < 0.5 ? 9_900 : null },
          }),
        );
      } catch (err) {
        // A coupon that does not apply is a legitimate outcome, not a failure.
        expect(err).toBeInstanceOf(UnprocessableError);
        continue;
      }

      expect(() => assertInvariants(breakdown)).not.toThrow();
      expect(breakdown.subtotalPaise).toBeGreaterThanOrEqual(0);
      expect(breakdown.totalPaise).toBeGreaterThanOrEqual(0);
      expect(breakdown.couponDiscountPaise).toBeLessThanOrEqual(breakdown.merchandisePaise);
      for (const priced of breakdown.lines) {
        expect(priced.grossPaise).toBeGreaterThanOrEqual(0);
        // The `order_line_discount_bounds` CHECK compares the allocated discount
        // against unit_price x quantity, and order creation writes the ALL-IN
        // per-unit price, so this is the bound that actually has to hold.
        expect(priced.allocatedOrderDiscountPaise).toBeLessThanOrEqual(priced.lineTotalPaise);
      }
    }
  });
});

/* --------------------------------------------------------------- contracts */

describe('checkout request schemas', () => {
  it('defaults delivery to standard and payment to UPI', () => {
    const parsed = checkoutQuoteBody.parse({});
    expect(parsed.deliveryType).toBe('standard');
    expect(parsed.paymentMethod).toBe('upi');
  });

  it('has no field through which a price, discount or total could be sent', () => {
    const parsed = createOrderBody.parse({
      totalPaise: 1,
      subtotal: 1,
      discount: 999,
      shippingPaise: 0,
      price: 5,
    } as unknown as Record<string, unknown>);
    expect(parsed).not.toHaveProperty('totalPaise');
    expect(parsed).not.toHaveProperty('subtotal');
    expect(parsed).not.toHaveProperty('discount');
    expect(parsed).not.toHaveProperty('shippingPaise');
    expect(parsed).not.toHaveProperty('price');
  });

  it('rejects a malformed PIN code and a malformed mobile number', () => {
    const address = {
      contactName: 'Aarav Shah',
      mobile: '9820012345',
      line1: '12 Marine Drive',
      city: 'Mumbai',
      stateCode: '27',
      pincode: '400020',
    };
    expect(checkoutQuoteBody.safeParse({ address }).success).toBe(true);
    expect(checkoutQuoteBody.safeParse({ address: { ...address, pincode: '040020' } }).success).toBe(false);
    expect(checkoutQuoteBody.safeParse({ address: { ...address, pincode: '40002' } }).success).toBe(false);
    expect(checkoutQuoteBody.safeParse({ address: { ...address, mobile: '1234567890' } }).success).toBe(false);
  });

  it('caps the gift message at the 240 characters the checkout form claims', () => {
    expect(createOrderBody.safeParse({ giftMessage: 'x'.repeat(240) }).success).toBe(true);
    expect(createOrderBody.safeParse({ giftMessage: 'x'.repeat(241) }).success).toBe(false);
  });

  it('rejects a delivery type that is not in the enum', () => {
    expect(checkoutQuoteBody.safeParse({ deliveryType: 'drone' }).success).toBe(false);
  });
});
