/**
 * THE PRICING ENGINE — the single place any money figure in this system is decided.
 *
 * Deliberately PURE: no database, no `req`, no clock beyond what is passed in. It
 * takes rows that were already read from the catalogue and returns the complete
 * breakdown. That is what makes it exhaustively testable, and it is why both the
 * cart module and the checkout module call it rather than each growing its own
 * arithmetic (which is exactly how the storefront ended up computing discounts in
 * the browser — `store/src/lib/store.ts:100-108`).
 *
 * Two rules are absolute here:
 *
 *  1. Nothing in the input comes from the client except IDs and quantities.
 *     `unitPricePaise` is read from `product_variants` at compute time, never from
 *     `cart_lines.unit_price_paise` (that column is a display snapshot only) and
 *     never from a request body. There is no parameter on any function in this
 *     file through which a caller could supply a price, a discount or a total.
 *
 *  2. Every value is integer paise (`lib/money.ts`). Order-level discounts are
 *     pushed down to lines with `allocate()` so the parts sum EXACTLY to the
 *     whole — each line needs its own taxable value for the GST invoice, and the
 *     deferred `check_order_totals()` trigger (03_schema.md §4.4) rejects the
 *     transaction if they disagree by a single paisa.
 *
 * Tax model (03_schema.md §3.2, assumption A4): catalogue prices are GST-INCLUSIVE,
 * so tax is back-computed per line at that line's own HSN rate, and `taxable` is
 * derived first with `tax` taken as the remainder — which makes
 * `taxable + tax = gross` true by construction rather than by reconciliation.
 */
import { UnprocessableError } from '../../lib/errors.js';
import { allocate, assertPaise, type BasisPoints, type Paise } from '../../lib/money.js';

/** Mirrors `orders.delivery_type` (03_schema.md §2.6). */
export const DELIVERY_TYPES = ['standard', 'scheduled', 'same_day', 'midnight', 'international'] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

/** Mirrors `payments.method`, narrowed to what the storefront can actually offer. */
export const PAYMENT_METHODS = ['upi', 'credit_card', 'debit_card', 'net_banking', 'wallet', 'cod'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PREPAID_METHODS: readonly PaymentMethod[] = [
  'upi',
  'credit_card',
  'debit_card',
  'net_banking',
  'wallet',
];

export const isPrepaid = (method: PaymentMethod): boolean => PREPAID_METHODS.includes(method);

/**
 * Delivery-method surcharges.
 *
 * The storefront hardcodes standard ₹0 / express ₹249 / same-day ₹499
 * (`store/src/routes/checkout.tsx:38-42`) in the browser. Mapped onto the
 * `orders.delivery_type` enum the database actually has. These belong in
 * `shipping_rules` eventually (03_schema.md §2.9) — until that table is seeded,
 * they live here, server-side, where a client cannot reach them.
 */
export const DELIVERY_SURCHARGE_PAISE: Readonly<Record<DeliveryType, Paise>> = {
  standard: 0,
  scheduled: 24_900,
  same_day: 49_900,
  midnight: 49_900,
  international: 0,
};

/** Personalisation limits, re-enforced server-side (01_storefront_api.md §3). */
export const PERSONALISATION_LIMITS = {
  name: 24,
  message: 180,
  giftMessage: 240,
  /** Any other free-text personalisation key falls back to this. */
  default: 180,
} as const;

// ─────────────────────────────────────────────────────────────── inputs

export type PricedLineInput = {
  /** `cart_lines.id` or, for a direct quote, any stable key. */
  lineId: string;
  variantId: string;
  productId: string;
  /** Used for coupon scoping (`coupon_scope.collection_id`). */
  collectionIds: readonly string[];
  quantity: number;
  /** LIVE `product_variants.price_paise`. GST-inclusive. Never client-supplied. */
  unitPricePaise: Paise;
  /** Sum of the line's add-on prices, PER UNIT. See `addOnsPaise` note below. */
  addOnsPaise: Paise;
  /** Resolved from `gst_rates` for the line's HSN on the supply date. */
  gstRateBp: BasisPoints;
  cessRateBp: BasisPoints;
};

export type CouponRow = {
  id: string;
  code: string;
  discountType: 'percent' | 'flat' | 'free_shipping' | 'bogo' | 'free_gift';
  discountBp: BasisPoints | null;
  discountPaise: Paise | null;
  maxDiscountPaise: Paise | null;
  minOrderPaise: Paise;
  appliesTo: 'all' | 'collections' | 'products' | 'first_order';
  scopeProductIds: readonly string[];
  scopeCollectionIds: readonly string[];
  excludedProductIds: readonly string[];
  excludedCollectionIds: readonly string[];
};

export type ShippingConfig = {
  /** `env.FREE_SHIPPING_THRESHOLD_PAISE` — ₹999 by published policy. */
  freeThresholdPaise: Paise;
  /** `env.SHIPPING_FEE_PAISE` — ₹149 by published policy. */
  flatFeePaise: Paise;
  /** `delivery_zones.base_fee_paise` when the pincode resolves to a zone. */
  zoneBaseFeePaise: Paise | null;
};

export type PricingInput = {
  lines: readonly PricedLineInput[];
  coupon: CouponRow | null;
  deliveryType: DeliveryType;
  paymentMethod: PaymentMethod;
  shipping: ShippingConfig;
  /** True when supplier state ≠ place of supply. Drives IGST vs CGST+SGST. */
  isInterstate: boolean;
  /** For `applies_to = 'first_order'`. Guests count as 0. */
  customerOrderCount: number;
};

// ────────────────────────────────────────────────────────────── outputs

export type PricedLine = {
  lineId: string;
  variantId: string;
  quantity: number;
  unitPricePaise: Paise;
  addOnsPaise: Paise;
  /** `quantity * (unitPrice + addOns)` — before any discount. Display figure. */
  lineTotalPaise: Paise;
  /** This line's share of the order-level discount. Sums EXACTLY to the whole. */
  allocatedOrderDiscountPaise: Paise;
  /** `order_lines.gross_paise` — net of every discount. Invariant I1 sums these. */
  grossPaise: Paise;
  gstRateBp: BasisPoints;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
};

export type PriceBreakdown = {
  lines: PricedLine[];
  itemCount: number;
  /** Pre-discount merchandise value. What the cart page labels "Subtotal". */
  merchandisePaise: Paise;
  couponCode: string | null;
  couponDiscountPaise: Paise;
  /** `orders.subtotal_paise` = SUM(line.grossPaise). Invariant I1. */
  subtotalPaise: Paise;
  shippingPaise: Paise;
  codFeePaise: Paise;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
  roundOffPaise: Paise;
  /** `orders.total_paise` = subtotal + shipping + cod + roundOff. Invariant I3. */
  totalPaise: Paise;
  isInterstate: boolean;
};

// ─────────────────────────────────────────────────────────────── the maths

/**
 * TypeScript twin of the `split_inclusive_tax()` SQL function (03_schema.md §3.2).
 *
 * Post-condition in BOTH branches: `taxable + cgst + sgst + igst + cess = gross`.
 * The odd paisa of an intrastate split is absorbed into `taxable` rather than
 * breaking the `cgst = sgst` equality, because that equality is a CHECK on both
 * `orders` and `invoices` and is a matter of law, not of rounding preference.
 */
export function splitInclusiveTax(
  gross: Paise,
  gstRateBp: BasisPoints,
  cessRateBp: BasisPoints,
  isInterstate: boolean,
): { taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise; cessPaise: Paise } {
  assertPaise(gross, 'gross');
  const combinedBp = gstRateBp + cessRateBp;

  let taxable = Math.round((gross * 10_000) / (10_000 + combinedBp));
  const cess = cessRateBp > 0 ? Math.round((taxable * cessRateBp) / 10_000) : 0;
  const gstTax = gross - taxable - cess;

  if (isInterstate) {
    return { taxablePaise: taxable, cgstPaise: 0, sgstPaise: 0, igstPaise: gstTax, cessPaise: cess };
  }

  const half = Math.floor(gstTax / 2);
  taxable = gross - cess - 2 * half;
  return { taxablePaise: taxable, cgstPaise: half, sgstPaise: half, igstPaise: 0, cessPaise: cess };
}

const lineIsEligible = (line: PricedLineInput, coupon: CouponRow): boolean => {
  if (coupon.excludedProductIds.includes(line.productId)) return false;
  if (line.collectionIds.some((c) => coupon.excludedCollectionIds.includes(c))) return false;

  switch (coupon.appliesTo) {
    case 'products':
      return coupon.scopeProductIds.includes(line.productId);
    case 'collections':
      return line.collectionIds.some((c) => coupon.scopeCollectionIds.includes(c));
    case 'all':
    case 'first_order':
      return true;
  }
};

export type CouponEvaluation = {
  discountPaise: Paise;
  freeShipping: boolean;
  /** Lines the discount is allocated across. Never empty when discount > 0. */
  eligibleLineIds: readonly string[];
};

/**
 * Decides what a coupon is worth, from the coupon row and the live cart.
 *
 * Throws `UnprocessableError` with a stable machine code rather than silently
 * returning zero — a coupon the customer typed and that quietly did nothing is a
 * support ticket. The frontend switches on `code`.
 */
export function evaluateCoupon(
  coupon: CouponRow,
  lines: readonly PricedLineInput[],
  ctx: { merchandisePaise: Paise; customerOrderCount: number },
): CouponEvaluation {
  if (coupon.discountType === 'bogo' || coupon.discountType === 'free_gift') {
    throw new UnprocessableError(
      `Coupon ${coupon.code} cannot be applied online. Please contact support.`,
      'coupon_type_unsupported',
    );
  }

  if (coupon.appliesTo === 'first_order' && ctx.customerOrderCount > 0) {
    throw new UnprocessableError(
      `Coupon ${coupon.code} is valid on your first order only.`,
      'coupon_first_order_only',
    );
  }

  // The client checks this too (`store.ts:104`). The client's check is decoration.
  if (ctx.merchandisePaise < coupon.minOrderPaise) {
    throw new UnprocessableError(
      `Coupon ${coupon.code} requires a minimum order value of ₹${(coupon.minOrderPaise / 100).toFixed(2)}.`,
      'coupon_min_not_met',
      { context: { minOrderPaise: coupon.minOrderPaise, merchandisePaise: ctx.merchandisePaise } },
    );
  }

  const eligible = lines.filter((l) => lineIsEligible(l, coupon));
  if (eligible.length === 0) {
    throw new UnprocessableError(
      `Coupon ${coupon.code} does not apply to anything in your cart.`,
      'coupon_not_applicable',
    );
  }

  const eligibleIds = eligible.map((l) => l.lineId);

  if (coupon.discountType === 'free_shipping') {
    return { discountPaise: 0, freeShipping: true, eligibleLineIds: eligibleIds };
  }

  const eligibleValue = eligible.reduce(
    (acc, l) => acc + l.quantity * (l.unitPricePaise + l.addOnsPaise),
    0,
  );

  let discount: Paise;
  if (coupon.discountType === 'percent') {
    const bp = coupon.discountBp ?? 0;
    discount = Math.round((eligibleValue * bp) / 10_000);
    if (coupon.maxDiscountPaise !== null) discount = Math.min(discount, coupon.maxDiscountPaise);
  } else {
    discount = coupon.discountPaise ?? 0;
  }

  // A discount may never exceed what it is discounting. Without this clamp a
  // ₹500 flat coupon on a ₹300 cart produces a negative total, which
  // `nonneg_paise` would reject at the write — after the payment intent exists.
  discount = Math.max(0, Math.min(discount, eligibleValue));

  return { discountPaise: discount, freeShipping: false, eligibleLineIds: eligibleIds };
}

/**
 * Shipping fee, server-side.
 *
 * Note the deliberate change from the storefront: the free-shipping threshold is
 * tested against the merchandise value AFTER discount, not before
 * (`store/src/routes/cart.tsx:28` tests the pre-discount subtotal). Testing
 * pre-discount lets a coupon take an order below the threshold while keeping the
 * free shipping it no longer qualifies for.
 */
export function computeShipping(
  subtotalAfterDiscount: Paise,
  deliveryType: DeliveryType,
  config: ShippingConfig,
  freeShippingCoupon: boolean,
): Paise {
  const base =
    subtotalAfterDiscount >= config.freeThresholdPaise
      ? 0
      : (config.zoneBaseFeePaise ?? config.flatFeePaise);

  // A free-shipping coupon waives the base fee. It does not waive a delivery
  // UPGRADE the customer chose to buy.
  return (freeShippingCoupon ? 0 : base) + DELIVERY_SURCHARGE_PAISE[deliveryType];
}

/** `orders.round_off_paise` — reconciles the grand total to the nearest rupee. Bounded ±50. */
export function roundOffFor(rawTotal: Paise): Paise {
  const rounded = Math.round(rawTotal / 100) * 100;
  return rounded - rawTotal;
}

/**
 * The whole computation, in the order the invariants require.
 *
 * Returns a breakdown that satisfies, by construction:
 *   I1  subtotalPaise      = Σ line.grossPaise
 *   I2  couponDiscountPaise = Σ line.allocatedOrderDiscountPaise
 *   I3  totalPaise         = subtotal + shipping + codFee + roundOff
 *   I4  order tax rollup   = Σ line tax
 */
export function priceCart(input: PricingInput): PriceBreakdown {
  const { lines, coupon, shipping, isInterstate } = input;

  for (const l of lines) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity <= 0) {
      throw new UnprocessableError(`Line ${l.lineId} has an invalid quantity.`, 'invalid_quantity');
    }
    assertPaise(l.unitPricePaise, 'unitPricePaise');
    assertPaise(l.addOnsPaise, 'addOnsPaise');
  }

  const lineTotals = lines.map((l) => l.quantity * (l.unitPricePaise + l.addOnsPaise));
  const merchandisePaise = lineTotals.reduce((a, b) => a + b, 0);
  const itemCount = lines.reduce((a, l) => a + l.quantity, 0);

  const evaluation: CouponEvaluation | null =
    coupon === null
      ? null
      : evaluateCoupon(coupon, lines, {
          merchandisePaise,
          customerOrderCount: input.customerOrderCount,
        });

  const couponDiscountPaise = evaluation?.discountPaise ?? 0;

  // Allocate the order-level discount down to the ELIGIBLE lines only, weighted
  // by line value. Ineligible lines get exactly zero. largest-remainder, so the
  // parts sum to the whole with no drift.
  const eligibleIds = new Set(evaluation?.eligibleLineIds ?? []);
  const weights = lines.map((l, i) => (eligibleIds.has(l.lineId) ? (lineTotals[i] ?? 0) : 0));
  const allocated =
    couponDiscountPaise > 0 ? allocate(couponDiscountPaise, weights) : lines.map(() => 0);

  const pricedLines: PricedLine[] = lines.map((l, i) => {
    const lineTotal = lineTotals[i] ?? 0;
    const alloc = allocated[i] ?? 0;
    const gross = lineTotal - alloc;
    const tax = splitInclusiveTax(gross, l.gstRateBp, l.cessRateBp, isInterstate);
    return {
      lineId: l.lineId,
      variantId: l.variantId,
      quantity: l.quantity,
      unitPricePaise: l.unitPricePaise,
      addOnsPaise: l.addOnsPaise,
      lineTotalPaise: lineTotal,
      allocatedOrderDiscountPaise: alloc,
      grossPaise: gross,
      gstRateBp: l.gstRateBp,
      ...tax,
    };
  });

  const subtotalPaise = pricedLines.reduce((a, l) => a + l.grossPaise, 0);
  const shippingPaise = computeShipping(
    subtotalPaise,
    input.deliveryType,
    shipping,
    evaluation?.freeShipping ?? false,
  );
  // COD attracts no handling fee today. The column exists and is wired through so
  // introducing one is a constant, not a schema change.
  const codFeePaise = 0;

  const rawTotal = subtotalPaise + shippingPaise + codFeePaise;
  const roundOffPaise = roundOffFor(rawTotal);

  return {
    lines: pricedLines,
    itemCount,
    merchandisePaise,
    couponCode: coupon?.code ?? null,
    couponDiscountPaise,
    subtotalPaise,
    shippingPaise,
    codFeePaise,
    taxablePaise: pricedLines.reduce((a, l) => a + l.taxablePaise, 0),
    cgstPaise: pricedLines.reduce((a, l) => a + l.cgstPaise, 0),
    sgstPaise: pricedLines.reduce((a, l) => a + l.sgstPaise, 0),
    igstPaise: pricedLines.reduce((a, l) => a + l.igstPaise, 0),
    cessPaise: pricedLines.reduce((a, l) => a + l.cessPaise, 0),
    roundOffPaise,
    totalPaise: rawTotal + roundOffPaise,
    isInterstate,
  };
}

/**
 * Asserts the four invariants the deferred `check_order_totals()` trigger will
 * test at COMMIT. Called before the INSERT so a mistake surfaces as a readable
 * 500 in the service rather than a `23514` from the database at commit time.
 */
export function assertInvariants(b: PriceBreakdown): void {
  const sumGross = b.lines.reduce((a, l) => a + l.grossPaise, 0);
  const sumAlloc = b.lines.reduce((a, l) => a + l.allocatedOrderDiscountPaise, 0);
  const sumTax = b.lines.reduce(
    (a, l) => a + l.taxablePaise + l.cgstPaise + l.sgstPaise + l.igstPaise + l.cessPaise,
    0,
  );
  const headerTax =
    b.taxablePaise + b.cgstPaise + b.sgstPaise + b.igstPaise + b.cessPaise;

  if (b.subtotalPaise !== sumGross) throw new Error(`pricing I1 violated: ${b.subtotalPaise} <> ${sumGross}`);
  if (b.couponDiscountPaise !== sumAlloc) throw new Error(`pricing I2 violated: ${b.couponDiscountPaise} <> ${sumAlloc}`);
  if (b.totalPaise !== b.subtotalPaise + b.shippingPaise + b.codFeePaise + b.roundOffPaise) {
    throw new Error(`pricing I3 violated: total ${b.totalPaise} does not reconcile`);
  }
  if (headerTax !== sumTax) throw new Error(`pricing I4 violated: ${headerTax} <> ${sumTax}`);
  if (Math.abs(b.roundOffPaise) > 50) throw new Error(`round-off ${b.roundOffPaise} outside ±50`);
}
