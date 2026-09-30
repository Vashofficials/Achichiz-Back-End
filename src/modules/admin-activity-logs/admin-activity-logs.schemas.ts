import { z } from 'zod';

export const adminActivityLogItem = z.object({
  id: z.string(),
  occurredAt: z.string(),
  actorKind: z.string(),
  actorStaffId: z.string().uuid().nullable(),
  actorLabel: z.string(),
  actorRole: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().uuid().nullable(),
  entityLabel: z.string().nullable(),
  beforeData: z.record(z.string(), z.unknown()).nullable(),
  afterData: z.record(z.string(), z.unknown()).nullable(),
  changedFields: z.array(z.string()).nullable(),
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
});

export const listActivityLogsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
  entityType: z.string().optional(),
  action: z.string().optional(),
  actorStaffId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().optional(),
});
