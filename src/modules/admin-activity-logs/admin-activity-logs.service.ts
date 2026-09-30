import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { activityLogs } from '../../db/schema/index.js';

export async function listActivityLogs(query: {
  page: number;
  perPage: number;
  entityType?: string;
  action?: string;
  actorStaffId?: string;
  from?: string;
  to?: string;
  q?: string;
}) {
  const { page, perPage, entityType, action, actorStaffId, from, to, q } = query;

  const conditions = [];

  if (entityType) conditions.push(eq(activityLogs.entityType, entityType));
  if (action) conditions.push(eq(activityLogs.action, action));
  if (actorStaffId) conditions.push(eq(activityLogs.actorStaffId, actorStaffId));
  if (from) conditions.push(gte(activityLogs.occurredAt, new Date(from)));
  if (to) conditions.push(lte(activityLogs.occurredAt, new Date(to)));
  if (q) {
    conditions.push(
      or(
        ilike(activityLogs.action, `%${q}%`),
        ilike(activityLogs.entityType, `%${q}%`),
        ilike(activityLogs.actorLabel, `%${q}%`),
      )!,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (page - 1) * perPage;

  const [rows, countRes] = await Promise.all([
    db
      .select({
        id: activityLogs.id,
        occurredAt: activityLogs.occurredAt,
        actorKind: activityLogs.actorKind,
        actorStaffId: activityLogs.actorStaffId,
        actorLabel: activityLogs.actorLabel,
        actorRole: activityLogs.actorRole,
        action: activityLogs.action,
        entityType: activityLogs.entityType,
        entityId: activityLogs.entityId,
        entityLabel: activityLogs.entityLabel,
        beforeData: activityLogs.beforeData,
        afterData: activityLogs.afterData,
        changedFields: activityLogs.changedFields,
        ip: activityLogs.ip,
        requestId: activityLogs.requestId,
      })
      .from(activityLogs)
      .where(where)
      .orderBy(desc(activityLogs.occurredAt))
      .limit(perPage)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(activityLogs)
      .where(where),
  ]);

  const total = countRes[0]?.count ?? 0;

  return {
    items: rows.map((r) => ({
      ...r,
      id: String(r.id),
      occurredAt: r.occurredAt.toISOString(),
      beforeData: (r.beforeData ?? null) as Record<string, unknown> | null,
      afterData: (r.afterData ?? null) as Record<string, unknown> | null,
    })),
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
}
