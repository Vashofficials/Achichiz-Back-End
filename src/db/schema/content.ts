/**
 * content.ts — §2.11
 *
 * Media library, homepage/CMS sections, banners, content pages (occasion
 * landing pages AND policy pages are the same shape — one table with a `kind`
 * discriminator), polymorphic SEO records, the journal, FAQs, testimonials and
 * navigation menus.
 *
 * Naming note: "occasion_pages" are `content_pages` rows with kind='occasion',
 * usually paired with a `collections` row of kind='occasion'. There is no
 * separate occasion_pages table — the admin's OccasionPage and the storefront's
 * occasion collection are the same object reached by different routes (§1.2).
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - DOMAIN handle — cms_sections.key, menus.key, content_pages.slug,
 *    blog_posts.slug
 *  - §7 correction 2 — media_assets.storage_key, content_pages.slug and
 *    blog_posts.slug use PARTIAL unique indexes (WHERE deleted_at IS NULL).
 *  - uq_media_checksum is partial on (checksum_sha256) WHERE checksum IS NOT
 *    NULL AND deleted_at IS NULL — dedupe without blocking NULL checksums.
 *  - media_assets.usedIn, banners.clicks/ctr and blog view counts are derived
 *    or roll up into *_stats_daily; they are not maintained on the row.
 *  - TRIGGER trg_<table>_updated (set_updated_at)
 */

import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  boolean,
  integer,
  smallint,
  date,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { staffUsers } from './identity.js';
import { collections, products } from './catalogue.js';

/* ----------------------------------------------------------- media_assets */

export const MEDIA_KINDS = ['image', 'video', 'pdf', 'other'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** S3/Cloudinary object key. Partial-unique (§7 correction 2). */
    storageKey: text('storage_key').notNull(),
    url: text('url').notNull(),
    cdnUrl: text('cdn_url'),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    kind: text('kind').notNull().$type<MediaKind>(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    widthPx: integer('width_px'),
    heightPx: integer('height_px'),
    durationMs: integer('duration_ms'),
    blurhash: text('blurhash'),
    altText: text('alt_text'),
    folder: text('folder'),
    checksumSha256: text('checksum_sha256'),
    uploadedBy: uuid('uploaded_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_media_storage_key').on(t.storageKey).where(sql`deleted_at IS NULL`),
    index('idx_media_kind').on(t.kind, t.createdAt.desc()).where(sql`deleted_at IS NULL`),
    index('idx_media_folder').on(t.folder).where(sql`deleted_at IS NULL`),
    uniqueIndex('uq_media_checksum')
      .on(t.checksumSha256)
      .where(sql`checksum_sha256 IS NOT NULL AND deleted_at IS NULL`),
    check('media_assets_kind_check', sql`kind IN ('image','video','pdf','other')`),
    check('media_assets_bytes_check', sql`bytes > 0`),
  ],
);

/* ----------------------------------------------------------- cms_sections */

export const CMS_LAYOUTS = [
  'full_bleed',
  'grid_4',
  'grid_3',
  'carousel',
  'split_banner',
  'marquee',
  'list',
] as const;
export type CmsLayout = (typeof CMS_LAYOUTS)[number];

export const cmsSections = pgTable(
  'cms_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: DOMAIN handle. 'hero-carousel' | 'shop-by-occasion'. */
    key: text('key').notNull().unique(),
    pageKey: text('page_key').notNull().default('home'),
    title: text('title').notNull(),
    layout: text('layout').notNull().default('grid_4').$type<CmsLayout>(),
    position: integer('position').notNull().default(0),
    isVisible: boolean('is_visible').notNull().default(true),
    settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
    updatedBy: uuid('updated_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_cms_sections_page').on(t.pageKey, t.position).where(sql`is_visible`),
    check(
      'cms_sections_layout_check',
      sql`layout IN ('full_bleed','grid_4','grid_3','carousel','split_banner','marquee','list')`,
    ),
  ],
);

/**
 * The storefront's `seoBlocks` land here. Note that several of their link
 * labels ('Holi', 'Bhai Dooj', 'Colleagues', 'Farewell', 'Thank You',
 * 'Chokers') have NO corresponding collection and are dead links today.
 */
export const cmsSectionItems = pgTable(
  'cms_section_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sectionId: uuid('section_id')
      .notNull()
      .references((): AnyPgColumn => cmsSections.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    label: text('label'),
    sublabel: text('sublabel'),
    mediaId: uuid('media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    linkUrl: text('link_url'),
    collectionId: uuid('collection_id').references((): AnyPgColumn => collections.id, {
      onDelete: 'cascade',
    }),
    productId: uuid('product_id').references((): AnyPgColumn => products.id, {
      onDelete: 'cascade',
    }),
    isVisible: boolean('is_visible').notNull().default(true),
  },
  (t) => [index('idx_cms_items_section').on(t.sectionId, t.position)],
);

/* ---------------------------------------------------------------- banners */

export const BANNER_PLACEMENTS = [
  'homepage_hero',
  'category_top',
  'cart_strip',
  'pdp_ribbon',
  'announcement_bar',
] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];

export const BANNER_DEVICES = ['all', 'desktop', 'mobile'] as const;
export type BannerDevice = (typeof BANNER_DEVICES)[number];

export const BANNER_STATUSES = ['live', 'scheduled', 'expired', 'draft'] as const;
export type BannerStatus = (typeof BANNER_STATUSES)[number];

export const banners = pgTable(
  'banners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    placement: text('placement').notNull().$type<BannerPlacement>(),
    device: text('device').notNull().default('all').$type<BannerDevice>(),
    mediaId: uuid('media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    mobileMediaId: uuid('mobile_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    linkUrl: text('link_url'),
    collectionId: uuid('collection_id').references((): AnyPgColumn => collections.id, {
      onDelete: 'set null',
    }),
    ctaLabel: text('cta_label'),
    position: integer('position').notNull().default(0),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    status: text('status').notNull().default('draft').$type<BannerStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_banners_live').on(t.placement, t.position).where(sql`status = 'live'`),
    check(
      'banners_placement_check',
      sql`placement IN ('homepage_hero','category_top','cart_strip','pdp_ribbon','announcement_bar')`,
    ),
    check('banners_device_check', sql`device IN ('all','desktop','mobile')`),
    check('banners_status_check', sql`status IN ('live','scheduled','expired','draft')`),
    check(
      'banner_window',
      sql`ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at`,
    ),
  ],
);

/** clicks / ctr are analytics, not CMS state. */
export const bannerStatsDaily = pgTable(
  'banner_stats_daily',
  {
    bannerId: uuid('banner_id')
      .notNull()
      .references((): AnyPgColumn => banners.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    impressions: integer('impressions').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bannerId, t.day] })],
);

/* ---------------------------------------------------------- content_pages */

export const CONTENT_PAGE_KINDS = [
  'occasion',
  'policy',
  'landing',
  'about',
  'static',
] as const;
export type ContentPageKind = (typeof CONTENT_PAGE_KINDS)[number];

export const CONTENT_PAGE_STATUSES = ['published', 'draft', 'archived'] as const;
export type ContentPageStatus = (typeof CONTENT_PAGE_STATUSES)[number];

export const contentPages = pgTable(
  'content_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: DOMAIN handle. Partial-unique. */
    slug: text('slug').notNull(),
    kind: text('kind').notNull().$type<ContentPageKind>(),
    title: text('title').notNull(),
    heading: text('heading'),
    /** Ordered rich-text blocks. */
    bodyBlocks: jsonb('body_blocks').notNull().default(sql`'[]'::jsonb`),
    collectionId: uuid('collection_id').references((): AnyPgColumn => collections.id, {
      onDelete: 'set null',
    }),
    heroMediaId: uuid('hero_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('draft').$type<ContentPageStatus>(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    updatedBy: uuid('updated_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_content_pages_slug').on(t.slug).where(sql`deleted_at IS NULL`),
    index('idx_content_pages_kind').on(t.kind, t.status),
    check(
      'content_pages_kind_check',
      sql`kind IN ('occasion','policy','landing','about','static')`,
    ),
    check(
      'content_pages_status_check',
      sql`status IN ('published','draft','archived')`,
    ),
  ],
);

/* ------------------------------------------------------------ seo_entries */
/** Polymorphic. Every routable thing gets at most one. */

export const SEO_ENTITY_TYPES = [
  'product',
  'collection',
  'content_page',
  'blog_post',
  'route',
] as const;
export type SeoEntityType = (typeof SEO_ENTITY_TYPES)[number];

export const seoEntries = pgTable(
  'seo_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityType: text('entity_type').notNull().$type<SeoEntityType>(),
    /** Polymorphic target — no FK. NULL only when entityType = 'route'. */
    entityId: uuid('entity_id'),
    /** For entityType='route', e.g. '/'. */
    routePath: text('route_path'),
    metaTitle: text('meta_title'),
    metaDescription: text('meta_description'),
    canonicalUrl: text('canonical_url'),
    ogMediaId: uuid('og_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    focusKeyword: text('focus_keyword'),
    robotsIndex: boolean('robots_index').notNull().default(true),
    robotsFollow: boolean('robots_follow').notNull().default(true),
    structuredData: jsonb('structured_data'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_seo_entity')
      .on(t.entityType, t.entityId)
      .where(sql`entity_id IS NOT NULL`),
    uniqueIndex('uq_seo_route').on(t.routePath).where(sql`route_path IS NOT NULL`),
    check(
      'seo_entries_entity_type_check',
      sql`entity_type IN ('product','collection','content_page','blog_post','route')`,
    ),
    check(
      'seo_target',
      sql`(entity_type = 'route' AND route_path IS NOT NULL AND entity_id IS NULL) OR (entity_type <> 'route' AND entity_id IS NOT NULL)`,
    ),
  ],
);

/* ------------------------------------------------------------- blog_posts */

export const BLOG_STATUSES = ['published', 'draft', 'scheduled', 'archived'] as const;
export type BlogStatus = (typeof BLOG_STATUSES)[number];

export const blogPosts = pgTable(
  'blog_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: DOMAIN handle. Partial-unique. */
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    excerpt: text('excerpt'),
    bodyBlocks: jsonb('body_blocks').notNull().default(sql`'[]'::jsonb`),
    category: text('category'),
    authorStaffId: uuid('author_staff_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    /** For guest authors. */
    authorName: text('author_name'),
    heroMediaId: uuid('hero_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    readMinutes: smallint('read_minutes'),
    status: text('status').notNull().default('draft').$type<BlogStatus>(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_blog_posts_slug').on(t.slug).where(sql`deleted_at IS NULL`),
    index('idx_blog_published')
      .on(t.publishedAt.desc())
      .where(sql`status = 'published' AND deleted_at IS NULL`),
    index('idx_blog_category').on(t.category, t.publishedAt.desc()),
    check(
      'blog_posts_status_check',
      sql`status IN ('published','draft','scheduled','archived')`,
    ),
    check(
      'blog_published_has_date',
      sql`status <> 'published' OR published_at IS NOT NULL`,
    ),
    check(
      'blog_has_author',
      sql`author_staff_id IS NOT NULL OR author_name IS NOT NULL`,
    ),
  ],
);

/* ------------------------------------------------------------------- faqs */

export const FAQ_STATUSES = ['published', 'draft'] as const;
export type FaqStatus = (typeof FAQ_STATUSES)[number];

/** `answer` is NOT NULL — the admin's Faq type has no answer field at all. */
export const faqs = pgTable(
  'faqs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    category: text('category'),
    position: integer('position').notNull().default(0),
    helpfulCount: integer('helpful_count').notNull().default(0),
    unhelpfulCount: integer('unhelpful_count').notNull().default(0),
    status: text('status').notNull().default('draft').$type<FaqStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_faqs_category').on(t.category, t.position).where(sql`status = 'published'`),
    check('faqs_status_check', sql`status IN ('published','draft')`),
  ],
);

/* ----------------------------------------------------------- testimonials */

export const TESTIMONIAL_STATUSES = ['published', 'pending', 'rejected'] as const;
export type TestimonialStatus = (typeof TESTIMONIAL_STATUSES)[number];

/** Marketing quotes, unlinked to a product. Product reviews are `reviews`. */
export const testimonials = pgTable(
  'testimonials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorName: text('author_name').notNull(),
    /** Storefront shape. */
    authorCity: text('author_city'),
    /** Admin shape (B2B). */
    company: text('company'),
    designation: text('designation'),
    quote: text('quote').notNull(),
    rating: smallint('rating'),
    mediaId: uuid('media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    isFeatured: boolean('is_featured').notNull().default(false),
    position: integer('position').notNull().default(0),
    status: text('status').notNull().default('pending').$type<TestimonialStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_testimonials_pub').on(t.position).where(sql`status = 'published'`),
    check(
      'testimonials_rating_check',
      sql`rating IS NULL OR rating BETWEEN 1 AND 5`,
    ),
    check(
      'testimonials_status_check',
      sql`status IN ('published','pending','rejected')`,
    ),
  ],
);

/* ------------------------------------------------------------------ menus */

export const menus = pgTable('menus', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** DB type: DOMAIN handle. 'header' | 'footer' | 'mobile'. */
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The storefront megaMenu and the admin MenuEntry collapse into this table. */
export const menuItems = pgTable(
  'menu_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    menuId: uuid('menu_id')
      .notNull()
      .references((): AnyPgColumn => menus.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => menuItems.id, {
      onDelete: 'cascade',
    }),
    label: text('label').notNull(),
    url: text('url'),
    collectionId: uuid('collection_id').references((): AnyPgColumn => collections.id, {
      onDelete: 'cascade',
    }),
    contentPageId: uuid('content_page_id').references(
      (): AnyPgColumn => contentPages.id,
      { onDelete: 'cascade' },
    ),
    mediaId: uuid('media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    position: integer('position').notNull().default(0),
    isVisible: boolean('is_visible').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_menu_items').on(t.menuId, t.parentId, t.position).where(sql`is_visible`),
    check('menu_item_no_self_parent', sql`parent_id IS DISTINCT FROM id`),
    // Top-level groups may be non-clickable.
    check(
      'menu_item_has_target',
      sql`url IS NOT NULL OR collection_id IS NOT NULL OR content_page_id IS NOT NULL OR parent_id IS NULL`,
    ),
  ],
);

/* -------------------------------------------------------------- relations */

export const mediaAssetsRelations = relations(mediaAssets, ({ one }) => ({
  uploader: one(staffUsers, {
    fields: [mediaAssets.uploadedBy],
    references: [staffUsers.id],
  }),
}));

export const cmsSectionsRelations = relations(cmsSections, ({ many }) => ({
  items: many(cmsSectionItems),
}));

export const cmsSectionItemsRelations = relations(cmsSectionItems, ({ one }) => ({
  section: one(cmsSections, {
    fields: [cmsSectionItems.sectionId],
    references: [cmsSections.id],
  }),
  media: one(mediaAssets, {
    fields: [cmsSectionItems.mediaId],
    references: [mediaAssets.id],
  }),
  collection: one(collections, {
    fields: [cmsSectionItems.collectionId],
    references: [collections.id],
  }),
  product: one(products, {
    fields: [cmsSectionItems.productId],
    references: [products.id],
  }),
}));

export const bannersRelations = relations(banners, ({ one, many }) => ({
  media: one(mediaAssets, {
    fields: [banners.mediaId],
    references: [mediaAssets.id],
    relationName: 'banner_media',
  }),
  collection: one(collections, {
    fields: [banners.collectionId],
    references: [collections.id],
  }),
  stats: many(bannerStatsDaily),
}));

export const bannerStatsDailyRelations = relations(bannerStatsDaily, ({ one }) => ({
  banner: one(banners, {
    fields: [bannerStatsDaily.bannerId],
    references: [banners.id],
  }),
}));

export const contentPagesRelations = relations(contentPages, ({ one, many }) => ({
  collection: one(collections, {
    fields: [contentPages.collectionId],
    references: [collections.id],
  }),
  heroMedia: one(mediaAssets, {
    fields: [contentPages.heroMediaId],
    references: [mediaAssets.id],
  }),
  menuItems: many(menuItems),
}));

export const blogPostsRelations = relations(blogPosts, ({ one }) => ({
  authorStaff: one(staffUsers, {
    fields: [blogPosts.authorStaffId],
    references: [staffUsers.id],
  }),
  heroMedia: one(mediaAssets, {
    fields: [blogPosts.heroMediaId],
    references: [mediaAssets.id],
  }),
}));

export const menusRelations = relations(menus, ({ many }) => ({
  items: many(menuItems),
}));

export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
  menu: one(menus, { fields: [menuItems.menuId], references: [menus.id] }),
  parent: one(menuItems, {
    fields: [menuItems.parentId],
    references: [menuItems.id],
    relationName: 'menu_item_parent',
  }),
  children: many(menuItems, { relationName: 'menu_item_parent' }),
  collection: one(collections, {
    fields: [menuItems.collectionId],
    references: [collections.id],
  }),
  contentPage: one(contentPages, {
    fields: [menuItems.contentPageId],
    references: [contentPages.id],
  }),
}));

/* ------------------------------------------------------------------ types */

export type MediaAsset = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;
export type CmsSection = typeof cmsSections.$inferSelect;
export type NewCmsSection = typeof cmsSections.$inferInsert;
export type CmsSectionItem = typeof cmsSectionItems.$inferSelect;
export type NewCmsSectionItem = typeof cmsSectionItems.$inferInsert;
export type Banner = typeof banners.$inferSelect;
export type NewBanner = typeof banners.$inferInsert;
export type BannerStatsDaily = typeof bannerStatsDaily.$inferSelect;
export type NewBannerStatsDaily = typeof bannerStatsDaily.$inferInsert;
export type ContentPage = typeof contentPages.$inferSelect;
export type NewContentPage = typeof contentPages.$inferInsert;
export type SeoEntry = typeof seoEntries.$inferSelect;
export type NewSeoEntry = typeof seoEntries.$inferInsert;
export type BlogPost = typeof blogPosts.$inferSelect;
export type NewBlogPost = typeof blogPosts.$inferInsert;
export type Faq = typeof faqs.$inferSelect;
export type NewFaq = typeof faqs.$inferInsert;
export type Testimonial = typeof testimonials.$inferSelect;
export type NewTestimonial = typeof testimonials.$inferInsert;
export type Menu = typeof menus.$inferSelect;
export type NewMenu = typeof menus.$inferInsert;
export type MenuItem = typeof menuItems.$inferSelect;
export type NewMenuItem = typeof menuItems.$inferInsert;
