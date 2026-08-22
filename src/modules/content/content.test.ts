import { describe, expect, it } from 'vitest';
import { MAX_PER_PAGE, parseSort } from '../../lib/pagination.js';
import {
  BANNER_SORT_FALLBACK,
  BANNER_SORT_FIELDS,
  BLOG_SORT_FALLBACK,
  BLOG_SORT_FIELDS,
  CMS_SECTION_SORT_FALLBACK,
  CMS_SECTION_SORT_FIELDS,
  FAQ_SORT_FALLBACK,
  FAQ_SORT_FIELDS,
  PAGE_SORT_FALLBACK,
  PAGE_SORT_FIELDS,
  TESTIMONIAL_SORT_FALLBACK,
  TESTIMONIAL_SORT_FIELDS,
  bannerListQuery,
  blogListQuery,
  blogPostDetail,
  contentPageListQuery,
  faq,
  faqListQuery,
  menu,
  menuKeyParam,
  seoQuery,
  slugParam,
  testimonialListQuery,
} from './content.schemas.js';

/** Pure tests over the content contracts and their sort allowlists. */

describe('slugParam', () => {
  it.each([
    ['shipping', true],
    ['gifting-for-diwali', true],
    ['Shipping', false],
    ['../secrets', false],
    ['double--hyphen', false],
    ['s', false],
    ['has space', false],
  ])('%s → %s', (slug, valid) => {
    expect(slugParam.safeParse({ slug }).success).toBe(valid);
  });
});

describe('menuKeyParam', () => {
  it('accepts the three real menus', () => {
    for (const key of ['header', 'footer', 'mobile']) {
      expect(menuKeyParam.safeParse({ key }).success).toBe(true);
    }
  });

  it('rejects anything that is not a handle', () => {
    expect(menuKeyParam.safeParse({ key: 'Header' }).success).toBe(false);
    expect(menuKeyParam.safeParse({ key: 'a' }).success).toBe(false);
  });
});

describe('seoQuery', () => {
  const entityId = '3f1e6b6e-9a0b-4f4c-9b1a-2c0d4e5f6a7b';

  it('accepts an entity lookup', () => {
    expect(seoQuery.safeParse({ entityType: 'product', entityId }).success).toBe(true);
  });

  it('accepts a route lookup', () => {
    expect(seoQuery.safeParse({ routePath: '/' }).success).toBe(true);
  });

  it('rejects both at once — the two would resolve to different records', () => {
    expect(seoQuery.safeParse({ entityType: 'product', entityId, routePath: '/' }).success).toBe(false);
  });

  it('rejects neither', () => {
    expect(seoQuery.safeParse({}).success).toBe(false);
  });

  it('rejects a half-supplied entity lookup', () => {
    expect(seoQuery.safeParse({ entityType: 'product' }).success).toBe(false);
    expect(seoQuery.safeParse({ entityId }).success).toBe(false);
  });

  it('does not accept `route` as an entityType — that is what routePath is for', () => {
    expect(seoQuery.safeParse({ entityType: 'route', entityId }).success).toBe(false);
  });
});

describe('list queries', () => {
  it('share the pagination defaults and ceiling', () => {
    for (const schema of [blogListQuery, contentPageListQuery, faqListQuery, bannerListQuery]) {
      const parsed = schema.parse({});
      expect(parsed.page).toBe(1);
      expect(parsed.perPage).toBe(25);
      expect(schema.safeParse({ perPage: String(MAX_PER_PAGE + 1) }).success).toBe(false);
    }
  });

  it('restricts content page kind to the five real kinds', () => {
    expect(contentPageListQuery.safeParse({ kind: 'policy' }).success).toBe(true);
    expect(contentPageListQuery.safeParse({ kind: 'blog' }).success).toBe(false);
  });

  it('restricts banner placement and device', () => {
    expect(bannerListQuery.safeParse({ placement: 'homepage_hero' }).success).toBe(true);
    expect(bannerListQuery.safeParse({ placement: 'footer' }).success).toBe(false);
    expect(bannerListQuery.safeParse({ device: 'mobile' }).success).toBe(true);
    // `all` is a targeting value on the row, not something a caller declares.
    expect(bannerListQuery.safeParse({ device: 'all' }).success).toBe(false);
  });

  it('reads `featured=false` as false rather than as true', () => {
    expect(testimonialListQuery.parse({ featured: 'false' }).featured).toBe(false);
    expect(testimonialListQuery.parse({ featured: 'true' }).featured).toBe(true);
    expect(testimonialListQuery.parse({}).featured).toBeUndefined();
  });
});

describe('content sort allowlists', () => {
  const cases = [
    ['blog', BLOG_SORT_FIELDS, BLOG_SORT_FALLBACK],
    ['pages', PAGE_SORT_FIELDS, PAGE_SORT_FALLBACK],
    ['faqs', FAQ_SORT_FIELDS, FAQ_SORT_FALLBACK],
    ['testimonials', TESTIMONIAL_SORT_FIELDS, TESTIMONIAL_SORT_FALLBACK],
    ['sections', CMS_SECTION_SORT_FIELDS, CMS_SECTION_SORT_FALLBACK],
    ['banners', BANNER_SORT_FIELDS, BANNER_SORT_FALLBACK],
  ] as const;

  it.each(cases)('%s accepts every advertised field in both directions', (_name, fields, fallback) => {
    for (const field of fields) {
      expect(parseSort(field, fields, fallback)).toEqual({ field, direction: 'asc' });
      expect(parseSort(`-${field}`, fields, fallback)).toEqual({ field, direction: 'desc' });
    }
  });

  it.each(cases)('%s falls back on anything else', (_name, fields, fallback) => {
    for (const attack of ['deletedAt', 'status', 'id); DROP TABLE faqs--', 'random()']) {
      expect(parseSort(attack, fields, fallback)).toEqual(fallback);
    }
  });

  it.each(cases)('%s never sorts by a publication or deletion column', (_name, fields) => {
    for (const field of fields) {
      expect(field).not.toBe('status');
      expect(field).not.toBe('deletedAt');
    }
  });
});

describe('response contracts', () => {
  it('requires an FAQ to carry its answer', () => {
    const base = {
      id: '3f1e6b6e-9a0b-4f4c-9b1a-2c0d4e5f6a7b',
      question: 'Do you deliver same day?',
      answer: 'In six metros, ordered before the zone cutoff.',
      category: 'Delivery',
      position: 0,
      helpfulCount: 3,
      unhelpfulCount: 0,
    };
    expect(faq.safeParse(base).success).toBe(true);
    // The admin's Faq type has no answer field at all; the API must not inherit that.
    expect(faq.safeParse({ ...base, answer: undefined }).success).toBe(false);
  });

  it('is flat: an item carries a parentId, never a children array', () => {
    const id = '3f1e6b6e-9a0b-4f4c-9b1a-2c0d4e5f6a7b';
    const child = '4a2e7c7f-0b1c-5a5d-8c2b-3d1e5f6a7b8c';

    const flat = {
      id,
      key: 'header',
      name: 'Header',
      items: [
        {
          id,
          parentId: null,
          label: 'Shop',
          url: null,
          collectionHandle: null,
          contentPageSlug: null,
          image: null,
          position: 0,
        },
        {
          id: child,
          parentId: id,
          label: 'Drinkware',
          url: null,
          collectionHandle: 'drinkware',
          contentPageSlug: null,
          image: null,
          position: 0,
        },
      ],
    };

    const parsed = menu.safeParse(flat);
    expect(parsed.success).toBe(true);

    // The tree lives in `parentId`. A caller that sends `children` gets it
    // stripped, so nobody can half-migrate the response to a nested shape and
    // have it silently survive round-tripping.
    const withChildren = menu.parse({
      ...flat,
      items: [{ ...flat.items[0], children: [flat.items[1]] }],
    });
    expect(withChildren.items[0]).not.toHaveProperty('children');
    expect(withChildren.items[0]?.parentId).toBeNull();
    expect(parsed.success && parsed.data.items[1]?.parentId).toBe(id);
  });

  it('accepts a post with an empty body and no SEO overrides', () => {
    expect(
      blogPostDetail.safeParse({
        id: '3f1e6b6e-9a0b-4f4c-9b1a-2c0d4e5f6a7b',
        slug: 'gifting-for-diwali',
        title: 'Gifting for Diwali',
        excerpt: null,
        category: null,
        authorName: 'Achichiz Studio',
        heroImage: null,
        readMinutes: null,
        viewCount: 0,
        publishedAt: '2026-07-01T00:00:00.000Z',
        body: [],
        relatedSlugs: [],
        seo: null,
      }).success,
    ).toBe(true);
  });
});
