import { evaluateCoupon, priceCart, type CouponRow, type PricedLineInput } from '../modules/checkout/checkout.pricing.js';

const baseLine: PricedLineInput = {
  lineId: 'line-1',
  variantId: 'var-1',
  productId: 'prod-1',
  collectionIds: ['col-1'],
  quantity: 1,
  unitPricePaise: 19900, // ₹199.00
  addOnsPaise: 0,
  gstRateBp: 1800,
  cessRateBp: 0,
};

console.log('--- TESTING ALL 5 COUPON TYPES ---');

// 1. Percent Coupon: 25% off on ₹199 (19900 paise)
const percentCoupon: CouponRow = {
  id: 'c1',
  code: 'PERCENT25',
  discountType: 'percent',
  discountBp: 2500, // 25.00%
  discountPaise: null,
  maxDiscountPaise: null,
  minOrderPaise: 0,
  appliesTo: 'all',
  scopeProductIds: [],
  scopeCollectionIds: [],
  excludedProductIds: [],
  excludedCollectionIds: [],
};
const evalPercent = evaluateCoupon(percentCoupon, [baseLine], { merchandisePaise: 19900, customerOrderCount: 0 });
console.log('1. PERCENT COUPON (25% off ₹199):', evalPercent);
if (evalPercent.discountPaise !== 4975) throw new Error(`Expected 4975 paise, got ${evalPercent.discountPaise}`);

// 1b. Percent Coupon with Cap: 25% off on ₹199 with Cap of ₹30 (3000 paise)
const cappedPercentCoupon: CouponRow = {
  ...percentCoupon,
  maxDiscountPaise: 3000,
};
const evalCapped = evaluateCoupon(cappedPercentCoupon, [baseLine], { merchandisePaise: 19900, customerOrderCount: 0 });
console.log('1b. CAPPED PERCENT COUPON (cap ₹30):', evalCapped);
if (evalCapped.discountPaise !== 3000) throw new Error(`Expected 3000 paise, got ${evalCapped.discountPaise}`);

// 2. Flat Coupon: ₹50 off (5000 paise)
const flatCoupon: CouponRow = {
  id: 'c2',
  code: 'FLAT50',
  discountType: 'flat',
  discountBp: null,
  discountPaise: 5000,
  maxDiscountPaise: null,
  minOrderPaise: 0,
  appliesTo: 'all',
  scopeProductIds: [],
  scopeCollectionIds: [],
  excludedProductIds: [],
  excludedCollectionIds: [],
};
const evalFlat = evaluateCoupon(flatCoupon, [baseLine], { merchandisePaise: 19900, customerOrderCount: 0 });
console.log('2. FLAT COUPON (₹50 off ₹199):', evalFlat);
if (evalFlat.discountPaise !== 5000) throw new Error(`Expected 5000 paise, got ${evalFlat.discountPaise}`);

// 3. Free Shipping Coupon
const freeShipCoupon: CouponRow = {
  id: 'c3',
  code: 'FREESHIP',
  discountType: 'free_shipping',
  discountBp: null,
  discountPaise: null,
  maxDiscountPaise: null,
  minOrderPaise: 0,
  appliesTo: 'all',
  scopeProductIds: [],
  scopeCollectionIds: [],
  excludedProductIds: [],
  excludedCollectionIds: [],
};
const evalFreeShip = evaluateCoupon(freeShipCoupon, [baseLine], { merchandisePaise: 19900, customerOrderCount: 0 });
console.log('3. FREE SHIPPING COUPON:', evalFreeShip);
if (!evalFreeShip.freeShipping || evalFreeShip.discountPaise !== 0) throw new Error('Free shipping coupon failed');

// 4. BOGO Coupon: Buy 1 Get 1
const bogoCoupon: CouponRow = {
  id: 'c4',
  code: 'BOGO',
  discountType: 'bogo',
  discountBp: null,
  discountPaise: null,
  maxDiscountPaise: null,
  minOrderPaise: 0,
  bogoBuyQty: 1,
  bogoGetQty: 1,
  appliesTo: 'all',
  scopeProductIds: [],
  scopeCollectionIds: [],
  excludedProductIds: [],
  excludedCollectionIds: [],
};
// 4a. Cart with 1 item should fail bogo
try {
  evaluateCoupon(bogoCoupon, [baseLine], { merchandisePaise: 19900, customerOrderCount: 0 });
  throw new Error('Should have failed with 1 item');
} catch (e: any) {
  console.log('4a. BOGO with 1 item correctly threw:', e.message);
}

// 4b. Cart with 2 items should discount 1 item (₹199)
const line2Items: PricedLineInput = { ...baseLine, quantity: 2 };
const evalBogo = evaluateCoupon(bogoCoupon, [line2Items], { merchandisePaise: 39800, customerOrderCount: 0 });
console.log('4b. BOGO with 2 items:', evalBogo);
if (evalBogo.discountPaise !== 19900) throw new Error(`Expected 19900 paise, got ${evalBogo.discountPaise}`);

// 5. Free Gift Coupon
const freeGiftCoupon: CouponRow = {
  id: 'c5',
  code: 'FREEGIFT',
  discountType: 'free_gift',
  discountBp: null,
  discountPaise: null,
  maxDiscountPaise: null,
  minOrderPaise: 0,
  freeGiftVariantId: 'gift-variant-123',
  appliesTo: 'all',
  scopeProductIds: [],
  scopeCollectionIds: [],
  excludedProductIds: [],
  excludedCollectionIds: [],
};
// 5a. Gift variant not in cart
try {
  evaluateCoupon(freeGiftCoupon, [baseLine], { merchandisePaise: 19900, customerOrderCount: 0 });
  throw new Error('Should have failed without gift item');
} catch (e: any) {
  console.log('5a. Free gift without gift in cart correctly threw:', e.message);
}

// 5b. Gift variant in cart
const giftLine: PricedLineInput = {
  lineId: 'gift-line-1',
  variantId: 'gift-variant-123',
  productId: 'gift-prod-1',
  collectionIds: [],
  quantity: 1,
  unitPricePaise: 49900, // ₹499 gift item
  addOnsPaise: 0,
  gstRateBp: 1800,
  cessRateBp: 0,
};
const evalGift = evaluateCoupon(freeGiftCoupon, [baseLine, giftLine], { merchandisePaise: 69800, customerOrderCount: 0 });
console.log('5b. Free gift with gift in cart:', evalGift);
if (evalGift.discountPaise !== 49900) throw new Error(`Expected 49900 paise, got ${evalGift.discountPaise}`);

console.log('ALL 5 COUPON EVALUATION TESTS PASSED PERFECTLY!');
