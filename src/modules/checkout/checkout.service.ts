/**
 * Checkout: the quote, and the order-creating transaction.
 *
 * The whole point of this file is that **the client cannot influence a number**.
 * The request carries a cart token, an address, a delivery choice and a payment
 * choice. Every price, every discount, every tax figure and the grand total are
 * derived here from `product_variants`, `add_ons`, `gst_rates`, `coupons` and
 * `delivery_zones` — through `checkout.pricing.ts`, which has no parameter
 * through which a caller could supply money at all.
 *
 * `POST /v1/orders` is one transaction, and the order of operations inside it is
 * load-bearing:
 *
 *   1. re-price from live catalogue state          (nothing trusted from earlier)
 *   2. claim the coupon redemption                  (§4.2 conditional UPDATE)
 *   3. lock, then conditionally reserve, stock      (§4.1 — the oversell fix)
 *   4. take the order number                        (§3.5 — as late as possible)
 *   5. write the header, then the lines
 *   6. reservations, redemption, timeline, cart
 *
 * Every checkout takes the coupon lock before the inventory locks, so two
 * concurrent checkouts can never form a cycle. The commit then runs the deferred
 * `check_order_totals()` trigger, which re-proves I1–I4 against what was actually
 * written; `assertInvariants` runs the same four checks in TypeScript first, so a
 * mistake surfaces as a readable failure rather than a `23514` at COMMIT.
 */

import { db } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { NotFoundError, UnprocessableError, ValidationError } from '../../lib/errors.js';
import { addWorkingDays, isBeforeCutoff, istDate, istTime } from '../catalogue/catalogue.service.js';
import * as cartService from '../cart/cart.service.js';
import * as payments from '../payments/payments.service.js';
import {
  DELIVERY_SURCHARGE_PAISE,
  DELIVERY_TYPES,
  assertInvariants,
  isPrepaid,
  type DeliveryType,
} from './checkout.pricing.js';
import * as repo from './checkout.repository.js';
import type {
  CheckoutAddressInput,
  CheckoutQuoteBody,
  CheckoutQuoteResponse,
  CreateOrderBody,
  OrderCreatedResponse,
} from './checkout.schemas.js';

/* ------------------------------------------------------------ destination */

type Destination = {
  addressId: string | null;
  label: string;
  contactName: string;
  mobile: string;
  line1: string;
  line2: string | null;
  area: string | null;
  city: string;
  stateCode: string;
  pincode: string;
  countryCode: string;
  saveToAddressBook: boolean;
};

async function resolveDestination(
  customerId: string,
  body: CheckoutQuoteBody,
): Promise<Destination> {
  if (body.addressId && body.address) {
    throw new ValidationError('Send either `addressId` or `address`, not both.', {
      issues: [{ path: 'addressId', code: 'custom', message: 'Mutually exclusive with `address`.' }],
    });
  }

  if (body.addressId) {
    const row = await repo.findCustomerAddress(customerId, body.addressId);
    if (!row) throw new NotFoundError('Address', body.addressId);
    return {
      addressId: row.id,
      label: row.label,
      contactName: row.contactName,
      mobile: row.mobile,
      line1: row.line1,
      line2: row.line2,
      area: row.area,
      city: row.city,
      stateCode: row.stateCode,
      pincode: row.pincode,
      countryCode: row.countryCode,
      saveToAddressBook: false,
    };
  }

  const address: CheckoutAddressInput | undefined = body.address;
  if (!address) {
    throw new ValidationError('A shipping address is required.', {
      issues: [{ path: 'address', code: 'custom', message: 'Supply `addressId` or `address`.' }],
    });
  }

  if (!(await repo.stateCodeExists(address.stateCode))) {
    throw new ValidationError('Unknown GST state code.', {
      issues: [
        {
          path: 'address.stateCode',
          code: 'custom',
          message: `“${address.stateCode}” is not an official two-digit GST state code.`,
        },
      ],
    });
  }

  return {
    addressId: null,
    label: address.label ?? 'Home',
    contactName: address.contactName,
    mobile: address.mobile,
    line1: address.line1,
    line2: address.line2 ?? null,
    area: address.area ?? null,
    city: address.city,
    stateCode: address.stateCode,
    pincode: address.pincode,
    countryCode: address.countryCode,
    saveToAddressBook: address.saveToAddressBook,
  };
}

/* ---------------------------------------------------------- delivery rules */

/** Delivery promises are made in Indian local time, so the clock is Asia/Kolkata. */
function assertDeliveryDateSane(requested: string | undefined, now: Date): void {
  if (!requested) return;
  const today = istDate(now);
  if (requested < today) {
    throw new ValidationError('The requested delivery date is in the past.', {
      issues: [
        {
          path: 'requestedDeliveryDate',
          code: 'custom',
          message: `The earliest date that can be requested is ${today} (Asia/Kolkata).`,
        },
      ],
    });
  }
}

type DeliveryAvailability = { available: boolean; reason: string | null; eta: string | null };

function availabilityFor(
  type: DeliveryType,
  destination: repo.DestinationRow | null,
  now: Date,
): DeliveryAvailability {
  if (type === 'international') {
    return { available: false, reason: 'International delivery is not available yet.', eta: null };
  }
  if (!destination || !destination.serviceable || destination.zoneStatus !== 'active') {
    return { available: false, reason: 'We do not deliver to this PIN code yet.', eta: null };
  }

  const today = istDate(now);
  const standardEta =
    destination.standardTatDays === null ? null : addWorkingDays(today, destination.standardTatDays);

  switch (type) {
    case 'standard':
      return { available: true, reason: null, eta: standardEta };
    case 'scheduled':
      return { available: true, reason: null, eta: standardEta };
    case 'same_day': {
      if (!destination.supportsSameDay) {
        return { available: false, reason: 'Same-day delivery is not offered in this area.', eta: null };
      }
      if (!isBeforeCutoff(istTime(now), destination.sameDayCutoff)) {
        return {
          available: false,
          reason: `Today’s same-day cutoff (${destination.sameDayCutoff ?? '—'}) has passed.`,
          eta: null,
        };
      }
      return { available: true, reason: null, eta: today };
    }
    case 'midnight':
      return destination.supportsMidnight
        ? { available: true, reason: null, eta: today }
        : { available: false, reason: 'Midnight delivery is not offered in this area.', eta: null };
  }
}

const codEligible = (destination: repo.DestinationRow | null): boolean =>
  Boolean(destination?.serviceable && destination.zoneStatus === 'active' && destination.supportsCod && destination.codAllowed);

/* ------------------------------------------------------------------ quote */

type QuoteContext = {
  cart: Awaited<ReturnType<typeof cartService.resolveOwnedCart>>;
  destination: Destination;
  zone: repo.DestinationRow | null;
  supply: repo.SupplyPointRow | null;
  isInterstate: boolean;
  state: Awaited<ReturnType<typeof cartService.loadCartState>>;
};

async function buildContext(
  customerId: string,
  body: CheckoutQuoteBody,
  now: Date,
): Promise<QuoteContext> {
  const cart = await cartService.resolveOwnedCart(customerId, body.cartToken);
  const destination = await resolveDestination(customerId, body);
  assertDeliveryDateSane(body.requestedDeliveryDate, now);

  const [zone, supply] = await Promise.all([repo.findDestination(destination.pincode), repo.findSupplyPoint()]);

  // B2C goods (CGST Act s.10(1)(a)): the place of supply is where the movement
  // terminates. With no warehouse configured yet we cannot know the supplier
  // state, and treating the supply as intrastate is the conservative reading.
  const isInterstate = supply ? supply.stateCode !== destination.stateCode : false;

  const state = await cartService.loadCartState(cart, {
    customerId,
    deliveryType: body.deliveryType,
    paymentMethod: body.paymentMethod,
    isInterstate,
    zoneBaseFeePaise: zone?.baseFeePaise ?? null,
    couponCodeOverride: body.couponCode,
  });

  return { cart, destination, zone, supply, isInterstate, state };
}

export async function quote(
  customerId: string,
  body: CheckoutQuoteBody,
  now = new Date(),
): Promise<CheckoutQuoteResponse> {
  const ctx = await buildContext(customerId, body, now);

  const chosen = availabilityFor(body.deliveryType, ctx.zone, now);
  const cod = codEligible(ctx.zone);
  const warnings = [...ctx.state.warnings];
  if (!chosen.available && chosen.reason) warnings.push(chosen.reason);
  if (body.paymentMethod === 'cod' && !cod) {
    warnings.push('Cash on delivery is not available for this PIN code.');
  }

  return {
    cartId: ctx.cart.id,
    currency: ctx.cart.currency,
    totals: ctx.state.breakdown,
    serviceable: Boolean(ctx.zone?.serviceable && ctx.zone.zoneStatus === 'active'),
    codEligible: cod,
    paymentMethodAllowed: body.paymentMethod === 'cod' ? cod : true,
    estimatedDeliveryDate: body.requestedDeliveryDate ?? chosen.eta,
    deliveryOptions: DELIVERY_TYPES.map((type) => {
      const availability = availabilityFor(type, ctx.zone, now);
      return {
        deliveryType: type,
        available: availability.available,
        surchargePaise: DELIVERY_SURCHARGE_PAISE[type],
        estimatedDeliveryDate: availability.eta,
        unavailableReason: availability.reason,
      };
    }),
    placeOfSupplyStateCode: ctx.destination.stateCode,
    warnings,
  };
}

/* ----------------------------------------------------------- order create */

/** Everything that must be true before a single row is written. */
function assertOrderable(ctx: QuoteContext, body: CreateOrderBody, now: Date): void {
  if (ctx.state.lines.length === 0) {
    throw new UnprocessableError('Your cart is empty.', 'cart_empty');
  }

  const dead = ctx.state.lines.filter((l) => !l.sellable);
  if (dead.length > 0) {
    throw new UnprocessableError(
      `${dead.map((l) => `“${l.title}”`).join(', ')} is no longer available. Remove it to continue.`,
      'line_unavailable',
      { context: { variantIds: dead.map((l) => l.variantId) } },
    );
  }

  const short = ctx.state.lines.filter((l) => l.availableQty < l.quantity);
  if (short.length > 0) {
    throw new UnprocessableError(
      `Not enough stock for ${short.map((l) => `“${l.title}”`).join(', ')}.`,
      'insufficient_stock',
      {
        context: {
          shortfall: short.map((l) => ({
            variantId: l.variantId,
            requested: l.quantity,
            available: Math.max(0, l.availableQty),
          })),
        },
      },
    );
  }

  if (ctx.destination.countryCode !== 'IN') {
    throw new UnprocessableError(
      'International delivery is not available yet.',
      'destination_not_serviceable',
    );
  }

  const availability = availabilityFor(body.deliveryType, ctx.zone, now);
  if (!availability.available) {
    throw new UnprocessableError(
      availability.reason ?? 'That delivery option is not available.',
      ctx.zone?.serviceable ? 'delivery_type_unavailable' : 'destination_not_serviceable',
    );
  }

  if (body.paymentMethod === 'cod' && !codEligible(ctx.zone)) {
    throw new UnprocessableError(
      'Cash on delivery is not available for this PIN code.',
      'cod_not_available',
    );
  }

  // The client asked for a coupon and it did not survive re-validation. At the
  // cart this is a warning; here it is fatal, because the shopper is about to be
  // charged a total they have not seen.
  const requested = body.couponCode === undefined ? ctx.cart.couponCode : body.couponCode || null;
  if (requested && ctx.state.coupon === null) {
    throw new UnprocessableError(
      ctx.state.warnings.at(-1) ?? `Coupon ${requested.toUpperCase()} can no longer be applied.`,
      'coupon_not_applicable',
    );
  }
}

/**
 * Pick ONE warehouse that can satisfy every line.
 *
 * `orders.fulfilment_warehouse_id` is a single column, and splitting a gift
 * hamper across two dispatch points is a shipments-level decision, not an
 * order-level one. Deterministic: most satisfiable lines wins, ties broken by
 * warehouse id, so two concurrent identical carts choose the same warehouse and
 * therefore contend on the same rows rather than half-reserving two.
 */
function chooseWarehouse(
  levels: readonly repo.InventoryLevelRow[],
  needed: ReadonlyMap<string, number>,
): { warehouseId: string; levelByVariant: Map<string, repo.InventoryLevelRow> } | null {
  const byWarehouse = new Map<string, Map<string, repo.InventoryLevelRow>>();
  for (const level of levels) {
    const bucket = byWarehouse.get(level.warehouseId) ?? new Map<string, repo.InventoryLevelRow>();
    bucket.set(level.variantId, level);
    byWarehouse.set(level.warehouseId, bucket);
  }

  let best: { warehouseId: string; levelByVariant: Map<string, repo.InventoryLevelRow>; score: number } | null =
    null;

  for (const [warehouseId, levelByVariant] of [...byWarehouse.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    let score = 0;
    for (const [variantId, qty] of needed) {
      const level = levelByVariant.get(variantId);
      if (level && level.availableQty >= qty) score += 1;
    }
    if (!best || score > best.score) best = { warehouseId, levelByVariant, score };
  }

  if (!best || best.score < needed.size) return null;
  return { warehouseId: best.warehouseId, levelByVariant: best.levelByVariant };
}

export async function createOrder(
  customerId: string,
  body: CreateOrderBody,
  now = new Date(),
): Promise<OrderCreatedResponse> {
  const ctx = await buildContext(customerId, body, now);
  assertOrderable(ctx, body, now);

  const breakdown = ctx.state.breakdown;
  // The four invariants the deferred trigger will re-test at COMMIT. Failing
  // here is a readable 500 in this service; failing there is a 23514 with the
  // payment intent already in flight.
  assertInvariants(breakdown);

  const profile = await repo.findCustomerProfile(customerId);
  const pricedByLine = new Map(breakdown.lines.map((l) => [l.lineId, l]));

  const needed = new Map<string, number>();
  for (const line of ctx.state.lines) {
    needed.set(line.variantId, (needed.get(line.variantId) ?? 0) + line.quantity);
  }
  const levels = await repo.findInventoryLevels([...needed.keys()]);
  const chosen = chooseWarehouse(levels, needed);
  if (!chosen) {
    throw new UnprocessableError(
      'We cannot fulfil every item in this order from a single warehouse right now.',
      'insufficient_stock',
    );
  }

  const prepaid = isPrepaid(body.paymentMethod);
  const personalisedLines = ctx.state.lines.filter(
    (l) => l.personalisation && Object.keys(l.personalisation).length > 0,
  );

  const tags: string[] = [];
  if (body.giftMessage) tags.push('gift-message');
  if (personalisedLines.length > 0) tags.push('personalised');
  if (body.isGift) tags.push('gift');

  const created = await db.transaction(async (tx) => {
    /* 1 — coupon. Its row lock is taken first by every checkout, so the lock
           order across the two contended resources is always coupon → inventory
           and no cycle can form. */
    if (ctx.state.coupon) {
      const claim = await repo.claimCouponRedemption(tx, ctx.state.coupon.id);
      if (!claim) {
        throw new UnprocessableError(
          `Coupon ${ctx.state.coupon.code} is no longer available.`,
          'coupon_exhausted',
        );
      }
      const used = await repo.countCustomerRedemptionsForUpdate(tx, ctx.state.coupon.id, customerId);
      if (used >= claim.maxRedemptionsPerCustomer) {
        throw new UnprocessableError(
          `You have already used coupon ${ctx.state.coupon.code} the maximum number of times.`,
          'coupon_customer_limit',
        );
      }
    }

    /* 2 — stock. Lock every level this transaction touches in id order, then
           reserve each with the conditional UPDATE. */
    const reservations: { inventoryLevelId: string; quantity: number }[] = [];
    for (const [variantId, quantity] of needed) {
      const level = chosen.levelByVariant.get(variantId);
      if (!level) {
        throw new UnprocessableError('That item is no longer in stock.', 'insufficient_stock', {
          context: { variantId },
        });
      }
      reservations.push({ inventoryLevelId: level.id, quantity });
    }

    await repo.lockInventoryLevels(
      tx,
      reservations.map((r) => r.inventoryLevelId),
    );

    for (const reservation of reservations) {
      const held = await repo.reserveStock(tx, reservation.inventoryLevelId, reservation.quantity);
      if (!held) {
        const variantId = [...chosen.levelByVariant.entries()].find(
          ([, level]) => level.id === reservation.inventoryLevelId,
        )?.[0];
        throw new UnprocessableError(
          'Someone bought the last of one of these while you were checking out.',
          'insufficient_stock',
          { context: { variantId } },
        );
      }
    }

    /* 3 — the order number, as late as possible: the series row lock is held
           from here to COMMIT and serialises every concurrent order. */
    const orderNo = await repo.nextOrderNumber(tx);

    /* 4 — header. */
    const order = await repo.insertOrder(tx, {
      orderNo,
      customerId,
      cartId: ctx.cart.id,
      channel: 'website',
      currency: ctx.cart.currency,
      buyerName: body.buyerName ?? profile?.fullName ?? ctx.destination.contactName,
      buyerEmail: body.buyerEmail ?? profile?.email ?? null,
      buyerMobile: body.buyerMobile ?? profile?.mobile ?? ctx.destination.mobile,
      recipientName: body.recipientName ?? null,
      recipientMobile: body.recipientMobile ?? null,
      isAnonymousGift: body.isAnonymousGift,
      giftMessage: body.giftMessage ?? null,
      shipLine1: ctx.destination.line1,
      shipLine2: ctx.destination.line2,
      shipArea: ctx.destination.area,
      shipCity: ctx.destination.city,
      shipStateCode: ctx.destination.stateCode,
      shipPincode: ctx.destination.pincode,
      shipCountryCode: ctx.destination.countryCode,
      billSameAsShip: true,
      billGstin: body.billGstin ?? null,
      placeOfSupplyStateCode: ctx.destination.stateCode,
      supplierGstin: ctx.supply?.gstin ?? null,
      supplierStateCode: ctx.supply?.stateCode ?? null,
      isInterstate: ctx.isInterstate,
      deliveryType: body.deliveryType,
      requestedDeliveryDate: body.requestedDeliveryDate ?? null,
      deliverySlot: body.deliverySlot ?? null,
      fulfilmentWarehouseId: chosen.warehouseId,
      subtotalPaise: breakdown.subtotalPaise,
      couponDiscountPaise: breakdown.couponDiscountPaise,
      autoDiscountPaise: 0,
      loyaltyDiscountPaise: 0,
      shippingPaise: breakdown.shippingPaise,
      codFeePaise: breakdown.codFeePaise,
      taxablePaise: breakdown.taxablePaise,
      cgstPaise: breakdown.cgstPaise,
      sgstPaise: breakdown.sgstPaise,
      igstPaise: breakdown.igstPaise,
      cessPaise: breakdown.cessPaise,
      roundOffPaise: breakdown.roundOffPaise,
      totalPaise: breakdown.totalPaise,
      couponCode: ctx.state.coupon?.code ?? null,
      status: prepaid ? 'pending_payment' : 'confirmed',
      paymentStatus: prepaid ? 'pending' : 'cod_due',
      confirmedAt: prepaid ? null : now,
      tags,
    });

    /* 5 — lines. `unitPricePaise` is the ALL-IN per-unit price (variant plus its
           add-ons), so `unit_price_paise * quantity` equals the line total and
           the `order_line_discount_bounds` CHECK holds even for a 100% coupon on
           a line whose add-ons cost more than the variant. The add-ons are still
           itemised in `order_line_add_ons` — they have to be, or they cannot be
           taxed on the invoice. */
    const lineValues = ctx.state.lines.map((line, index) => {
      const priced = pricedByLine.get(line.id);
      if (!priced) throw new Error(`pricing produced no line for cart line ${line.id}`);
      return {
        orderId: order.id,
        variantId: line.variantId,
        skuSnapshot: line.sku,
        titleSnapshot: line.title,
        variantLabelSnapshot: line.variantLabel,
        imageUrlSnapshot: line.imageUrl,
        hsnSnapshot: line.hsnCode,
        quantity: line.quantity,
        unitPricePaise: priced.unitPricePaise + priced.addOnsPaise,
        lineDiscountPaise: 0,
        allocatedOrderDiscountPaise: priced.allocatedOrderDiscountPaise,
        grossPaise: priced.grossPaise,
        gstRateBp: priced.gstRateBp,
        taxablePaise: priced.taxablePaise,
        cgstPaise: priced.cgstPaise,
        sgstPaise: priced.sgstPaise,
        igstPaise: priced.igstPaise,
        cessPaise: priced.cessPaise,
        position: index,
      };
    });

    const orderLineIds = await repo.insertOrderLines(tx, lineValues);

    const addOnValues = ctx.state.lines.flatMap((line, index) => {
      const orderLineId = orderLineIds[index];
      if (!orderLineId) return [];
      const priced = pricedByLine.get(line.id);
      return (ctx.state.addOnsByLine.get(line.id) ?? [])
        .filter((a) => a.active)
        .map((a) => ({
          orderLineId,
          addOnId: a.addOnId,
          nameSnapshot: a.name,
          pricePaise: a.pricePaise,
          quantity: line.quantity,
          inputText: a.inputText,
          // Composite supply (assumption A5): an add-on incidental to the gift is
          // taxed at the principal supply's rate, not separately at 18%.
          gstRateBp: priced?.gstRateBp ?? 0,
        }));
    });
    await repo.insertOrderLineAddOns(tx, addOnValues);

    const personalisationValues = ctx.state.lines.flatMap((line, index) => {
      const orderLineId = orderLineIds[index];
      const entries = Object.entries(line.personalisation ?? {});
      if (!orderLineId || entries.length === 0) return [];
      return [
        {
          orderLineId,
          method: 'custom',
          inputText: entries.map(([key, value]) => `${key}: ${value}`).join(' | '),
          proofStatus: 'pending' as const,
        },
      ];
    });
    await repo.insertOrderLinePersonalisations(tx, personalisationValues);

    /* 6 — reservations, redemption, timeline, cart. */
    await repo.insertReservations(tx, order.id, reservations);

    if (ctx.state.coupon) {
      await repo.insertCouponRedemption(tx, {
        couponId: ctx.state.coupon.id,
        orderId: order.id,
        customerId,
        discountPaise: breakdown.couponDiscountPaise,
      });
    }

    await repo.insertTimelineEvent(tx, {
      orderId: order.id,
      eventType: 'order.placed',
      label: 'Order placed',
      actorKind: 'customer',
      metadata: { channel: 'website', paymentMethod: body.paymentMethod },
    });

    if (!prepaid) {
      await repo.insertTimelineEvent(tx, {
        orderId: order.id,
        eventType: 'order.confirmed',
        label: 'Confirmed — cash on delivery',
        actorKind: 'system',
      });
    }

    if (ctx.destination.saveToAddressBook && ctx.destination.addressId === null) {
      await repo.insertAddress(
        {
          customerId,
          label: ctx.destination.label,
          contactName: ctx.destination.contactName,
          mobile: ctx.destination.mobile,
          line1: ctx.destination.line1,
          line2: ctx.destination.line2,
          area: ctx.destination.area,
          city: ctx.destination.city,
          stateCode: ctx.destination.stateCode,
          pincode: ctx.destination.pincode,
          countryCode: ctx.destination.countryCode,
        },
        tx,
      );
    }

    await repo.markCartConverted(tx, ctx.cart.id, order.id);

    return { id: order.id, orderNo, placedAt: order.placedAt };
  });

  /* Gateway I/O happens strictly AFTER commit: a 3-second Razorpay timeout
     inside the transaction would hold the numbering row lock and stall every
     other checkout (§3.5 rule 2). If it fails the order still exists in
     pending_payment and the client retries via POST /v1/payments/razorpay/order. */
  let payment: OrderCreatedResponse['payment'] = null;
  if (prepaid) {
    try {
      payment = await payments.createPaymentSession(created.id, customerId);
    } catch (err) {
      logger.error(
        { err, orderId: created.id, orderNo: created.orderNo },
        'order committed but the Razorpay session could not be created',
      );
    }
  }

  return {
    orderId: created.id,
    orderNo: created.orderNo,
    status: prepaid ? 'pending_payment' : 'confirmed',
    paymentStatus: prepaid ? 'pending' : 'cod_due',
    totalPaise: breakdown.totalPaise,
    currency: ctx.cart.currency,
    placedAt: created.placedAt.toISOString(),
    totals: breakdown,
    payment,
  };
}
