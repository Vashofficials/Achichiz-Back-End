import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated, pageMeta } from '../../lib/http.js';
import * as content from './content.service.js';
import {
  banner,
  bannerListQuery,
  blogListQuery,
  blogPostDetail,
  blogPostSummary,
  cmsSection,
  cmsSectionListQuery,
  contentPageDetail,
  contentPageListQuery,
  contentPageSummary,
  faq,
  faqListQuery,
  menu,
  menuKeyParam,
  seoEntry,
  seoQuery,
  slugParam,
  testimonial,
  testimonialListQuery,
} from './content.schemas.js';

/**
 * Storefront content: the journal, occasion and policy pages, FAQs,
 * testimonials, CMS sections, banners, SEO records and navigation menus.
 *
 * Everything is public and read-only, and only published rows are ever
 * returned — the publication gate lives in the repository, not here.
 */
export const contentRouter: Router = Router();

const ENVELOPE_NOTE =
  'Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.';

/* ------------------------------------------------------------ the journal */

defineRoute(contentRouter, {
  method: 'get',
  path: '/v1/blog/posts',
  surface: 'storefront',
  operationId: 'listBlogPosts',
  summary: 'List journal posts',
  description: `Published posts, newest first. Scheduled posts stay hidden until their publish time passes. ${ENVELOPE_NOTE}`,
  tags: ['Journal'],
  auth: 'public',
  request: { query: blogListQuery },
  responses: {
    200: { description: 'A page of journal posts.', schema: z.array(blogPostSummary) },
  },
  handler: async ({ query }) => {
    const { items, total } = await content.listBlogPosts(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(contentRouter, {
  method: 'get',
  path: '/v1/blog/posts/:slug',
  surface: 'storefront',
  operationId: 'getBlogPostBySlug',
  summary: 'Get a journal post by slug',
  description:
    'The post with its ordered body blocks, the "keep reading" slugs and any SEO overrides. ' +
    'Unknown block types must be skipped by the renderer, never thrown on.',
  tags: ['Journal'],
  auth: 'public',
  request: { params: slugParam },
  responses: {
    200: { description: 'The post.', schema: blogPostDetail },
    404: { description: 'No published post has that slug.' },
  },
  handler: async ({ params }) => ok(await content.getBlogPostBySlug(params.slug)),
});

/* ---------------------------------------------------------- content pages */

defineRoute(contentRouter, {
  method: 'get',
  path: '/v1/pages',
  surface: 'storefront',
  operationId: 'listContentPages',
  summary: 'List content pages',
  description:
    'Occasion landing pages, policy pages, about and static pages — one table, discriminated ' +
    `by \`kind\`. Filter with \`kind=policy\` for the footer’s legal links. ${ENVELOPE_NOTE}`,
  tags: ['Pages'],
  auth: 'public',
  request: { query: contentPageListQuery },
  responses: {
    200: { description: 'A page of content pages.', schema: z.array(contentPageSummary) },
  },
  handler: async ({ query }) => {
    const { items, total } = await content.listContentPages(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(contentRouter, {
  method: 'get',
  path: '/v1/pages/:slug',
  surface: 'storefront',
  operationId: 'getContentPageBySlug',
  summary: 'Get a content page by slug',
  description:
    'Any published page, whatever its kind. For an occasion page, `collectionHandle` names ' +
    'the collection whose products belong on it — fetch them with `listCollectionProducts`.',
  tags: ['Pages'],
  auth: 'public',
  request: { params: slugParam },
  responses: {
    200: { description: 'The page.', schema: contentPageDetail },
    404: { description: 'No published page has that slug.' },
  },
  handler: async ({ params }) => ok(await content.getContentPageBySlug(params.slug)),
});

defineRoute(contentRouter, {
  method: 'get',
  path: '/v1/policies/:slug',
  surface: 'storefront',
  operationId: 'getPolicyBySlug',
  summary: 'Get a policy page by slug',
  description:
    'The published, linkable policy URLs: `shipping`, `returns`, `privacy`, `terms`, ' +
    '`cookies`. Identical shape to `getContentPageBySlug` but restricted to `kind=policy`, ' +
    'so an occasion page can never be served from a `/policies/…` URL.',
  tags: ['Pages'],
  auth: 'public',
  request: { params: slugParam },
  responses: {
    200: { description: 'The policy page.', schema: contentPageDetail },
    404: { description: 'No published policy page has that slug.' },
  },
  handler: async ({ params }) => ok(await content.getPolicyBySlug(params.slug)),
});

/* ------------------------------------------------------- FAQs & quotes */

defineRoute(contentRouter, {
  method: 'get',
  path: '/v1/faqs',
  surface: 'storefront',
  operationId: 'listFaqs',
  summary: 'List FAQs',
  description: `Published question-and-answer pairs, grouped by category and ordered for the accordion. ${ENVELOPE_NOTE}`,
  tags: ['FAQ'],
  auth: 'public',
  request: { query: faqListQuery },
  responses: {
    200: { description: 'A page of FAQs.', schema: z.array(faq) },
  },
  handler: async ({ query }) => {
    const { items, total } = await content.listFaqs(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(contentRouter, {
  method: 'get',
  path: '/v1/testimonials',
  surface: 'storefront',
  operationId: 'listTestimonials',
  summary: 'List testimonials',
  description:
    'Moderated marketing quotes. B2C quotes carry `authorCity`; B2B quotes carry `company` ' +
    'and `designation`. These are NOT product reviews — those live on the product. ' +
    ENVELOPE_NOTE,
  tags: ['Testimonials'],
  auth: 'public',
  request: { query: testimonialListQuery },
  responses: {
    200: { description: 'A page of testimonials.', schema: z.array(testimonial) },
  },
  handler: async ({ query }) => {
    const { items, total } = await content.listTestimonials(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

/* ---------------------------------------------------------- CMS & banners */

defineRoute(contentRouter, {
  method: 'get',
  path: '/v1/cms/sections',
  surface: 'storefront',
  operationId: 'listCmsSections',
  summary: 'List CMS sections with their items',
  description:
    'The homepage and landing-page section slots, in page order, each with its visible tiles ' +
    'already attached. Pass `pageKey=home` for the homepage. Tiles pointing at an unpublished ' +
    'collection or product are dropped rather than rendered as dead links. ' +
    ENVELOPE_NOTE,
  tags: ['CMS'],
  auth: 'public',
  request: { query: cmsSectionListQuery },
  responses: {
    200: { description: 'A page of sections.', schema: z.array(cmsSection) },
  },
  handler: async ({ query }) => {
    const { items, total } = await content.listCmsSections(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(contentRouter, {
  method: 'get',
  path: '/v1/banners',
  surface: 'storefront',
  operationId: 'listBanners',
  summary: 'List live banners',
  description:
    'Banners whose schedule window is open right now — the clock decides, not the status ' +
    'column, so a scheduled banner goes live without waiting for a job. Pass `device` to get ' +
    'creatives targeted at that device plus those targeted at all devices.',
  tags: ['CMS'],
  auth: 'public',
  request: { query: bannerListQuery },
  responses: {
    200: { description: 'A page of live banners.', schema: z.array(banner) },
  },
  handler: async ({ query }) => {
    const { items, total } = await content.listBanners(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

/* ------------------------------------------------------------ SEO & menus */

defineRoute(contentRouter, {
  method: 'get',
  path: '/v1/seo',
  surface: 'storefront',
  operationId: 'getSeoEntry',
  summary: 'Get the SEO record for an entity or a route',
  description:
    'Meta tags, canonical URL, robots directives and JSON-LD. Look up either an entity ' +
    '(`entityType` + `entityId`) or a bare route (`routePath`, e.g. `/`) — exactly one of the ' +
    'two. Product, collection, page and post detail responses already embed their own SEO ' +
    'block; this endpoint exists for routes that have no entity behind them.',
  tags: ['SEO'],
  auth: 'public',
  request: { query: seoQuery },
  responses: {
    200: { description: 'The SEO record.', schema: seoEntry },
    404: { description: 'Nothing has been authored for that entity or route.' },
  },
  handler: async ({ query }) => ok(await content.getSeo(query)),
});

defineRoute(contentRouter, {
  method: 'get',
  path: '/v1/menus/:key',
  surface: 'storefront',
  operationId: 'getMenuByKey',
  summary: 'Get a navigation menu',
  description:
    'A named menu (`header`, `footer`, `mobile`) with every visible item as a FLAT, ' +
    'depth-ordered array. Build the tree from `parentId`: megamenu depth is not fixed and a ' +
    'self-referencing response type is not expressible in a generated client. A hidden parent ' +
    'hides its whole branch, and items pointing at a dead collection are omitted.',
  tags: ['Navigation'],
  auth: 'public',
  request: { params: menuKeyParam },
  responses: {
    200: { description: 'The menu and its items.', schema: menu },
    404: { description: 'No menu has that key.' },
  },
  handler: async ({ params }) => ok(await content.getMenuByKey(params.key)),
});
