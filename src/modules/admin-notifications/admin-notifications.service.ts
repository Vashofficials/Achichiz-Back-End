import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { notifications } from '../../db/schema/index.js';
import type { NotificationKind, NotificationPriority } from '../../db/schema/index.js';
import type { StaffAuth } from '../../lib/openapi/define-route.js';
import { NotFoundError } from '../../lib/errors.js';

export async function listNotifications(
  query: {
    page: number;
    perPage: number;
    kind?: NotificationKind;
    priority?: NotificationPriority;
    unreadOnly?: boolean;
  },
  auth: StaffAuth,
) {
  const { page, perPage, kind, priority, unreadOnly } = query;
  const conditions = [
    eq(notifications.audience, 'staff'),
    or(isNull(notifications.staffUserId), eq(notifications.staffUserId, auth.staffId)),
  ];

  if (kind) conditions.push(eq(notifications.kind, kind));
  if (priority) conditions.push(eq(notifications.priority, priority));
  if (unreadOnly) conditions.push(isNull(notifications.readAt));

  const where = and(...conditions);
  const offset = (page - 1) * perPage;

  const [rows, countRes] = await Promise.all([
    db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        priority: notifications.priority,
        title: notifications.title,
        body: notifications.body,
        linkUrl: notifications.linkUrl,
        entityType: notifications.entityType,
        entityId: notifications.entityId,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(perPage)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(where),
  ]);

  const total = countRes[0]?.count ?? 0;

  return {
    items: rows.map((r) => ({
      ...r,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    meta: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
}

export async function markAsRead(id: string, auth: StaffAuth) {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.audience, 'staff'),
        or(isNull(notifications.staffUserId), eq(notifications.staffUserId, auth.staffId)),
      ),
    )
    .returning();

  if (rows.length === 0) {
    throw new NotFoundError('Notification not found');
  }

  const row = rows[0]!;
  return {
    id: row.id,
    read: true,
    readAt: row.readAt ? row.readAt.toISOString() : null,
  };
}

export async function markAllAsRead(auth: StaffAuth) {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.audience, 'staff'),
        isNull(notifications.readAt),
        or(isNull(notifications.staffUserId), eq(notifications.staffUserId, auth.staffId)),
      ),
    )
    .returning({ id: notifications.id });

  return { updated: rows.length };
}

export async function createStaffNotification(payload: {
  kind: NotificationKind;
  priority?: NotificationPriority;
  title: string;
  body?: string;
  linkUrl?: string;
  entityType?: string;
  entityId?: string;
  staffUserId?: string;
}) {
  const rows = await db
    .insert(notifications)
    .values({
      audience: 'staff',
      kind: payload.kind,
      priority: payload.priority ?? 'normal',
      title: payload.title,
      body: payload.body ?? null,
      linkUrl: payload.linkUrl ?? null,
      entityType: payload.entityType ?? null,
      entityId: payload.entityId ?? null,
      staffUserId: payload.staffUserId ?? null,
    })
    .returning();
  return rows[0];
}
