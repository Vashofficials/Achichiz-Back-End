import { z } from 'zod';
import { NOTIFICATION_KINDS, NOTIFICATION_PRIORITIES } from '../../db/schema/index.js';

export const adminNotification = z.object({
  id: z.string().uuid(),
  kind: z.enum(NOTIFICATION_KINDS),
  priority: z.enum(NOTIFICATION_PRIORITIES),
  title: z.string(),
  body: z.string().nullable(),
  linkUrl: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().uuid().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

export const listAdminNotificationsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
  kind: z.enum(NOTIFICATION_KINDS).optional(),
  priority: z.enum(NOTIFICATION_PRIORITIES).optional(),
  unreadOnly: z.coerce.boolean().optional(),
});

export const markReadParams = z.object({
  id: z.string().uuid(),
});
