import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated, pageMeta } from '../../lib/http.js';
import { listQuery } from '../../lib/pagination.js';
import * as catalogue from './catalogue.service.js';
import {
  addOn,
  addOnListQuery,
  collectionDetail,
  collectionListQuery,
  collectionSummary,
  designerListQuery,
  designerSummary,
  hamperComponents,
  hamperTemplateSummary,
  handleParam,
  personalisationTemplate,
  personalisationTemplateListQuery,
  productDetail,
  productListQuery,
  productSummary,
  productVariant,
  serviceability,
  serviceabilityQuery,
} from './catalogue.schemas.js';

/**
 * Storefront catalogue. Everything here is public, cacheable and read-only.
 *
 * Only published, non-deleted rows are ever returned — that filter lives in the
 * repository so no route can forget it.
 */
export const catalogueRouter: Router = Router();

const ENVELOPE_NOTE =
  'Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.';

/* -------------------------------------------------------------- products */

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/products',
  surface: 'storefront',
  operationId: 'listProducts',
  summary: 'List and filter products',
  description:
    'The product grid behind `/collections/:handle` and every merchandising rail. ' +
    '`price`, `stock`, `sameDay`, `bestSeller` and `isNew` are derived at read time from ' +
    'variants, inventory and collection membership — none of them is a stored column. ' +
    ENVELOPE_NOTE,
  tags: ['Products'],
  auth: 'public',
  request: { query: productListQuery },
  responses: {
    200: { description: 'A page of products.', schema: z.array(productSummary) },
  },
  handler: async ({ query }) => {
    const { items, total } = await catalogue.listProducts(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/products/:handle',
  surface: 'storefront',
  operationId: 'getProductByHandle',
  summary: 'Get a product by handle',
  description:
    'Everything the PDP renders in one call: gallery, contents, variants with per-variant ' +
    'stock, add-ons (falling back to the global set when none are pinned), personalisation ' +
    'templates, related handles and SEO overrides.',
  tags: ['Products'],
  auth: 'public',
  request: { params: handleParam },
  responses: {
    200: { description: 'The product.', schema: productDetail },
    404: { description: 'No published product has that handle.' },
  },
  handler: async ({ params }) => ok(await catalogue.getProductByHandle(params.handle)),
});

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/products/:handle/variants',
  surface: 'storefront',
  operationId: 'listProductVariants',
  summary: 'List a product’s variants',
  description:
    'The stock-bearing units. Cart lines reference a variant id, never a product id. ' +
    'Already included in `getProductByHandle` — use this when only availability changed.',
  tags: ['Products'],
  auth: 'public',
  request: { params: handleParam },
  responses: {
    200: { description: 'Active variants in display order.', schema: z.array(productVariant) },
    404: { description: 'No published product has that handle.' },
  },
  handler: async ({ params }) => ok(await catalogue.listProductVariants(params.handle)),
});

/* ----------------------------------------------------------- collections */

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/collections',
  surface: 'storefront',
  operationId: 'listCollections',
  summary: 'List collections',
  description:
    'One table serves all six taxonomy kinds (category, recipient, occasion, festival, ' +
    'designer, edit) — filter with `kind`. `productCount` counts live products only. ' +
    'Scheduled collections appear once their window opens. ' +
    ENVELOPE_NOTE,
  tags: ['Collections'],
  auth: 'public',
  request: { query: collectionListQuery },
  responses: {
    200: { description: 'A page of collections.', schema: z.array(collectionSummary) },
  },
  handler: async ({ query }) => {
    const { items, total } = await catalogue.listCollections(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/collections/:handle',
  surface: 'storefront',
  operationId: 'getCollectionByHandle',
  summary: 'Get a collection with its facets',
  description:
    'The collection plus the two things the listing page cannot compute for itself: the ' +
    'category facets actually present in it (with counts) and the real price-slider bounds. ' +
    'Fetch the products themselves from `listCollectionProducts`.',
  tags: ['Collections'],
  auth: 'public',
  request: { params: handleParam },
  responses: {
    200: { description: 'The collection, its facets and price bounds.', schema: collectionDetail },
    404: { description: 'No live collection has that handle.' },
  },
  handler: async ({ params }) => ok(await catalogue.getCollectionByHandle(params.handle)),
});

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/collections/:handle/products',
  surface: 'storefront',
  operationId: 'listCollectionProducts',
  summary: 'List products in a collection',
  description:
    'Identical filtering and sorting to `listProducts`, scoped to one collection. The path ' +
    'segment wins: a `collection` query parameter cannot widen the result set. ' +
    ENVELOPE_NOTE,
  tags: ['Collections'],
  auth: 'public',
  request: { params: handleParam, query: productListQuery },
  responses: {
    200: { description: 'A page of products in the collection.', schema: z.array(productSummary) },
    404: { description: 'No live collection has that handle.' },
  },
  handler: async ({ params, query }) => {
    const { items, total } = await catalogue.listCollectionProducts(params.handle, query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

/* ------------------------------------------------------------- designers */

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/designers',
  surface: 'storefront',
  operationId: 'listDesigners',
  summary: 'List designers and brands',
  description: `Makers attributed on the PDP: designers, brands, celebrities and artisan clusters. ${ENVELOPE_NOTE}`,
  tags: ['Designers'],
  auth: 'public',
  request: { query: designerListQuery },
  responses: {
    200: { description: 'A page of designers.', schema: z.array(designerSummary) },
  },
  handler: async ({ query }) => {
    const { items, total } = await catalogue.listDesigners(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/designers/:handle',
  surface: 'storefront',
  operationId: 'getDesignerByHandle',
  summary: 'Get a designer by handle',
  description: 'Backs the designer landing page. Fetch their products with `listProducts?designer=…`.',
  tags: ['Designers'],
  auth: 'public',
  request: { params: handleParam },
  responses: {
    200: { description: 'The designer.', schema: designerSummary },
    404: { description: 'No active designer has that handle.' },
  },
  handler: async ({ params }) => ok(await catalogue.getDesignerByHandle(params.handle)),
});

/* -------------------------------------------------- add-ons & templates */

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/add-ons',
  surface: 'storefront',
  operationId: 'listAddOns',
  summary: 'List add-ons',
  description:
    'Gift wrap, cards, engraving and the rest. Pass `product` to get exactly what that ' +
    'product offers with its per-product price override already applied; omit it for the ' +
    'global catalogue. `pricePaise` is always the price to charge — never re-derive it. ' +
    ENVELOPE_NOTE,
  tags: ['Add-ons'],
  auth: 'public',
  request: { query: addOnListQuery },
  responses: {
    200: { description: 'A page of add-ons.', schema: z.array(addOn) },
    404: { description: '`product` was supplied and no published product has that handle.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await catalogue.listAddOns(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/personalisation-templates',
  surface: 'storefront',
  operationId: 'listPersonalisationTemplates',
  summary: 'List personalisation templates',
  description:
    'Engraving, embroidery, print, digital and laser methods with their turnaround, ' +
    'character cap and proof policy. `charLimit` is enforced server-side at cart and order ' +
    'time — the HTML `maxlength` is not the rule. ' +
    ENVELOPE_NOTE,
  tags: ['Add-ons'],
  auth: 'public',
  request: { query: personalisationTemplateListQuery },
  responses: {
    200: { description: 'A page of templates.', schema: z.array(personalisationTemplate) },
    404: { description: '`product` was supplied and no published product has that handle.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await catalogue.listPersonalisationTemplates(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

/* -------------------------------------------------------- hamper builder */

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/hamper-builder/templates',
  surface: 'storefront',
  operationId: 'listHamperBuilderTemplates',
  summary: 'List build-your-own-hamper templates',
  description: `Live builder templates. Fetch one by handle for the wizard itself. ${ENVELOPE_NOTE}`,
  tags: ['Hamper builder'],
  auth: 'public',
  request: { query: listQuery },
  responses: {
    200: { description: 'A page of builder templates.', schema: z.array(hamperTemplateSummary) },
  },
  handler: async ({ query }) => {
    const { items, total } = await catalogue.listHamperTemplates(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/hamper-builder/templates/:handle',
  surface: 'storefront',
  operationId: 'getHamperBuilderTemplate',
  summary: 'Get a hamper builder template with its steps and options',
  description:
    'The whole wizard in one call. Per-step `minChoices`/`maxChoices` are the real ' +
    'constraints and are re-enforced when the hamper is added to a cart. An option is ' +
    '`stock: "out"` when it is switched off or its component has no available units — that ' +
    'is computed live, never hardcoded.',
  tags: ['Hamper builder'],
  auth: 'public',
  request: { params: handleParam },
  responses: {
    200: { description: 'The template, its steps and their options.', schema: hamperComponents },
    404: { description: 'No live builder template has that handle.' },
  },
  handler: async ({ params }) => ok(await catalogue.getHamperTemplate(params.handle)),
});

/* -------------------------------------------------------- serviceability */

defineRoute(catalogueRouter, {
  method: 'get',
  path: '/v1/serviceability',
  surface: 'storefront',
  operationId: 'checkServiceability',
  summary: 'Check delivery serviceability for a PIN code',
  description:
    'Real coverage, not an optimistic guess: an unknown PIN code and a suspended one both ' +
    'return `serviceable: false`. `sameDayEligible` additionally requires the zone’s cutoff ' +
    'not to have passed in Asia/Kolkata. `codEligible` requires both the zone and the PIN ' +
    'code to allow cash on delivery.',
  tags: ['Delivery'],
  auth: 'public',
  request: { query: serviceabilityQuery },
  responses: {
    200: {
      description: 'The serviceability answer. Always 200, including for unserviceable PIN codes.',
      schema: serviceability,
    },
  },
  handler: async ({ query }) => ok(await catalogue.checkServiceability(query.pincode)),
});
