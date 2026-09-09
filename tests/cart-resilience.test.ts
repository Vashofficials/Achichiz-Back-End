import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as cartService from '../src/modules/cart/cart.service.js';
import * as cartRepo from '../src/modules/cart/cart.repository.js';

describe('Cart Token Resilience Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a fresh cart when adding a line with a stale/non-existent cart token (never throws Cart was not found)', async () => {
    // Stale token that does not exist in the database
    const staleToken = 'stale-token-from-old-session';
    vi.spyOn(cartRepo, 'findCartByToken').mockResolvedValue(null);

    const createdCart: cartRepo.CartRow = {
      id: '11111111-1111-1111-1111-111111111111',
      anonToken: 'fresh-new-token-12345',
      customerId: null,
      stage: 'cart',
      currency: 'INR',
      couponCode: null,
      contactEmail: null,
      contactPhone: null,
      convertedOrderId: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.spyOn(cartRepo, 'createCart').mockResolvedValue(createdCart);
    vi.spyOn(cartRepo, 'findCartById').mockResolvedValue(createdCart);

    // Mock variant for add
    vi.spyOn(cartRepo, 'findVariantForAdd').mockResolvedValue({
      variantId: 'var-123',
      productId: 'prod-123',
      title: 'Chain Pendant Set',
      productTitle: 'Chain Pendant Set',
      pricePaise: 39900,
      compareAtPaise: 49900,
      availableQty: 10,
      sellable: true,
      isPersonalisable: false,
    });
    vi.spyOn(cartRepo, 'findAddOnsByIds').mockResolvedValue([]);
    vi.spyOn(cartRepo, 'findLineByKey').mockResolvedValue(null);
    vi.spyOn(cartRepo, 'insertLine').mockResolvedValue('line-1');
    vi.spyOn(cartRepo, 'insertLineAddOns').mockResolvedValue();
    vi.spyOn(cartRepo, 'touchCart').mockResolvedValue();

    // Mock pricing lines
    vi.spyOn(cartRepo, 'findPricingLines').mockResolvedValue([
      {
        id: 'line-1',
        variantId: 'var-123',
        productId: 'prod-123',
        collectionIds: [],
        quantity: 1,
        unitPricePaise: 39900,
        snapshotUnitPricePaise: 39900,
        gstRateBp: 1800,
        cessRateBp: 0,
        availableQty: 10,
        sellable: true,
        title: 'Chain Pendant Set',
        productTitle: 'Chain Pendant Set',
        variantLabel: 'Size',
        sku: 'CPS-01',
        imageUrl: null,
        personalisation: null,
      },
    ]);
    vi.spyOn(cartRepo, 'findLineAddOns').mockResolvedValue([]);

    // Call addLine with stale token
    const res = await cartService.addLine(staleToken, {
      variantId: 'var-123',
      quantity: 1,
      addOns: [],
    });

    expect(res).toBeDefined();
    expect(res.token).toBe('fresh-new-token-12345');
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].variantId).toBe('var-123');
    expect(res.itemCount).toBe(1);
  });

  it('returns emptyCartResponse on clearCart when token is missing or unknown', async () => {
    vi.spyOn(cartRepo, 'findCartByToken').mockResolvedValue(null);

    const res = await cartService.clearCart('non-existent-token');
    expect(res).toBeDefined();
    expect(res.id).toBeNull();
    expect(res.lines).toHaveLength(0);
    expect(res.itemCount).toBe(0);
  });

  it('returns emptyCartResponse on getCart when token does not exist', async () => {
    vi.spyOn(cartRepo, 'findCartByToken').mockResolvedValue(null);

    const res = await cartService.getCart('unknown-token');
    expect(res).toBeDefined();
    expect(res.id).toBeNull();
    expect(res.lines).toHaveLength(0);
    expect(res.itemCount).toBe(0);
  });
});
