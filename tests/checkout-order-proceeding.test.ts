import { describe, expect, it, vi, beforeEach } from 'vitest';
import { db } from '../src/config/db.js';
import * as checkoutService from '../src/modules/checkout/checkout.service.js';
import * as checkoutRepo from '../src/modules/checkout/checkout.repository.js';
import * as cartService from '../src/modules/cart/cart.service.js';
import * as payments from '../src/modules/payments/payments.service.js';
import { UnprocessableError, ValidationError } from '../src/lib/errors.js';

describe('Order Proceeding Test Cases', () => {
  const mockCustomerId = 'cust-1234-5678';
  const mockCartToken = 'cart-tok-12345';
  const mockCartId = 'cart-1111-2222';
  const mockOrderNumber = 'ACH100001';
  const mockOrderId = 'ord-9999-8888';

  const mockDestinationRow: checkoutRepo.DestinationRow = {
    pincode: '226016',
    city: 'Lucknow',
    stateCode: '09',
    serviceable: true,
    codAllowed: true,
    zoneId: 'zone-lko',
    zoneName: 'Lucknow Metro',
    zoneStatus: 'active',
    baseFeePaise: 0,
    supportsSameDay: true,
    sameDayCutoff: '18:00',
    supportsMidnight: true,
    supportsCod: true,
    standardTatDays: 2,
  };

  const mockSupplyPoint: checkoutRepo.SupplyPointRow = {
    warehouseId: 'wh-main',
    warehouseCode: 'DEMO-LKO-01',
    warehouseName: 'Main Warehouse Lucknow',
    stateCode: '09',
    gstin: '09AAAAA0000A1Z5',
  };

  const mockCart = {
    id: mockCartId,
    anonToken: mockCartToken,
    customerId: mockCustomerId,
    stage: 'cart' as const,
    currency: 'INR',
    couponCode: null,
    contactEmail: null,
    contactPhone: null,
    convertedOrderId: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockCartState = {
    cart: mockCart,
    lines: [
      {
        id: 'line-1',
        variantId: 'var-1',
        productId: 'prod-1',
        productHandle: 'circle-pendent',
        title: 'Circle Pendent Necklace (Pink And Black)',
        variantLabel: 'Size',
        sku: 'ACH-CIR-PEN',
        imageUrl: null,
        quantity: 1,
        unitPricePaise: 54900,
        snapshotUnitPricePaise: 54900,
        personalisation: null,
        hsnCode: '71179090',
        gstRateBp: 300,
        cessRateBp: 0,
        collectionIds: [],
        availableQty: 25,
        sellable: true,
        createdAt: new Date(),
      },
    ],
    addOnsByLine: new Map(),
    coupon: null,
    warnings: [],
    breakdown: {
      lines: [
        {
          lineId: 'line-1',
          variantId: 'var-1',
          quantity: 1,
          unitPricePaise: 54900,
          addOnsPaise: 0,
          lineTotalPaise: 54900,
          allocatedOrderDiscountPaise: 0,
          grossPaise: 54900,
          gstRateBp: 300,
          cessRateBp: 0,
          taxablePaise: 53301,
          cgstPaise: 799,
          sgstPaise: 800,
          igstPaise: 0,
          cessPaise: 0,
        },
      ],
      itemCount: 1,
      merchandisePaise: 54900,
      couponCode: null,
      couponDiscountPaise: 0,
      subtotalPaise: 54900,
      shippingPaise: 14900,
      codFeePaise: 0,
      taxablePaise: 53301,
      cgstPaise: 799,
      sgstPaise: 800,
      igstPaise: 0,
      cessPaise: 0,
      roundOffPaise: 0,
      totalPaise: 69800,
      isInterstate: false,
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();

    vi.spyOn(db, 'transaction').mockImplementation(async (callback: any) => callback({} as any));
    vi.spyOn(cartService, 'resolveOwnedCart').mockResolvedValue(mockCart);
    vi.spyOn(checkoutRepo, 'stateCodeExists').mockResolvedValue(true);
    vi.spyOn(checkoutRepo, 'findDestination').mockResolvedValue(mockDestinationRow);
    vi.spyOn(checkoutRepo, 'findSupplyPoint').mockResolvedValue(mockSupplyPoint);
    vi.spyOn(cartService, 'loadCartState').mockResolvedValue(mockCartState as any);
    vi.spyOn(checkoutRepo, 'findCustomerProfile').mockResolvedValue({
      id: mockCustomerId,
      email: 'buyer@test.com',
      mobile: '9876543210',
      fullName: 'Test Buyer',
      notes: null,
    });
    vi.spyOn(checkoutRepo, 'findInventoryLevels').mockResolvedValue([
      {
        id: 'inv-level-1',
        warehouseId: 'wh-main',
        warehouseCode: 'DEMO-LKO-01',
        variantId: 'var-1',
        availableQty: 25,
      },
    ]);
    vi.spyOn(checkoutRepo, 'lockInventoryLevels').mockResolvedValue();
    vi.spyOn(checkoutRepo, 'reserveStock').mockResolvedValue(true);
    vi.spyOn(checkoutRepo, 'nextOrderNumber').mockResolvedValue(mockOrderNumber);
    vi.spyOn(checkoutRepo, 'insertOrder').mockResolvedValue({
      id: mockOrderId,
      orderNo: mockOrderNumber,
      placedAt: new Date(),
    } as any);
    vi.spyOn(checkoutRepo, 'insertOrderLines').mockResolvedValue(['order-line-1']);
    vi.spyOn(checkoutRepo, 'insertOrderLineAddOns').mockResolvedValue();
    vi.spyOn(checkoutRepo, 'insertOrderLinePersonalisations').mockResolvedValue();
    vi.spyOn(checkoutRepo, 'insertReservations').mockResolvedValue();
    vi.spyOn(checkoutRepo, 'insertTimelineEvent').mockResolvedValue();
    vi.spyOn(checkoutRepo, 'markCartConverted').mockResolvedValue();
  });

  /* ----------------------------------------------------------- Happy Paths */

  it('proceeds order with Cash on Delivery (COD) successfully', async () => {
    const result = await checkoutService.createOrder(mockCustomerId, {
      cartToken: mockCartToken,
      address: {
        contactName: 'Test Buyer',
        mobile: '9876543210',
        line1: '123 Main Street',
        city: 'Lucknow',
        stateCode: '09',
        pincode: '226016',
        countryCode: 'IN',
        saveToAddressBook: false,
      },
      deliveryType: 'standard',
      paymentMethod: 'cod',
      buyerName: 'Test Buyer',
      buyerEmail: 'buyer@test.com',
      buyerMobile: '9876543210',
      isGift: false,
    });

    expect(result.orderId).toBe(mockOrderId);
    expect(result.orderNo).toBe(mockOrderNumber);
    expect(result.status).toBe('confirmed');
    expect(result.paymentStatus).toBe('cod_due');
    expect(result.payment).toBeNull();
    expect(result.totalPaise).toBe(69800);
  });

  it('proceeds prepaid order (UPI) and creates payment session', async () => {
    vi.spyOn(payments, 'createPaymentSession').mockResolvedValue({
      gateway: 'razorpay',
      keyId: 'rzp_test_123',
      razorpayOrderId: 'order_rzp_456',
      amountPaise: 69800,
      currency: 'INR',
    });

    const result = await checkoutService.createOrder(mockCustomerId, {
      cartToken: mockCartToken,
      address: {
        contactName: 'Test Buyer',
        mobile: '9876543210',
        line1: '123 Main Street',
        city: 'Lucknow',
        stateCode: '09',
        pincode: '226016',
        countryCode: 'IN',
        saveToAddressBook: false,
      },
      deliveryType: 'standard',
      paymentMethod: 'upi',
      buyerName: 'Test Buyer',
      buyerEmail: 'buyer@test.com',
      buyerMobile: '9876543210',
      isGift: false,
    });

    expect(result.orderId).toBe(mockOrderId);
    expect(result.status).toBe('pending_payment');
    expect(result.paymentStatus).toBe('pending');
    expect(result.payment).toEqual({
      gateway: 'razorpay',
      keyId: 'rzp_test_123',
      razorpayOrderId: 'order_rzp_456',
      amountPaise: 69800,
      currency: 'INR',
    });
  });

  it('proceeds order with Credit Card payment method', async () => {
    vi.spyOn(payments, 'createPaymentSession').mockResolvedValue({
      gateway: 'razorpay',
      keyId: 'rzp_test_123',
      razorpayOrderId: 'order_rzp_789',
      amountPaise: 69800,
      currency: 'INR',
    });

    const result = await checkoutService.createOrder(mockCustomerId, {
      cartToken: mockCartToken,
      address: {
        contactName: 'Test Buyer',
        mobile: '9876543210',
        line1: '123 Main Street',
        city: 'Lucknow',
        stateCode: '09',
        pincode: '226016',
        countryCode: 'IN',
        saveToAddressBook: false,
      },
      deliveryType: 'standard',
      paymentMethod: 'credit_card',
      buyerName: 'Test Buyer',
      buyerEmail: 'buyer@test.com',
      buyerMobile: '9876543210',
      isGift: false,
    });

    expect(result.status).toBe('pending_payment');
    expect(result.payment?.razorpayOrderId).toBe('order_rzp_789');
  });

  it('proceeds order with Net Banking payment method', async () => {
    vi.spyOn(payments, 'createPaymentSession').mockResolvedValue({
      gateway: 'razorpay',
      keyId: 'rzp_test_123',
      razorpayOrderId: 'order_rzp_net',
      amountPaise: 69800,
      currency: 'INR',
    });

    const result = await checkoutService.createOrder(mockCustomerId, {
      cartToken: mockCartToken,
      address: {
        contactName: 'Test Buyer',
        mobile: '9876543210',
        line1: '123 Main Street',
        city: 'Lucknow',
        stateCode: '09',
        pincode: '226016',
        countryCode: 'IN',
        saveToAddressBook: false,
      },
      deliveryType: 'standard',
      paymentMethod: 'net_banking',
      buyerName: 'Test Buyer',
      buyerEmail: 'buyer@test.com',
      buyerMobile: '9876543210',
      isGift: false,
    });

    expect(result.status).toBe('pending_payment');
    expect(result.payment?.razorpayOrderId).toBe('order_rzp_net');
  });

  /* ------------------------------------------------- State Code Normalization */

  it('normalizes state name "Uttar Pradesh" or abbreviation "UP" to "09"', async () => {
    let capturedStateCode: string | undefined;
    vi.spyOn(checkoutRepo, 'insertOrder').mockImplementation(async (_tx, values: any) => {
      capturedStateCode = values.shipStateCode;
      return { id: mockOrderId, orderNo: mockOrderNumber, placedAt: new Date() } as any;
    });

    await checkoutService.createOrder(mockCustomerId, {
      cartToken: mockCartToken,
      address: {
        contactName: 'Test Buyer',
        mobile: '9876543210',
        line1: '123 Main Street',
        city: 'Lucknow',
        stateCode: 'UP',
        pincode: '226016',
        countryCode: 'IN',
        saveToAddressBook: false,
      },
      deliveryType: 'standard',
      paymentMethod: 'cod',
      buyerName: 'Test Buyer',
      buyerEmail: 'buyer@test.com',
      buyerMobile: '9876543210',
      isGift: false,
    });

    expect(capturedStateCode).toBe('09');
  });

  it('uses saved address from address book by addressId', async () => {
    vi.spyOn(checkoutRepo, 'findCustomerAddress').mockResolvedValue({
      id: 'saved-addr-1',
      customerId: mockCustomerId,
      label: 'Home',
      contactName: 'Saved Contact',
      mobile: '9876543210',
      line1: 'Saved Line 1',
      line2: null,
      area: 'Gomti Nagar',
      city: 'Lucknow',
      stateCode: '09',
      pincode: '226010',
      countryCode: 'IN',
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await checkoutService.createOrder(mockCustomerId, {
      cartToken: mockCartToken,
      addressId: 'saved-addr-1',
      deliveryType: 'standard',
      paymentMethod: 'cod',
      buyerName: 'Saved Contact',
      buyerEmail: 'buyer@test.com',
      buyerMobile: '9876543210',
      isGift: false,
    });

    expect(result.orderId).toBe(mockOrderId);
    expect(result.status).toBe('confirmed');
  });

  /* --------------------------------------------------------- Error Guards */

  it('rejects unserviceable pincode gracefully with 422 destination_not_serviceable', async () => {
    vi.spyOn(checkoutRepo, 'findDestination').mockResolvedValue({
      ...mockDestinationRow,
      serviceable: false,
    });

    await expect(
      checkoutService.createOrder(mockCustomerId, {
        cartToken: mockCartToken,
        address: {
          contactName: 'Test Buyer',
          mobile: '9876543210',
          line1: '123 Main Street',
          city: 'Remote Village',
          stateCode: '09',
          pincode: '999999',
          countryCode: 'IN',
          saveToAddressBook: false,
        },
        deliveryType: 'standard',
        paymentMethod: 'cod',
        buyerName: 'Test Buyer',
        buyerEmail: 'buyer@test.com',
        buyerMobile: '9876543210',
        isGift: false,
      }),
    ).rejects.toThrow(UnprocessableError);
  });

  it('rejects COD when pincode is not eligible for cash on delivery', async () => {
    vi.spyOn(checkoutRepo, 'findDestination').mockResolvedValue({
      ...mockDestinationRow,
      supportsCod: false,
      codAllowed: false,
    });

    await expect(
      checkoutService.createOrder(mockCustomerId, {
        cartToken: mockCartToken,
        address: {
          contactName: 'Test Buyer',
          mobile: '9876543210',
          line1: '123 Main Street',
          city: 'Lucknow',
          stateCode: '09',
          pincode: '226016',
          countryCode: 'IN',
          saveToAddressBook: false,
        },
        deliveryType: 'standard',
        paymentMethod: 'cod',
        buyerName: 'Test Buyer',
        buyerEmail: 'buyer@test.com',
        buyerMobile: '9876543210',
        isGift: false,
      }),
    ).rejects.toThrow('Cash on delivery is not available for this PIN code.');
  });

  it('rejects order when cart is empty', async () => {
    vi.spyOn(cartService, 'loadCartState').mockResolvedValue({
      ...mockCartState,
      lines: [],
    } as any);

    await expect(
      checkoutService.createOrder(mockCustomerId, {
        cartToken: mockCartToken,
        address: {
          contactName: 'Test Buyer',
          mobile: '9876543210',
          line1: '123 Main Street',
          city: 'Lucknow',
          stateCode: '09',
          pincode: '226016',
          countryCode: 'IN',
          saveToAddressBook: false,
        },
        deliveryType: 'standard',
        paymentMethod: 'cod',
        buyerName: 'Test Buyer',
        buyerEmail: 'buyer@test.com',
        buyerMobile: '9876543210',
        isGift: false,
      }),
    ).rejects.toThrow('Your cart is empty.');
  });

  it('rejects order when stock is insufficient', async () => {
    vi.spyOn(cartService, 'loadCartState').mockResolvedValue({
      ...mockCartState,
      lines: [
        {
          ...mockCartState.lines[0],
          quantity: 100,
          availableQty: 5,
        },
      ],
    } as any);

    await expect(
      checkoutService.createOrder(mockCustomerId, {
        cartToken: mockCartToken,
        address: {
          contactName: 'Test Buyer',
          mobile: '9876543210',
          line1: '123 Main Street',
          city: 'Lucknow',
          stateCode: '09',
          pincode: '226016',
          countryCode: 'IN',
          saveToAddressBook: false,
        },
        deliveryType: 'standard',
        paymentMethod: 'cod',
        buyerName: 'Test Buyer',
        buyerEmail: 'buyer@test.com',
        buyerMobile: '9876543210',
        isGift: false,
      }),
    ).rejects.toThrow('Not enough stock');
  });

  it('rejects international destination with friendly message', async () => {
    await expect(
      checkoutService.createOrder(mockCustomerId, {
        cartToken: mockCartToken,
        address: {
          contactName: 'Test Buyer',
          mobile: '9876543210',
          line1: '123 Main Street',
          city: 'London',
          stateCode: '09',
          pincode: '226016',
          countryCode: 'UK',
          saveToAddressBook: false,
        },
        deliveryType: 'standard',
        paymentMethod: 'cod',
        buyerName: 'Test Buyer',
        buyerEmail: 'buyer@test.com',
        buyerMobile: '9876543210',
        isGift: false,
      }),
    ).rejects.toThrow('International delivery is not available yet.');
  });
});
