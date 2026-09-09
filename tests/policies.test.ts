import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cache } from '../src/config/redis.js';
import { contentPageDetail } from '../src/modules/content/content.schemas.js';
import {
  CANONICAL_POLICIES,
  POLICY_ALIAS_MAP,
  normalizePolicySlug,
} from '../src/modules/content/policies.data.js';
import { getPolicyBySlug } from '../src/modules/content/content.service.js';

describe('Storefront Policy Pages - Schema & Content Verification', () => {
  beforeEach(() => {
    vi.spyOn(cache, 'get').mockResolvedValue(null);
    vi.spyOn(cache, 'set').mockResolvedValue('OK');
  });
  const REQUIRED_POLICIES = ['shipping', 'returns', 'privacy', 'terms', 'cookies'] as const;

  it('provides all 5 core policy records in canonical dataset', () => {
    for (const policyKey of REQUIRED_POLICIES) {
      expect(CANONICAL_POLICIES).toHaveProperty(policyKey);
      const policy = CANONICAL_POLICIES[policyKey];
      expect(policy.kind).toBe('policy');
      expect(policy.slug).toBe(policyKey);
      expect(policy.title).toBeTruthy();
      expect(policy.heading).toBeTruthy();
      expect(Array.isArray(policy.body)).toBe(true);
      expect(policy.body.length).toBeGreaterThan(0);
      expect(policy.seo).not.toBeNull();
      expect(policy.seo?.metaTitle).toBeTruthy();
      expect(policy.seo?.metaDescription).toBeTruthy();

      // Validate against the authoritative contentPageDetail Zod schema
      const validation = contentPageDetail.safeParse(policy);
      expect(validation.success).toBe(true);
    }
  });

  it('contains rich structured body blocks (headings, paragraphs, lists) for every policy', () => {
    for (const policyKey of REQUIRED_POLICIES) {
      const policy = CANONICAL_POLICIES[policyKey];
      const blocks = policy.body as Array<{ type: string; text?: string; items?: string[] }>;

      const headings = blocks.filter((b) => b.type === 'heading');
      const paragraphs = blocks.filter((b) => b.type === 'paragraph');
      const lists = blocks.filter((b) => b.type === 'list');

      // Every policy must have at least 2 structured subheadings and detailed paragraphs
      expect(headings.length).toBeGreaterThanOrEqual(2);
      expect(paragraphs.length).toBeGreaterThanOrEqual(2);

      // Verify that list items are non-empty strings
      for (const listBlock of lists) {
        expect(Array.isArray(listBlock.items)).toBe(true);
        expect(listBlock.items!.length).toBeGreaterThan(0);
        for (const item of listBlock.items!) {
          expect(typeof item).toBe('string');
          expect(item.length).toBeGreaterThan(5);
        }
      }
    }
  });

  it('normalizes common URL slug variations and aliases to canonical slugs', () => {
    const aliasTestCases: Array<[string, string]> = [
      ['shipping', 'shipping'],
      ['shipping-policy', 'shipping'],
      ['delivery', 'shipping'],
      ['shipping-and-delivery', 'shipping'],

      ['returns', 'returns'],
      ['returns-and-refunds', 'returns'],
      ['returns-refunds', 'returns'],
      ['refunds', 'returns'],
      ['cancellations-and-refunds', 'returns'],

      ['privacy', 'privacy'],
      ['privacy-policy', 'privacy'],

      ['terms', 'terms'],
      ['terms-of-service', 'terms'],
      ['terms-and-conditions', 'terms'],

      ['cookies', 'cookies'],
      ['cookie-policy', 'cookies'],
    ];

    for (const [inputSlug, expectedCanonical] of aliasTestCases) {
      expect(normalizePolicySlug(inputSlug)).toBe(expectedCanonical);
    }
  });

  it('resolves active policy content via getPolicyBySlug for all 5 canonical slugs with specific policy details', async () => {
    // 1. Shipping Policy Details
    const shipping = await getPolicyBySlug('shipping');
    expect(shipping.title).toBe('Shipping Policy');
    expect(shipping.heading).toBe('Shipping & Delivery Policy');
    const shippingContent = JSON.stringify(shipping.body);
    expect(shippingContent).toContain('Lucknow');
    expect(shippingContent).toContain('999');
    expect(shippingContent).toContain('Blue Dart');
    expect(shippingContent).toContain('Eco Packaging');

    // 2. Returns Policy Details
    const returns = await getPolicyBySlug('returns');
    expect(returns.title).toBe('Returns & Refunds');
    const returnsContent = JSON.stringify(returns.body);
    expect(returnsContent).toContain('7-Day Return Window');
    expect(returnsContent).toContain('Non-Returnable Items');
    expect(returnsContent).toContain('48 hours');
    expect(returnsContent).toContain('5 to 7 business days');

    // 3. Privacy Policy Details
    const privacy = await getPolicyBySlug('privacy');
    expect(privacy.title).toBe('Privacy Policy');
    const privacyContent = JSON.stringify(privacy.body);
    expect(privacyContent).toContain('HARIVON ENTERPRISES PRIVATE LIMITED');
    expect(privacyContent).toContain('Information We Collect');
    expect(privacyContent).toContain('Razorpay');
    expect(privacyContent).toContain('Grievance Officer');

    // 4. Terms of Service Details
    const terms = await getPolicyBySlug('terms');
    expect(terms.title).toBe('Terms of Service');
    const termsContent = JSON.stringify(terms.body);
    expect(termsContent).toContain('Terms of Service');
    expect(termsContent).toContain('artisanal');
    expect(termsContent).toContain('Handcrafted Artistry');
    expect(termsContent).toContain('GST');
    expect(termsContent).toContain('Lucknow');

    // 5. Cookie Policy Details
    const cookies = await getPolicyBySlug('cookies');
    expect(cookies.title).toBe('Cookie Policy');
    const cookiesContent = JSON.stringify(cookies.body);
    expect(cookiesContent).toContain('What Are Cookies?');
    expect(cookiesContent).toContain('Strictly Necessary');
    expect(cookiesContent).toContain('Managing Cookie Preferences');
  });

  it('resolves active policy content via getPolicyBySlug for alias slugs', async () => {
    const aliases = ['shipping-policy', 'returns-and-refunds', 'privacy-policy', 'terms-of-service', 'cookie-policy'];
    for (const alias of aliases) {
      const result = await getPolicyBySlug(alias);
      expect(result).toBeDefined();
      expect(result.kind).toBe('policy');
      expect(result.body.length).toBeGreaterThan(0);
    }
  });

  it('throws NotFoundError for completely unknown policy slugs', async () => {
    await expect(getPolicyBySlug('unknown-nonexistent-policy')).rejects.toThrow();
  });
});
