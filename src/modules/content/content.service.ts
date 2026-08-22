/**
 * Content business rules: publication gating (delegated to the repository),
 * row → DTO mapping, and the Redis read-through cache.
 *
 * Content changes rarely and is read on every page load, so it caches longer
 * than the catalogue does. Nothing here knows about HTTP — a missing page is a
 * `NotFoundError`.
 */

import { cache } from '../../config/redis.js';
import { logger } from '../../config/logger.js';
import { NotFoundError } from '../../lib/errors.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import * as repo from './content.repository.js';
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
  type BannerListQuery,
  type BannerResponse,
  type BlogListQuery,
  type BlogPostDetail,
  type BlogPostSummary,
  type CmsSectionListQuery,
  type CmsSectionResponse,
  type ContentPageDetail,
  type ContentPageListQuery,
  type ContentPageSummary,
  type FaqListQuery,
  type FaqResponse,
  type MenuResponse,
  type SeoEntryResponse,
  type SeoQuery,
  type TestimonialListQuery,
  type TestimonialResponse,
} from './content.schemas.js';

/* ----------------------------------------------------------------- cache */

const CACHE_PREFIX = 'content:v1';
const LIST_TTL_SECONDS = 300;
const DETAIL_TTL_SECONDS = 300;
/** Banners carry a schedule, so they must not outlive their own start time by much. */
const BANNER_TTL_SECONDS = 60;

function cacheKey(resource: string, params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`);
  return `${CACHE_PREFIX}:${resource}:${parts.join('&')}`;
}

/** Read-through. A Redis failure degrades to a database read, never to a 500. */
async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  try {
    const hit = await cache.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (err) {
    logger.warn({ err, key }, 'content cache read failed; falling through to postgres');
  }

  const value = await load();

  try {
    await cache.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, 'content cache write failed');
  }

  return value;
}

const pageOf = (q: { page: number; perPage: number }): repo.Page => ({
  limit: q.perPage,
  offset: offsetOf(q.page, q.perPage),
});

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const asBlocks = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/* -------------------------------------------------------------- mappers */

function toBlogSummary(row: repo.BlogRow): BlogPostSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    category: row.category,
    authorName: row.authorName,
    heroImage: row.heroImage,
    readMinutes: row.readMinutes,
    viewCount: row.viewCount,
    publishedAt: iso(row.publishedAt),
  };
}

function toPageSummary(row: repo.ContentPageRow): ContentPageSummary {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind as ContentPageSummary['kind'],
    title: row.title,
    heading: row.heading,
    heroImage: row.heroImage,
    collectionHandle: row.collectionHandle,
    publishedAt: iso(row.publishedAt),
  };
}

function toSeo(row: repo.SeoRow | null): SeoEntryResponse | null {
  if (!row) return null;
  return {
    entityType: row.entityType as SeoEntryResponse['entityType'],
    entityId: row.entityId,
    routePath: row.routePath,
    metaTitle: row.metaTitle,
    metaDescription: row.metaDescription,
    canonicalUrl: row.canonicalUrl,
    focusKeyword: row.focusKeyword,
    robotsIndex: row.robotsIndex,
    robotsFollow: row.robotsFollow,
    ogImageUrl: row.ogImageUrl,
    structuredData: row.structuredData ?? null,
  };
}

/** The detail responses embed the SEO block without the polymorphic target keys. */
function toSeoBlock(row: repo.SeoRow | null): BlogPostDetail['seo'] {
  const full = toSeo(row);
  if (!full) return null;
  const { entityType: _entityType, entityId: _entityId, routePath: _routePath, ...block } = full;
  return block;
}

/* ------------------------------------------------------------ the journal */

export async function listBlogPosts(
  query: BlogListQuery,
): Promise<{ items: BlogPostSummary[]; total: number }> {
  const sort = parseSort(query.sort, BLOG_SORT_FIELDS, BLOG_SORT_FALLBACK);
  const opts = { q: query.q, category: query.category };

  return cached(
    cacheKey('blog', {
      ...opts,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listBlogPosts(opts, sort, pageOf(query));
      return { items: rows.map(toBlogSummary), total };
    },
  );
}

export async function getBlogPostBySlug(slug: string): Promise<BlogPostDetail> {
  return cached(cacheKey('post', { slug }), DETAIL_TTL_SECONDS, async () => {
    const row = await repo.findBlogPostBySlug(slug);
    if (!row) throw new NotFoundError('Journal post', slug);

    const [relatedSlugs, seo] = await Promise.all([
      repo.listRelatedBlogSlugs(row.id, row.category, 3),
      repo.findSeoForEntity('blog_post', row.id),
    ]);

    return {
      ...toBlogSummary(row),
      body: asBlocks(row.body),
      relatedSlugs,
      seo: toSeoBlock(seo),
    } satisfies BlogPostDetail;
  });
}

/* ---------------------------------------------------------- content pages */

export async function listContentPages(
  query: ContentPageListQuery,
): Promise<{ items: ContentPageSummary[]; total: number }> {
  const sort = parseSort(query.sort, PAGE_SORT_FIELDS, PAGE_SORT_FALLBACK);
  const opts = { q: query.q, kind: query.kind };

  return cached(
    cacheKey('pages', {
      ...opts,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listContentPages(opts, sort, pageOf(query));
      return { items: rows.map(toPageSummary), total };
    },
  );
}

async function loadPage(slug: string, kind: string | undefined, label: string): Promise<ContentPageDetail> {
  const row = await repo.findContentPageBySlug(slug, kind);
  if (!row) throw new NotFoundError(label, slug);

  const seo = await repo.findSeoForEntity('content_page', row.id);

  return {
    ...toPageSummary(row),
    body: asBlocks(row.body),
    seo: toSeoBlock(seo),
  } satisfies ContentPageDetail;
}

export async function getContentPageBySlug(slug: string): Promise<ContentPageDetail> {
  return cached(cacheKey('page', { slug }), DETAIL_TTL_SECONDS, () => loadPage(slug, undefined, 'Page'));
}

/**
 * Policies are content pages with `kind='policy'`. The separate route exists
 * because `/policies/:slug` is a published, linkable URL and because it must not
 * be possible to reach an occasion landing page through it.
 */
export async function getPolicyBySlug(slug: string): Promise<ContentPageDetail> {
  return cached(cacheKey('policy', { slug }), DETAIL_TTL_SECONDS, () => loadPage(slug, 'policy', 'Policy'));
}

/* --------------------------------------------------------- faqs & quotes */

export async function listFaqs(query: FaqListQuery): Promise<{ items: FaqResponse[]; total: number }> {
  const sort = parseSort(query.sort, FAQ_SORT_FIELDS, FAQ_SORT_FALLBACK);
  const opts = { q: query.q, category: query.category };

  return cached(
    cacheKey('faqs', {
      ...opts,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listFaqs(opts, sort, pageOf(query));
      return { items: rows, total };
    },
  );
}

export async function listTestimonials(
  query: TestimonialListQuery,
): Promise<{ items: TestimonialResponse[]; total: number }> {
  const sort = parseSort(query.sort, TESTIMONIAL_SORT_FIELDS, TESTIMONIAL_SORT_FALLBACK);
  const opts = { q: query.q, featured: query.featured };

  return cached(
    cacheKey('testimonials', {
      ...opts,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listTestimonials(opts, sort, pageOf(query));
      return { items: rows, total };
    },
  );
}

/* ------------------------------------------------------------ CMS & banners */

export async function listCmsSections(
  query: CmsSectionListQuery,
): Promise<{ items: CmsSectionResponse[]; total: number }> {
  const sort = parseSort(query.sort, CMS_SECTION_SORT_FIELDS, CMS_SECTION_SORT_FALLBACK);
  const opts = { q: query.q, pageKey: query.pageKey };

  return cached(
    cacheKey('sections', {
      ...opts,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    LIST_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listCmsSections(opts, sort, pageOf(query));
      const items = await repo.listCmsSectionItems(rows.map((r) => r.id));

      return {
        items: rows.map((section) => ({
          id: section.id,
          key: section.key,
          pageKey: section.pageKey,
          title: section.title,
          layout: section.layout as CmsSectionResponse['layout'],
          position: section.position,
          settings: section.settings ?? {},
          items: items
            .filter((i) => i.sectionId === section.id)
            .map(({ sectionId: _sectionId, ...item }) => item),
        })),
        total,
      };
    },
  );
}

export async function listBanners(
  query: BannerListQuery,
): Promise<{ items: BannerResponse[]; total: number }> {
  const sort = parseSort(query.sort, BANNER_SORT_FIELDS, BANNER_SORT_FALLBACK);
  const opts = { q: query.q, placement: query.placement, device: query.device };

  return cached(
    cacheKey('banners', {
      ...opts,
      sort: `${sort.direction}:${sort.field}`,
      page: query.page,
      perPage: query.perPage,
    }),
    BANNER_TTL_SECONDS,
    async () => {
      const { rows, total } = await repo.listBanners(opts, sort, pageOf(query));
      return {
        items: rows.map((row) => ({
          ...row,
          placement: row.placement as BannerResponse['placement'],
          device: row.device as BannerResponse['device'],
        })),
        total,
      };
    },
  );
}

/* ------------------------------------------------------------------- seo */

export async function getSeo(query: SeoQuery): Promise<SeoEntryResponse> {
  const row = query.routePath
    ? await repo.findSeoForRoute(query.routePath)
    : await repo.findSeoForEntity(query.entityType ?? '', query.entityId ?? '');

  const seo = toSeo(row);
  if (!seo) throw new NotFoundError('SEO entry', query.routePath ?? query.entityId);
  return seo;
}

/* ----------------------------------------------------------------- menus */

export async function getMenuByKey(key: string): Promise<MenuResponse> {
  return cached(cacheKey('menu', { key }), LIST_TTL_SECONDS, async () => {
    const menuRow = await repo.findMenuByKey(key);
    if (!menuRow) throw new NotFoundError('Menu', key);

    const items = await repo.listMenuItems(menuRow.id);
    return { ...menuRow, items } satisfies MenuResponse;
  });
}
