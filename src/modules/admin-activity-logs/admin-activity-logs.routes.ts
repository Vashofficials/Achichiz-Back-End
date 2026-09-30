import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { paginated } from '../../lib/http.js';
import * as service from './admin-activity-logs.service.js';
import {
  adminActivityLogItem,
  listActivityLogsQuery,
} from './admin-activity-logs.schemas.js';

export const adminActivityLogsRouter: Router = Router();

defineRoute(adminActivityLogsRouter, {
  method: 'get',
  path: '/v1/admin/activity-logs',
  surface: 'admin',
  operationId: 'listAdminActivityLogs',
  summary: 'List admin activity and audit logs',
  description:
    'Returns staff mutations and operations with before/after state diffs, timestamps, and actor info.',
  tags: ['Admin Settings'],
  auth: 'staff',
  permission: { module: 'settings', action: 'view' },
  request: { query: listActivityLogsQuery },
  responses: {
    200: { description: 'Paginated activity logs.', schema: z.array(adminActivityLogItem) },
  },
  handler: async ({ query }) => {
    const { items, meta } = await service.listActivityLogs(query);
    return paginated(items, meta);
  },
});
