import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated } from '../../lib/http.js';
import * as service from './admin-notifications.service.js';
import {
  adminNotification,
  listAdminNotificationsQuery,
  markReadParams,
} from './admin-notifications.schemas.js';

export const adminNotificationsRouter: Router = Router();

defineRoute(adminNotificationsRouter, {
  method: 'get',
  path: '/v1/admin/notifications',
  surface: 'admin',
  operationId: 'listAdminNotifications',
  summary: 'List operational notifications',
  description:
    'Returns staff operational notifications across orders, inventory, delivery, corporate and payments.',
  tags: ['Admin Notifications'],
  auth: 'staff',
  permission: { module: 'dashboard', action: 'view' },
  request: { query: listAdminNotificationsQuery },
  responses: {
    200: { description: 'Paginated notifications.', schema: z.array(adminNotification) },
  },
  handler: async ({ query, auth }) => {
    const { items, meta } = await service.listNotifications(query, auth);
    return paginated(items, meta);
  },
});

defineRoute(adminNotificationsRouter, {
  method: 'patch',
  path: '/v1/admin/notifications/:id/read',
  surface: 'admin',
  operationId: 'markAdminNotificationRead',
  summary: 'Mark notification as read',
  tags: ['Admin Notifications'],
  auth: 'staff',
  permission: { module: 'dashboard', action: 'view' },
  request: { params: markReadParams },
  responses: {
    200: {
      description: 'Notification marked as read.',
      schema: z.object({
        id: z.string().uuid(),
        read: z.boolean(),
        readAt: z.string().nullable(),
      }),
    },
  },
  handler: async ({ params, auth }) => ok(await service.markAsRead(params.id, auth)),
});

defineRoute(adminNotificationsRouter, {
  method: 'post',
  path: '/v1/admin/notifications/mark-all-read',
  surface: 'admin',
  operationId: 'markAllAdminNotificationsRead',
  summary: 'Mark all notifications as read',
  tags: ['Admin Notifications'],
  auth: 'staff',
  permission: { module: 'dashboard', action: 'view' },
  responses: {
    200: {
      description: 'All notifications marked as read.',
      schema: z.object({
        updated: z.number().int(),
      }),
    },
  },
  handler: async ({ auth }) => ok(await service.markAllAsRead(auth)),
});
