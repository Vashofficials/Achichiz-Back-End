/**
 * Drizzle queries for storefront content. No business rules, no HTTP.
 *
 * Every predicate in this file is a publication gate. `contentIsPublished`,
 * `blogIsPublished` and `bannerIsLive` exist so a new endpoint cannot forget
 * one — an unpublished policy page or a scheduled banner leaking early is a
 * content bug that looks like a security bug.
 */

import { and, asc, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../config/db.js';
import {
  banners,
  blogPosts,
  cmsSectionItems,
  cmsSections,
  contentPages,
  faqs,
  menuItems,
  menus,
  seoEntries,
  staffUsers,
  testimonials,
} from '../../db/schema/index.js';

/* ------------------------------------------------------------------ types */

export type ImageRow = { id: string; url: string; altText: string | null };

export type SortSpec = { field: string; direction: 'asc' | 'desc' };
export type Page = { limit: number; offset: number };

export type BlogRow = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  category: string | null;
  authorName: string | null;
  heroImage: ImageRow | null;
  readMinutes: number | null;
  viewCount: number;
  publishedAt: Date | null;
  body: unknown;
};

export type ContentPageRow = {
  id: string;
  slug: string;
  kind: string;
  title: string;
  heading: string | null;
  heroImage: ImageRow | null;
  collectionHandle: string | null;
  publishedAt: Date | null;
  body: unknown;
};

export type FaqRow = {
  id: string;
  question: string;
  answer: string;
  category: string | null;
  position: number;
  helpfulCount: number;
  unhelpfulCount: number;
};

export type TestimonialRow = {
  id: string;
  authorName: string;
  authorCity: string | null;
  company: string | null;
  designation: string | null;
  quote: string;
  rating: number | null;
  image: ImageRow | null;
  isFeatured: boolean;
  position: number;
};

export type CmsSectionRow = {
  id: string;
  key: string;
  pageKey: string;
  title: string;
  layout: string;
  position: number;
  settings: unknown;
};

export type CmsSectionItemRow = {
  id: string;
  sectionId: string;
  position: number;
  label: string | null;
  sublabel: string | null;
  image: ImageRow | null;
  linkUrl: string | null;
  collectionHandle: string | null;
  productHandle: string | null;
};

export type BannerRow = {
  id: string;
  title: string;
  subtitle: string | null;
  placement: string;
  device: string;
  image: ImageRow | null;
  mobileImage: ImageRow | null;
  linkUrl: string | null;
  collectionHandle: string | null;
  ctaLabel: string | null;
  position: number;
};

export type SeoRow = {
  entityType: string;
  entityId: string | null;
  routePath: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  focusKeyword: string | null;
  robotsIndex: boolean;
  robotsFollow: boolean;
  ogImageUrl: string | null;
  structuredData: unknown;
};

export type MenuRow = { id: string; key: string; name: string };

export type MenuItemRow = {
  id: string;
  parentId: string | null;
  label: string;
  url: string | null;
  collectionHandle: string | null;
  contentPageSlug: string | null;
  image: ImageRow | null;
  position: number;
};

/* ------------------------------------------------------ shared fragments */

/** `json_build_object` for a media FK, or SQL NULL when the FK is unset or soft-deleted. */
const imageOf = (mediaIdColumn: SQL): SQL<ImageRow | null> => sql<ImageRow | null>`(
  SELECT json_build_object('id', m.id, 'url', coalesce(m.cdn_url, m.url), 'altText', m.alt_text)
  FROM media_assets m WHERE m.id = ${mediaIdColumn} AND m.deleted_at IS NULL
)`;

const handleOfCollection = (idColumn: SQL): SQL<string | null> => sql<string | null>`(
  SELECT c.handle FROM collections c
  WHERE c.id = ${idColumn} AND c.deleted_at IS NULL
)`;

const orderOf = (map: Record<string, SQL>, sort: SortSpec, fallbackField: string): SQL[] => {
  const expr = map[sort.field] ?? map[fallbackField];
  return expr ? [sort.direction === 'asc' ? asc(expr) : desc(expr)] : [];
};

/* ------------------------------------------------------------- the journal */

/** Published means published: `scheduled` posts stay hidden until a job flips them. */
const blogIsPublished: SQL = sql`${blogPosts.status} = 'published'
  AND ${blogPosts.deletedAt} IS NULL
  AND ${blogPosts.publishedAt} IS NOT NULL
  AND ${blogPosts.publishedAt} <= now()`;

const blogSelection = {
  id: blogPosts.id,
  slug: blogPosts.slug,
  title: blogPosts.title,
  excerpt: blogPosts.excerpt,
  category: blogPosts.category,
  authorName: sql<string | null>`coalesce(${staffUsers.fullName}, ${blogPosts.authorName})`,
  heroImage: imageOf(sql`${blogPosts.heroMediaId}`),
  readMinutes: blogPosts.readMinutes,
  viewCount: blogPosts.viewCount,
  publishedAt: blogPosts.publishedAt,
  body: blogPosts.bodyBlocks,
};

const BLOG_ORDER: Record<string, SQL> = {
  publishedAt: sql`${blogPosts.publishedAt}`,
  title: sql`${blogPosts.title}`,
  viewCount: sql`${blogPosts.viewCount}`,
};

export async function listBlogPosts(
  opts: { q?: string | undefined; category?: string | undefined },
  sort: SortSpec,
  page: Page,
): Promise<{ rows: BlogRow[]; total: number }> {
  const parts: SQL[] = [blogIsPublished];
  if (opts.q) {
    const pattern = `%${opts.q}%`;
    parts.push(
      sql`(${blogPosts.title} ILIKE ${pattern} OR coalesce(${blogPosts.excerpt}, '') ILIKE ${pattern})`,
    );
  }
  if (opts.category) parts.push(sql`${blogPosts.category} = ${opts.category}`);
  const where = sql.join(parts, sql` AND `);

  const [rows, totals] = await Promise.all([
    db
      .select(blogSelection)
      .from(blogPosts)
      .leftJoin(staffUsers, eq(staffUsers.id, blogPosts.authorStaffId))
      .where(where)
      .orderBy(...orderOf(BLOG_ORDER, sort, 'publishedAt'), asc(blogPosts.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(blogPosts)
      .where(where),
  ]);

  return { rows: rows, total: totals[0]?.total ?? 0 };
}

export async function findBlogPostBySlug(slug: string): Promise<BlogRow | null> {
  const rows = await db
    .select(blogSelection)
    .from(blogPosts)
    .leftJoin(staffUsers, eq(staffUsers.id, blogPosts.authorStaffId))
    .where(and(eq(blogPosts.slug, slug), blogIsPublished))
    .limit(1);

  return rows[0] ?? null;
}

/** Newest other posts in the same category — the "keep reading" rail. */
export async function listRelatedBlogSlugs(
  postId: string,
  category: string | null,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ slug: blogPosts.slug })
    .from(blogPosts)
    .where(
      and(
        sql`${blogPosts.id} <> ${postId}`,
        blogIsPublished,
        category === null ? sql`true` : sql`${blogPosts.category} = ${category}`,
      ),
    )
    .orderBy(desc(blogPosts.publishedAt), asc(blogPosts.id))
    .limit(limit);

  return rows.map((r) => r.slug);
}

/* ----------------------------------------------------------- content pages */

const contentIsPublished: SQL = sql`${contentPages.status} = 'published'
  AND ${contentPages.deletedAt} IS NULL`;

const contentPageSelection = {
  id: contentPages.id,
  slug: contentPages.slug,
  kind: contentPages.kind,
  title: contentPages.title,
  heading: contentPages.heading,
  heroImage: imageOf(sql`${contentPages.heroMediaId}`),
  collectionHandle: handleOfCollection(sql`${contentPages.collectionId}`),
  publishedAt: contentPages.publishedAt,
  body: contentPages.bodyBlocks,
};

const PAGE_ORDER: Record<string, SQL> = {
  publishedAt: sql`${contentPages.publishedAt}`,
  title: sql`${contentPages.title}`,
  slug: sql`${contentPages.slug}`,
};

export async function listContentPages(
  opts: { q?: string | undefined; kind?: string | undefined },
  sort: SortSpec,
  page: Page,
): Promise<{ rows: ContentPageRow[]; total: number }> {
  const parts: SQL[] = [contentIsPublished];
  if (opts.q) parts.push(sql`${contentPages.title} ILIKE ${`%${opts.q}%`}`);
  if (opts.kind) parts.push(sql`${contentPages.kind} = ${opts.kind}`);
  const where = sql.join(parts, sql` AND `);

  const [rows, totals] = await Promise.all([
    db
      .select(contentPageSelection)
      .from(contentPages)
      .where(where)
      .orderBy(...orderOf(PAGE_ORDER, sort, 'title'), asc(contentPages.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(contentPages)
      .where(where),
  ]);

  return { rows: rows, total: totals[0]?.total ?? 0 };
}

export async function findContentPageBySlug(slug: string, kind?: string): Promise<ContentPageRow | null> {
  const rows = await db
    .select(contentPageSelection)
    .from(contentPages)
    .where(
      and(
        eq(contentPages.slug, slug),
        contentIsPublished,
        kind === undefined ? sql`true` : sql`${contentPages.kind} = ${kind}`,
      ),
    )
    .limit(1);

  return (rows[0] as ContentPageRow | undefined) ?? null;
}

/* --------------------------------------------------------------------- faqs */

const FAQ_ORDER: Record<string, SQL> = {
  position: sql`${faqs.position}`,
  question: sql`${faqs.question}`,
  helpfulCount: sql`${faqs.helpfulCount}`,
};

export async function listFaqs(
  opts: { q?: string | undefined; category?: string | undefined },
  sort: SortSpec,
  page: Page,
): Promise<{ rows: FaqRow[]; total: number }> {
  const parts: SQL[] = [sql`${faqs.status} = 'published' AND ${faqs.deletedAt} IS NULL`];
  if (opts.q) {
    const pattern = `%${opts.q}%`;
    parts.push(sql`(${faqs.question} ILIKE ${pattern} OR ${faqs.answer} ILIKE ${pattern})`);
  }
  if (opts.category) parts.push(sql`${faqs.category} = ${opts.category}`);
  const where = sql.join(parts, sql` AND `);

  const selection = {
    id: faqs.id,
    question: faqs.question,
    answer: faqs.answer,
    category: faqs.category,
    position: faqs.position,
    helpfulCount: faqs.helpfulCount,
    unhelpfulCount: faqs.unhelpfulCount,
  };

  const [rows, totals] = await Promise.all([
    db
      .select(selection)
      .from(faqs)
      .where(where)
      .orderBy(...orderOf(FAQ_ORDER, sort, 'position'), asc(faqs.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(faqs)
      .where(where),
  ]);

  return { rows, total: totals[0]?.total ?? 0 };
}

/* -------------------------------------------------------------- testimonials */

const TESTIMONIAL_ORDER: Record<string, SQL> = {
  position: sql`${testimonials.position}`,
  createdAt: sql`${testimonials.createdAt}`,
  rating: sql`${testimonials.rating}`,
};

export async function listTestimonials(
  opts: { q?: string | undefined; featured?: boolean | undefined },
  sort: SortSpec,
  page: Page,
): Promise<{ rows: TestimonialRow[]; total: number }> {
  const parts: SQL[] = [sql`${testimonials.status} = 'published'`];
  if (opts.q) parts.push(sql`${testimonials.quote} ILIKE ${`%${opts.q}%`}`);
  if (opts.featured) parts.push(sql`${testimonials.isFeatured}`);
  const where = sql.join(parts, sql` AND `);

  const selection = {
    id: testimonials.id,
    authorName: testimonials.authorName,
    authorCity: testimonials.authorCity,
    company: testimonials.company,
    designation: testimonials.designation,
    quote: testimonials.quote,
    rating: testimonials.rating,
    image: imageOf(sql`${testimonials.mediaId}`),
    isFeatured: testimonials.isFeatured,
    position: testimonials.position,
  };

  const [rows, totals] = await Promise.all([
    db
      .select(selection)
      .from(testimonials)
      .where(where)
      .orderBy(...orderOf(TESTIMONIAL_ORDER, sort, 'position'), asc(testimonials.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(testimonials)
      .where(where),
  ]);

  return { rows: rows, total: totals[0]?.total ?? 0 };
}

/* -------------------------------------------------------------- CMS sections */

const CMS_ORDER: Record<string, SQL> = {
  position: sql`${cmsSections.position}`,
  title: sql`${cmsSections.title}`,
};

export async function listCmsSections(
  opts: { q?: string | undefined; pageKey?: string | undefined },
  sort: SortSpec,
  page: Page,
): Promise<{ rows: CmsSectionRow[]; total: number }> {
  const parts: SQL[] = [sql`${cmsSections.isVisible}`];
  if (opts.q) parts.push(sql`${cmsSections.title} ILIKE ${`%${opts.q}%`}`);
  if (opts.pageKey) parts.push(sql`${cmsSections.pageKey} = ${opts.pageKey}`);
  const where = sql.join(parts, sql` AND `);

  const selection = {
    id: cmsSections.id,
    key: cmsSections.key,
    pageKey: cmsSections.pageKey,
    title: cmsSections.title,
    layout: cmsSections.layout,
    position: cmsSections.position,
    settings: cmsSections.settings,
  };

  const [rows, totals] = await Promise.all([
    db
      .select(selection)
      .from(cmsSections)
      .where(where)
      .orderBy(...orderOf(CMS_ORDER, sort, 'position'), asc(cmsSections.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(cmsSections)
      .where(where),
  ]);

  return { rows: rows, total: totals[0]?.total ?? 0 };
}

/**
 * Items for a page of sections, fetched in one round trip.
 *
 * A tile whose collection or product has been unpublished is dropped rather than
 * rendered as a dead link — the homepage already has a documented history of
 * those (`content.ts`, `cms_section_items`).
 */
export async function listCmsSectionItems(sectionIds: string[]): Promise<CmsSectionItemRow[]> {
  if (sectionIds.length === 0) return [];

  const rows = await db
    .select({
      id: cmsSectionItems.id,
      sectionId: cmsSectionItems.sectionId,
      position: cmsSectionItems.position,
      label: cmsSectionItems.label,
      sublabel: cmsSectionItems.sublabel,
      image: imageOf(sql`${cmsSectionItems.mediaId}`),
      linkUrl: cmsSectionItems.linkUrl,
      collectionHandle: handleOfCollection(sql`${cmsSectionItems.collectionId}`),
      productHandle: sql<string | null>`(
        SELECT p.handle FROM products p
        WHERE p.id = ${cmsSectionItems.productId}
          AND p.status = 'active' AND p.deleted_at IS NULL
      )`,
    })
    .from(cmsSectionItems)
    .where(
      and(
        // `sql.param` + cast: a bare `${sectionIds}` expands to the row
        // constructor `ANY(($1, $2))`, which Postgres cannot compare to a uuid.
        sql`${cmsSectionItems.sectionId} = ANY(${sql.param(sectionIds)}::uuid[])`,
        sql`${cmsSectionItems.isVisible}`,
        // Keep tiles that target nothing in particular; drop ones whose target died.
        or(
          isNull(cmsSectionItems.productId),
          sql`EXISTS (SELECT 1 FROM products p WHERE p.id = ${cmsSectionItems.productId}
                AND p.status = 'active' AND p.deleted_at IS NULL)`,
        ),
        or(
          isNull(cmsSectionItems.collectionId),
          sql`EXISTS (SELECT 1 FROM collections c WHERE c.id = ${cmsSectionItems.collectionId}
                AND c.status = 'live' AND c.deleted_at IS NULL)`,
        ),
      ),
    )
    .orderBy(asc(cmsSectionItems.position), asc(cmsSectionItems.id));

  return rows;
}

/* ------------------------------------------------------------------ banners */

/**
 * Live means live NOW. A `scheduled` banner whose window has opened is live even
 * if no job has flipped its status yet, and a `live` one whose window has closed
 * is not — the clock is the authority, not the column.
 */
const bannerIsLive: SQL = sql`${banners.status} IN ('live', 'scheduled')
  AND (${banners.startsAt} IS NULL OR ${banners.startsAt} <= now())
  AND (${banners.endsAt} IS NULL OR ${banners.endsAt} > now())`;

const BANNER_ORDER: Record<string, SQL> = {
  position: sql`${banners.position}`,
  startsAt: sql`${banners.startsAt}`,
};

export async function listBanners(
  opts: { q?: string | undefined; placement?: string | undefined; device?: string | undefined },
  sort: SortSpec,
  page: Page,
): Promise<{ rows: BannerRow[]; total: number }> {
  const parts: SQL[] = [bannerIsLive];
  if (opts.q) parts.push(sql`${banners.title} ILIKE ${`%${opts.q}%`}`);
  if (opts.placement) parts.push(sql`${banners.placement} = ${opts.placement}`);
  if (opts.device) parts.push(sql`${banners.device} IN ('all', ${opts.device})`);
  const where = sql.join(parts, sql` AND `);

  const selection = {
    id: banners.id,
    title: banners.title,
    subtitle: banners.subtitle,
    placement: banners.placement,
    device: banners.device,
    image: imageOf(sql`${banners.mediaId}`),
    mobileImage: imageOf(sql`${banners.mobileMediaId}`),
    linkUrl: banners.linkUrl,
    collectionHandle: handleOfCollection(sql`${banners.collectionId}`),
    ctaLabel: banners.ctaLabel,
    position: banners.position,
  };

  const [rows, totals] = await Promise.all([
    db
      .select(selection)
      .from(banners)
      .where(where)
      .orderBy(...orderOf(BANNER_ORDER, sort, 'position'), asc(banners.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(banners)
      .where(where),
  ]);

  return { rows: rows, total: totals[0]?.total ?? 0 };
}

/* ---------------------------------------------------------------------- seo */

const seoSelection = {
  entityType: seoEntries.entityType,
  entityId: seoEntries.entityId,
  routePath: seoEntries.routePath,
  metaTitle: seoEntries.metaTitle,
  metaDescription: seoEntries.metaDescription,
  canonicalUrl: seoEntries.canonicalUrl,
  focusKeyword: seoEntries.focusKeyword,
  robotsIndex: seoEntries.robotsIndex,
  robotsFollow: seoEntries.robotsFollow,
  ogImageUrl: sql<string | null>`(
    SELECT coalesce(m.cdn_url, m.url) FROM media_assets m
    WHERE m.id = ${seoEntries.ogMediaId} AND m.deleted_at IS NULL
  )`,
  structuredData: seoEntries.structuredData,
};

export async function findSeoForEntity(entityType: string, entityId: string): Promise<SeoRow | null> {
  const rows = await db
    .select(seoSelection)
    .from(seoEntries)
    .where(and(sql`${seoEntries.entityType} = ${entityType}`, eq(seoEntries.entityId, entityId)))
    .limit(1);

  return (rows[0] as SeoRow | undefined) ?? null;
}

export async function findSeoForRoute(routePath: string): Promise<SeoRow | null> {
  const rows = await db
    .select(seoSelection)
    .from(seoEntries)
    .where(and(eq(seoEntries.entityType, 'route'), eq(seoEntries.routePath, routePath)))
    .limit(1);

  return (rows[0] as SeoRow | undefined) ?? null;
}

/* -------------------------------------------------------------------- menus */

export async function findMenuByKey(key: string): Promise<MenuRow | null> {
  const rows = await db
    .select({ id: menus.id, key: menus.key, name: menus.name })
    .from(menus)
    .where(eq(menus.key, key))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Flat, depth-then-position ordered. Items pointing at a dead collection or an
 * unpublished page are dropped; top-level group headers with no target are kept,
 * because they are labels rather than links.
 */
export async function listMenuItems(menuId: string): Promise<MenuItemRow[]> {
  const parentItems = alias(menuItems, 'parent_item');

  const rows = await db
    .select({
      id: menuItems.id,
      parentId: menuItems.parentId,
      label: menuItems.label,
      url: menuItems.url,
      collectionHandle: handleOfCollection(sql`${menuItems.collectionId}`),
      contentPageSlug: sql<string | null>`(
        SELECT cp.slug FROM content_pages cp
        WHERE cp.id = ${menuItems.contentPageId}
          AND cp.status = 'published' AND cp.deleted_at IS NULL
      )`,
      image: imageOf(sql`${menuItems.mediaId}`),
      position: menuItems.position,
      parentPosition: sql<number>`coalesce(${parentItems.position}, -1)`,
    })
    .from(menuItems)
    .leftJoin(parentItems, eq(parentItems.id, menuItems.parentId))
    .where(
      and(
        eq(menuItems.menuId, menuId),
        sql`${menuItems.isVisible}`,
        // A hidden parent hides its whole branch.
        sql`(${menuItems.parentId} IS NULL OR ${parentItems.isVisible})`,
        or(
          isNull(menuItems.collectionId),
          sql`EXISTS (SELECT 1 FROM collections c WHERE c.id = ${menuItems.collectionId}
                AND c.status = 'live' AND c.deleted_at IS NULL)`,
        ),
      ),
    )
    .orderBy(
      // Parents first, each immediately followed by its children.
      sql`coalesce(${parentItems.position}, ${menuItems.position})`,
      sql`${menuItems.parentId} ASC NULLS FIRST`,
      asc(menuItems.position),
      asc(menuItems.id),
    );

  return rows.map(({ parentPosition: _parentPosition, ...item }) => item);
}
