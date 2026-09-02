import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok, paginated, pageMeta, noContent } from '../../lib/http.js';
import * as builder from './admin-builder.service.js';
import {
  builderTemplateDetail,
  builderTemplateListQuery,
  createBuilderTemplateBody,
  updateBuilderTemplateBody,
} from './admin-builder.schemas.js';

export const adminBuilderRouter: Router = Router();

const TAG = 'Admin BYOH templates';

defineRoute(adminBuilderRouter, {
  method: 'get',
  path: '/v1/admin/hamper-builder/templates',
  surface: 'admin',
  operationId: 'adminListHamperBuilderTemplates',
  summary: 'List BYOH templates',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'view' },
  request: { query: builderTemplateListQuery },
  responses: {
    200: { description: 'A page of builder templates.', schema: z.array(builderTemplateDetail.omit({ steps: true })) },
  },
  handler: async ({ query }) => {
    const { items, total } = await builder.listBuilderTemplates(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminBuilderRouter, {
  method: 'get',
  path: '/v1/admin/hamper-builder/templates/:id',
  surface: 'admin',
  operationId: 'adminGetHamperBuilderTemplate',
  summary: 'Get BYOH template with nested steps',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'view' },
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'The template and its steps.', schema: builderTemplateDetail },
    404: { description: 'Template not found.' },
  },
  handler: async ({ params }) => ok(await builder.getBuilderTemplate(params.id)),
});

defineRoute(adminBuilderRouter, {
  method: 'post',
  path: '/v1/admin/hamper-builder/templates',
  surface: 'admin',
  operationId: 'adminCreateHamperBuilderTemplate',
  summary: 'Create BYOH template',
  description: 'Requires an `Idempotency-Key` header to safely retry timeouts.',
  tags: [TAG],
  auth: 'staff',
  idempotent: true,
  permission: { module: 'catalogue', action: 'edit' },
  request: { body: createBuilderTemplateBody },
  responses: {
    201: { description: 'The created template.', schema: builderTemplateDetail },
  },
  handler: async ({ body }) => created(await builder.createBuilderTemplate(body)),
});

defineRoute(adminBuilderRouter, {
  method: 'patch',
  path: '/v1/admin/hamper-builder/templates/:id',
  surface: 'admin',
  operationId: 'adminUpdateHamperBuilderTemplate',
  summary: 'Update BYOH template',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'edit' },
  request: { params: z.object({ id: z.string().uuid() }), body: updateBuilderTemplateBody },
  responses: {
    200: { description: 'The updated template.', schema: builderTemplateDetail },
    404: { description: 'Template not found.' },
  },
  handler: async ({ params, body }) => ok(await builder.updateBuilderTemplate(params.id, body)),
});

defineRoute(adminBuilderRouter, {
  method: 'delete',
  path: '/v1/admin/hamper-builder/templates/:id',
  surface: 'admin',
  operationId: 'adminDeleteHamperBuilderTemplate',
  summary: 'Delete BYOH template',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'delete' },
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    204: { description: 'Template deleted.' },
    404: { description: 'Template not found.' },
  },
  handler: async ({ params }) => {
    await builder.deleteBuilderTemplate(params.id);
    return noContent();
  },
});
