import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';

/**
 * Storefront content contracts: the journal, occasion/policy pages, FAQs,
 * testimonials, CMS sections, banners, SEO records and navigation menus.
 *
 * Only published rows ever appear here. Draft, scheduled-but-not-yet-open and
 * archived rows are filtered in the repository so no route can leak one.
 */

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const slugParam = z.object({
  slug: z
    .string()
    .regex(SLUG, 'A slug is lowercase alphanumerics separated by single hyphens.')
    .min(2)
    .max(160)
    .describe('URL slug of the resource, e.g. `shipping` or `gifting-for-diwali`.'),
});

export const menuKeyParam = z.object({
  key: z
    .string()
    .regex(SLUG)
    .min(2)
    .max(60)
    .describe('Menu key. The three that exist today are `header`, `footer` and `mobile`.'),
});

export const imageRef = z.object({
  id: z.uuid().describe('Media asset id.'),
  url: z.string().describe('CDN URL when one exists, otherwise the origin URL.'),
  altText: z.string().nullable().describe('Alt text for accessibility. May be null.'),
});

export const bodyBlocks = z
  .array(z.unknown())
  .describe(
    'Ordered rich-text blocks, rendered in sequence. Each block is an object with a `type` ' +
      'discriminator and type-specific fields; unknown types must be skipped, not thrown on.',
  );

export const seoBlock = z.object({
  metaTitle: z.string().nullable().describe('`<title>` override. Falls back to the resource title.'),
  metaDescription: z.string().nullable().describe('`<meta name="description">` content.'),
  canonicalUrl: z.string().nullable().describe('Canonical URL when this page duplicates another.'),
  focusKeyword: z.string().nullable().describe('Primary keyword the page targets.'),
  robotsIndex: z.boolean().describe('False emits `noindex`.'),
  robotsFollow: z.boolean().describe('False emits `nofollow`.'),
  ogImageUrl: z.string().nullable().describe('Open Graph image URL.'),
  structuredData: z.unknown().nullable().describe('JSON-LD document to embed verbatim, or null.'),
});

/* ------------------------------------------------------------- the journal */

export const blogPostSummary = z.object({
  id: z.uuid().describe('Post id. Prefer `slug` for URLs.'),
  slug: z.string().describe('URL slug. Routes `/journal/:slug`.'),
  title: z.string().describe('Headline.'),
  excerpt: z.string().nullable().describe('Standfirst shown on the index card.'),
  category: z.string().nullable().describe('Editorial category, e.g. `Gifting guides`.'),
  authorName: z
    .string()
    .nullable()
    .describe('Byline — the staff author’s name, or the guest author name when there is no staff row.'),
  heroImage: imageRef.nullable().describe('Lead image, or null.'),
  readMinutes: z.number().int().nullable().describe('Estimated reading time in minutes.'),
  viewCount: z.number().int().describe('Lifetime view count.'),
  publishedAt: z.string().nullable().describe('ISO-8601 publish timestamp.'),
});

export const blogPostDetail = blogPostSummary.extend({
  body: bodyBlocks,
  relatedSlugs: z
    .array(z.string())
    .describe('Slugs of the newest other posts in the same category — the "keep reading" rail.'),
  seo: seoBlock.nullable().describe('SEO overrides for this post, or null to fall back to defaults.'),
});

export const blogListQuery = listQuery.extend({
  category: z.string().max(80).optional().describe('Restrict to one editorial category.'),
});

export const BLOG_SORT_FIELDS = ['publishedAt', 'title', 'viewCount'] as const;
export const BLOG_SORT_FALLBACK = { field: 'publishedAt', direction: 'desc' } as const;

/* ----------------------------------------------------------- content pages */

export const contentPageKind = z
  .enum(['occasion', 'policy', 'landing', 'about', 'static'])
  .describe(
    'Page discriminator. Occasion landing pages and policy pages are the same shape — ' +
      '`kind` is what tells them apart.',
  );

export const contentPageSummary = z.object({
  id: z.uuid().describe('Page id. Prefer `slug` for URLs.'),
  slug: z.string().describe('URL slug.'),
  kind: contentPageKind,
  title: z.string().describe('Page title, used in navigation.'),
  heading: z.string().nullable().describe('Page H1 when it differs from the title.'),
  heroImage: imageRef.nullable().describe('Hero image, or null.'),
  collectionHandle: z
    .string()
    .nullable()
    .describe('Collection this page fronts — set on `kind=occasion` pages, null otherwise.'),
  publishedAt: z.string().nullable().describe('ISO-8601 publish timestamp.'),
});

export const contentPageDetail = contentPageSummary.extend({
  body: bodyBlocks,
  seo: seoBlock.nullable().describe('SEO overrides for this page, or null to fall back to defaults.'),
});

export const contentPageListQuery = listQuery.extend({
  kind: contentPageKind.optional().describe('Restrict to one page kind.'),
});

export const PAGE_SORT_FIELDS = ['publishedAt', 'title', 'slug'] as const;
export const PAGE_SORT_FALLBACK = { field: 'title', direction: 'asc' } as const;

/* -------------------------------------------------------------------- faqs */

export const faq = z.object({
  id: z.uuid().describe('FAQ id.'),
  question: z.string().describe('The question, as a shopper would ask it.'),
  answer: z.string().describe('The answer. Always present — an FAQ without one is not published.'),
  category: z.string().nullable().describe('Grouping label, e.g. `Delivery`.'),
  position: z.number().int().describe('Display order within the category.'),
  helpfulCount: z.number().int().describe('Times marked helpful.'),
  unhelpfulCount: z.number().int().describe('Times marked unhelpful.'),
});

export const faqListQuery = listQuery.extend({
  category: z.string().max(80).optional().describe('Restrict to one category.'),
});

export const FAQ_SORT_FIELDS = ['position', 'question', 'helpfulCount'] as const;
export const FAQ_SORT_FALLBACK = { field: 'position', direction: 'asc' } as const;

/* ------------------------------------------------------------ testimonials */

export const testimonial = z.object({
  id: z.uuid().describe('Testimonial id.'),
  authorName: z.string().describe('Who said it.'),
  authorCity: z.string().nullable().describe('City, for B2C quotes.'),
  company: z.string().nullable().describe('Company, for B2B quotes.'),
  designation: z.string().nullable().describe('Job title, for B2B quotes.'),
  quote: z.string().describe('The quote itself.'),
  rating: z.number().int().nullable().describe('Star rating 1–5, or null when unrated.'),
  image: imageRef.nullable().describe('Portrait or company logo, or null.'),
  isFeatured: z.boolean().describe('Surfaced on the homepage rail.'),
  position: z.number().int().describe('Display order.'),
});

export const testimonialListQuery = listQuery.extend({
  featured: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .optional()
    .describe('`true` keeps only featured testimonials.'),
});

export const TESTIMONIAL_SORT_FIELDS = ['position', 'createdAt', 'rating'] as const;
export const TESTIMONIAL_SORT_FALLBACK = { field: 'position', direction: 'asc' } as const;

/* ------------------------------------------------------------ CMS sections */

export const cmsSectionItem = z.object({
  id: z.uuid().describe('Item id.'),
  position: z.number().int().describe('Display order within the section.'),
  label: z.string().nullable().describe('Tile label.'),
  sublabel: z.string().nullable().describe('Secondary line under the label.'),
  image: imageRef.nullable().describe('Tile image, or null.'),
  linkUrl: z
    .string()
    .nullable()
    .describe('Explicit link target. Prefer `collectionHandle`/`productHandle` when they are set.'),
  collectionHandle: z.string().nullable().describe('Collection this tile links to, or null.'),
  productHandle: z.string().nullable().describe('Product this tile links to, or null.'),
});

export const cmsSection = z.object({
  id: z.uuid().describe('Section id.'),
  key: z.string().describe('Stable section key, e.g. `hero-carousel`, `shop-by-occasion`.'),
  pageKey: z.string().describe('Which page the section belongs to. `home` is the default.'),
  title: z.string().describe('Section heading.'),
  layout: z
    .enum(['full_bleed', 'grid_4', 'grid_3', 'carousel', 'split_banner', 'marquee', 'list'])
    .describe('How the frontend should lay the items out.'),
  position: z.number().int().describe('Order of the section down the page.'),
  settings: z
    .unknown()
    .describe('Free-form per-section configuration. Treat unknown keys as absent, never as an error.'),
  items: z.array(cmsSectionItem).describe('Visible tiles, in display order.'),
});

export const cmsSectionListQuery = listQuery.extend({
  pageKey: z
    .string()
    .max(60)
    .optional()
    .describe('Page to fetch sections for. Defaults to every page; pass `home` for the homepage.'),
});

export const CMS_SECTION_SORT_FIELDS = ['position', 'title'] as const;
export const CMS_SECTION_SORT_FALLBACK = { field: 'position', direction: 'asc' } as const;

/* ----------------------------------------------------------------- banners */

export const banner = z.object({
  id: z.uuid().describe('Banner id.'),
  title: z.string().describe('Headline.'),
  subtitle: z.string().nullable().describe('Secondary line.'),
  placement: z
    .enum(['homepage_hero', 'category_top', 'cart_strip', 'pdp_ribbon', 'announcement_bar'])
    .describe('Where the banner renders.'),
  device: z.enum(['all', 'desktop', 'mobile']).describe('Device targeting.'),
  image: imageRef.nullable().describe('Desktop creative, or null.'),
  mobileImage: imageRef.nullable().describe('Mobile creative. Falls back to `image` when null.'),
  linkUrl: z.string().nullable().describe('Click target, when it is not a collection.'),
  collectionHandle: z.string().nullable().describe('Collection the banner links to, or null.'),
  ctaLabel: z.string().nullable().describe('Button copy, e.g. `Shop Diwali`.'),
  position: z.number().int().describe('Order within the placement.'),
});

export const bannerListQuery = listQuery.extend({
  placement: z
    .enum(['homepage_hero', 'category_top', 'cart_strip', 'pdp_ribbon', 'announcement_bar'])
    .optional()
    .describe('Restrict to one placement.'),
  device: z
    .enum(['desktop', 'mobile'])
    .optional()
    .describe('Caller’s device. Returns banners targeted at it plus those targeted at `all`.'),
});

export const BANNER_SORT_FIELDS = ['position', 'startsAt'] as const;
export const BANNER_SORT_FALLBACK = { field: 'position', direction: 'asc' } as const;

/* --------------------------------------------------------------------- seo */

export const seoQuery = z
  .object({
    entityType: z
      .enum(['product', 'collection', 'content_page', 'blog_post'])
      .optional()
      .describe('Entity kind. Requires `entityId`. Omit both to look up a route instead.'),
    entityId: z.uuid().optional().describe('Entity id. Requires `entityType`.'),
    routePath: z
      .string()
      .max(200)
      .optional()
      .describe('Route to look up instead of an entity, e.g. `/` or `/corporate-gifting`.'),
  })
  .refine((v) => (v.entityType !== undefined && v.entityId !== undefined) !== (v.routePath !== undefined), {
    message: 'Supply either entityType + entityId, or routePath — not both, not neither.',
  });

export const seoEntry = seoBlock.extend({
  entityType: z
    .enum(['product', 'collection', 'content_page', 'blog_post', 'route'])
    .describe('What this record describes.'),
  entityId: z.uuid().nullable().describe('Target entity id, or null for a route record.'),
  routePath: z.string().nullable().describe('Target route, or null for an entity record.'),
});

/* ------------------------------------------------------------------- menus */

export const menuItem = z.object({
  id: z.uuid().describe('Item id.'),
  parentId: z
    .uuid()
    .nullable()
    .describe('Parent item id, or null at the top level. Build the tree from this.'),
  label: z.string().describe('Link text.'),
  url: z.string().nullable().describe('Raw URL target, when it is neither a collection nor a page.'),
  collectionHandle: z.string().nullable().describe('Collection this item points at, or null.'),
  contentPageSlug: z.string().nullable().describe('Content page this item points at, or null.'),
  image: imageRef.nullable().describe('Optional megamenu thumbnail.'),
  position: z.number().int().describe('Display order among siblings.'),
});

export const menu = z.object({
  id: z.uuid().describe('Menu id.'),
  key: z.string().describe('Menu key, e.g. `header`.'),
  name: z.string().describe('Human name for the menu.'),
  items: z
    .array(menuItem)
    .describe(
      'Every visible item, FLAT and depth-ordered (parents before their children, siblings in ' +
        '`position` order). Build the tree from `parentId` — a self-referencing response type ' +
        'is not expressible in a generated client, and megamenu depth is not fixed.',
    ),
});

export type BlogListQuery = z.infer<typeof blogListQuery>;
export type ContentPageListQuery = z.infer<typeof contentPageListQuery>;
export type FaqListQuery = z.infer<typeof faqListQuery>;
export type TestimonialListQuery = z.infer<typeof testimonialListQuery>;
export type CmsSectionListQuery = z.infer<typeof cmsSectionListQuery>;
export type BannerListQuery = z.infer<typeof bannerListQuery>;
export type SeoQuery = z.infer<typeof seoQuery>;
export type BlogPostSummary = z.infer<typeof blogPostSummary>;
export type BlogPostDetail = z.infer<typeof blogPostDetail>;
export type ContentPageSummary = z.infer<typeof contentPageSummary>;
export type ContentPageDetail = z.infer<typeof contentPageDetail>;
export type FaqResponse = z.infer<typeof faq>;
export type TestimonialResponse = z.infer<typeof testimonial>;
export type CmsSectionResponse = z.infer<typeof cmsSection>;
export type BannerResponse = z.infer<typeof banner>;
export type SeoEntryResponse = z.infer<typeof seoEntry>;
export type MenuResponse = z.infer<typeof menu>;
