import { describe, expect, it } from 'vitest';
import {
  bundleAvailability,
  bundleSavingsPaise,
  componentFulfillableQty,
  type BundleComponentStock,
} from './admin-bundles.availability.js';

/**
 * Bundle availability — pure, so tested exhaustively without a database.
 *
 * The rule under test is §91: a bundle has no stock of its own. Its availability
 * is `MIN(floor(available / required))` across the components, recomputed every
 * time. Every case below is a way a stored number, a wrong rounding direction, or
 * an unguarded `Math.min()` would overstate what can be shipped — which is
 * precisely how the Build Your Own Hamper flow oversells today.
 */

const VARIANT = {
  bottle: '11111111-1111-4111-8111-111111111111',
  pen: '22222222-2222-4222-8222-222222222222',
  diary: '33333333-3333-4333-8333-333333333333',
} as const;

const stock = (variantId: string, requiredQty: number, availableQty: number): BundleComponentStock => ({
  variantId,
  requiredQty,
  availableQty,
});

/* =================================================== per-component arithmetic */

describe('componentFulfillableQty', () => {
  it('floors — 7 pens make 3 two-pen bundles, never 3.5', () => {
    expect(componentFulfillableQty(stock(VARIANT.pen, 2, 7))).toBe(3);
  });

  it('is 0 when the component is out of stock', () => {
    expect(componentFulfillableQty(stock(VARIANT.pen, 1, 0))).toBe(0);
  });

  it('never reports a negative count from negative stock', () => {
    // available should never be negative, but if a level ever went below zero the
    // answer is "none", not "minus three bundles".
    expect(componentFulfillableQty(stock(VARIANT.pen, 1, -3))).toBe(0);
  });

  it('treats a zero-requirement line as unconstraining rather than NaN', () => {
    // `bundle_items` has CHECK (quantity > 0), so this cannot exist — but a
    // divide-by-zero would produce a NaN that silently poisons the MIN.
    const result = componentFulfillableQty(stock(VARIANT.pen, 0, 10));
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(Number.POSITIVE_INFINITY);
  });
});

/* ========================================================= the MIN over parts */

describe('bundleAvailability', () => {
  it('answers with the scarcest component, not the sum and not the first', () => {
    // 1 bottle + 1 pen + 1 diary against 100 / 75 / 100 is 75 bundles.
    const result = bundleAvailability([
      stock(VARIANT.bottle, 1, 100),
      stock(VARIANT.pen, 1, 75),
      stock(VARIANT.diary, 1, 100),
    ]);
    expect(result.fulfillableQty).toBe(75);
    expect(result.fulfillableQty).not.toBe(275); // the sum
    expect(result.fulfillableQty).not.toBe(100); // the first component
  });

  it('names the limiting components, so the answer is actionable', () => {
    const result = bundleAvailability([
      stock(VARIANT.bottle, 1, 100),
      stock(VARIANT.pen, 1, 75),
      stock(VARIANT.diary, 1, 100),
    ]);
    expect(result.limitingVariantIds).toEqual([VARIANT.pen]);
  });

  it('names every component tied at the minimum', () => {
    const result = bundleAvailability([
      stock(VARIANT.bottle, 1, 10),
      stock(VARIANT.pen, 1, 10),
      stock(VARIANT.diary, 1, 50),
    ]);
    expect(result.limitingVariantIds.sort()).toEqual([VARIANT.bottle, VARIANT.pen].sort());
  });

  it('divides by the required quantity, not just by 1', () => {
    // 2 pens per bundle against 75 pens is 37 bundles, not 75.
    const result = bundleAvailability([stock(VARIANT.bottle, 1, 100), stock(VARIANT.pen, 2, 75)]);
    expect(result.fulfillableQty).toBe(37);
  });

  it('is 0 when ONE component is out, however healthy the rest are', () => {
    const result = bundleAvailability([
      stock(VARIANT.bottle, 1, 5_000),
      stock(VARIANT.pen, 1, 0),
      stock(VARIANT.diary, 1, 5_000),
    ]);
    expect(result.fulfillableQty).toBe(0);
    expect(result.canFulfil).toBe(false);
    expect(result.limitingVariantIds).toEqual([VARIANT.pen]);
  });

  it('is 0 for an empty bundle, NOT infinity', () => {
    // `Math.min()` over no arguments is Infinity. "Infinitely available" is the
    // single most dangerous number this file could return.
    const result = bundleAvailability([]);
    expect(result.fulfillableQty).toBe(0);
    expect(Number.isFinite(result.fulfillableQty)).toBe(true);
    expect(result.canFulfil).toBe(false);
    expect(result.components).toEqual([]);
  });

  it('is 0 when every line is unconstraining, rather than infinity', () => {
    const result = bundleAvailability([stock(VARIANT.pen, 0, 10)]);
    expect(Number.isFinite(result.fulfillableQty)).toBe(true);
    expect(result.fulfillableQty).toBe(0);
  });
});

/* ============================================================== requestedQty */

describe('bundleAvailability — the requested quantity', () => {
  const components = [stock(VARIANT.bottle, 1, 100), stock(VARIANT.pen, 2, 75)];

  it('does not change fulfillableQty — that is the unconditional answer', () => {
    expect(bundleAvailability(components, 1).fulfillableQty).toBe(37);
    expect(bundleAvailability(components, 500).fulfillableQty).toBe(37);
  });

  it('decides canFulfil', () => {
    expect(bundleAvailability(components, 37).canFulfil).toBe(true);
    expect(bundleAvailability(components, 38).canFulfil).toBe(false);
  });

  it('scales the shortage by the requested quantity', () => {
    // 50 bundles need 100 pens; 75 are sellable, so 25 short.
    const result = bundleAvailability(components, 50);
    const pen = result.components.find((c) => c.variantId === VARIANT.pen);
    expect(pen?.shortage).toBe(25);
  });

  it('reports no shortage on a component that covers the request', () => {
    const result = bundleAvailability(components, 50);
    const bottle = result.components.find((c) => c.variantId === VARIANT.bottle);
    expect(bottle?.shortage).toBe(0);
  });

  it('floors a fractional request to at least 1', () => {
    expect(bundleAvailability(components, 0).requestedQty).toBe(1);
    expect(bundleAvailability(components, -5).requestedQty).toBe(1);
    expect(bundleAvailability(components, 2.9).requestedQty).toBe(2);
  });
});

/* =================================================================== savings */

describe('bundleSavingsPaise', () => {
  it('sums components at their quantity and subtracts the bundle price', () => {
    // 2 x ₹100 + 1 x ₹300 = ₹500 of parts, sold at ₹450: ₹50 saved.
    const result = bundleSavingsPaise(
      [
        { quantity: 2, unitPricePaise: 10_000 },
        { quantity: 1, unitPricePaise: 30_000 },
      ],
      45_000,
    );
    expect(result.componentTotalPaise).toBe(50_000);
    expect(result.savingsPaise).toBe(5_000);
  });

  it('expresses the discount in basis points', () => {
    // ₹50 off ₹500 is 10%, which is 1000 bp.
    const result = bundleSavingsPaise([{ quantity: 1, unitPricePaise: 50_000 }], 45_000);
    expect(result.savingsBp).toBe(1_000);
  });

  it('surfaces a bundle that costs MORE than its parts instead of clamping', () => {
    // A negative saving is a pricing mistake worth seeing, not one worth hiding.
    const result = bundleSavingsPaise([{ quantity: 1, unitPricePaise: 40_000 }], 45_000);
    expect(result.savingsPaise).toBe(-5_000);
    expect(result.savingsBp).toBeLessThan(0);
  });

  it('does not divide by zero on free components', () => {
    const result = bundleSavingsPaise([{ quantity: 1, unitPricePaise: 0 }], 0);
    expect(result.savingsBp).toBe(0);
    expect(Number.isNaN(result.savingsBp)).toBe(false);
  });

  it('stays in integer paise — no floats anywhere in the result', () => {
    const result = bundleSavingsPaise(
      [
        { quantity: 3, unitPricePaise: 33_333 },
        { quantity: 1, unitPricePaise: 1 },
      ],
      50_000,
    );
    expect(Number.isInteger(result.componentTotalPaise)).toBe(true);
    expect(Number.isInteger(result.savingsPaise)).toBe(true);
    expect(Number.isInteger(result.savingsBp)).toBe(true);
  });

  it('is zero-saving when the bundle is priced exactly at its parts', () => {
    const result = bundleSavingsPaise([{ quantity: 4, unitPricePaise: 12_500 }], 50_000);
    expect(result.savingsPaise).toBe(0);
    expect(result.savingsBp).toBe(0);
  });
});
