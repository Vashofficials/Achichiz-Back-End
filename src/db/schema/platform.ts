/**
 * platform.ts — §2.12
 *
 * Audit trail, notifications, third-party integrations, OUTBOUND webhooks and
 * their delivery log, bulk import jobs and the app settings key/value store.
 *
 * Two placement notes:
 *  - `api_keys` lives in identity.ts, next to staff_users and staff_sessions —
 *    it is a credential table and shares that file's revocation semantics. It
 *    is re-exported from the barrel, so importers see no difference.
 *  - `webhooks` / `webhook_deliveries` here are webhooks the platform SENDS.
 *    Inbound payment-gateway webhooks are `payment_events` in payments.ts.
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - activity_logs is append-only Tier 1 with a BIGINT identity PK; a random
 *    UUID PK would dirty a random leaf page on every insert. Partition by
 *    RANGE (occurred_at) once it exceeds ~50M rows.
 *  - The audit write path is a SERVICE-LAYER concern, deliberately not a
 *    universal AFTER UPDATE trigger: a generic trigger would log machine churn
 *    (last_active_at, stats refreshes) at enormous volume and without an actor.
 *  - TRIGGER trg_<table>_updated (set_updated_at) on integrations, webhooks
 *    and app_settings.
 */

import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  boolean,
  integer,
  smallint,
  inet,
  jsonb,
  index,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { staffUsers, apiKeys } from './identity.js';
import { customers } from './customers.js';
import { mediaAssets } from './content.js';

/* ---------------------------------------------------------- activity_logs */

export const ACTIVITY_ACTOR_KINDS = ['staff', 'customer', 'system', 'api_key'] as const;
export type ActivityActorKind = (typeof ACTIVITY_ACTOR_KINDS)[number];

/**
 * before_data / after_data are JSONB, not the mock's display strings
 * ('₹12,400' -> '₹11,900') which cannot be queried, diffed or replayed.
 */
export const activityLogs = pgTable(
  'activity_logs',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorKind: text('actor_kind').notNull().default('staff').$type<ActivityActorKind>(),
    actorStaffId: uuid('actor_staff_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    actorCustomerId: uuid('actor_customer_id').references(
      (): AnyPgColumn => customers.id,
      { onDelete: 'set null' },
    ),
    actorApiKeyId: uuid('actor_api_key_id').references((): AnyPgColumn => apiKeys.id, {
      onDelete: 'set null',
    }),
    actorLabel: text('actor_label').notNull(),
    actorRole: text('actor_role'),
    /** 'product.price_changed' */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    /** 'Cork Diary' — denormalised for the list screen. */
    entityLabel: text('entity_label'),
    beforeData: jsonb('before_data'),
    afterData: jsonb('after_data'),
    changedFields: text('changed_fields').array(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    /** Correlates with the API request and any webhook_deliveries it triggered. */
    requestId: text('request_id'),
  },
  (t) => [
    index('idx_activity_time').on(t.occurredAt.desc()),
    index('idx_activity_entity').on(t.entityType, t.entityId, t.occurredAt.desc()),
    index('idx_activity_actor').on(t.actorStaffId, t.occurredAt.desc()),
    index('idx_activity_action').on(t.action, t.occurredAt.desc()),
    check(
      'activity_logs_actor_kind_check',
      sql`actor_kind IN ('staff','customer','system','api_key')`,
    ),
  ],
);

/* ---------------------------------------------------------- notifications */

export const NOTIFICATION_AUDIENCES = ['staff', 'customer'] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

export const NOTIFICATION_KINDS = [
  'order',
  'inventory',
  'delivery',
  'corporate',
  'payment',
  'system',
  'marketing',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_PRIORITIES = ['high', 'normal', 'low'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    audience: text('audience').notNull().default('staff').$type<NotificationAudience>(),
    staffUserId: uuid('staff_user_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'cascade',
    }),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, {
      onDelete: 'cascade',
    }),
    kind: text('kind').notNull().$type<NotificationKind>(),
    priority: text('priority').notNull().default('normal').$type<NotificationPriority>(),
    title: text('title').notNull(),
    body: text('body'),
    linkUrl: text('link_url'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_notifications_staff')
      .on(t.staffUserId, t.createdAt.desc())
      .where(sql`read_at IS NULL`),
    index('idx_notifications_cust').on(t.customerId, t.createdAt.desc()),
    check('notifications_audience_check', sql`audience IN ('staff','customer')`),
    check(
      'notifications_kind_check',
      sql`kind IN ('order','inventory','delivery','corporate','payment','system','marketing')`,
    ),
    check('notifications_priority_check', sql`priority IN ('high','normal','low')`),
    check(
      'notification_target',
      sql`(audience = 'staff' AND customer_id IS NULL) OR (audience = 'customer' AND customer_id IS NOT NULL AND staff_user_id IS NULL)`,
    ),
  ],
);

/* ----------------------------------------------------------- integrations */

export const INTEGRATION_CATEGORIES = [
  'payments',
  'shipping',
  'messaging',
  'storage',
  'analytics',
  'accounting',
  'crm',
] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export const INTEGRATION_STATUSES = ['connected', 'not_connected', 'error'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: DOMAIN handle. 'razorpay' | 'wati' | 'cloudinary'. */
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    category: text('category').notNull().$type<IntegrationCategory>(),
    /** Non-secret settings only. */
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    /** Pointer into a secret manager, NOT the secret. */
    credentialsRef: text('credentials_ref'),
    status: text('status').notNull().default('not_connected').$type<IntegrationStatus>(),
    lastError: text('last_error'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    eventCount: bigint('event_count', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check(
      'integrations_category_check',
      sql`category IN ('payments','shipping','messaging','storage','analytics','accounting','crm')`,
    ),
    check(
      'integrations_status_check',
      sql`status IN ('connected','not_connected','error')`,
    ),
    check(
      'integration_error_has_message',
      sql`status <> 'error' OR last_error IS NOT NULL`,
    ),
  ],
);

/* --------------------------------------------------------------- webhooks */

export const WEBHOOK_STATUSES = ['healthy', 'failing', 'paused', 'disabled'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

/** Outbound. The secret is hashed at rest and shown once, at creation. */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    endpointUrl: text('endpoint_url').notNull(),
    description: text('description'),
    events: text('events').array().notNull(),
    /** HMAC signing secret, hashed. Never retrievable. */
    secretHash: text('secret_hash').notNull(),
    status: text('status').notNull().default('healthy').$type<WebhookStatus>(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_webhooks_events').using('gin', t.events),
    check('webhooks_events_check', sql`cardinality(events) > 0`),
    check(
      'webhooks_status_check',
      sql`status IN ('healthy','failing','paused','disabled')`,
    ),
  ],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references((): AnyPgColumn => webhooks.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    eventId: uuid('event_id').notNull(),
    payload: jsonb('payload').notNull(),
    attempt: smallint('attempt').notNull().default(1),
    responseStatus: smallint('response_status'),
    responseBody: text('response_body'),
    durationMs: integer('duration_ms'),
    succeeded: boolean('succeeded').notNull().default(false),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_webhook_deliveries').on(t.webhookId, t.createdAt.desc()),
    index('idx_webhook_retry')
      .on(t.nextRetryAt)
      .where(sql`NOT succeeded AND next_retry_at IS NOT NULL`),
    check('webhook_deliveries_attempt_check', sql`attempt > 0`),
  ],
);

/* ------------------------------------------------------------ import_jobs */

export const IMPORT_ENTITIES = [
  'products',
  'variants',
  'inventory',
  'customers',
  'campaign_recipients',
  'pincodes',
  'collections',
] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export const IMPORT_MODES = ['insert', 'upsert', 'update'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export const IMPORT_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const importJobs = pgTable(
  'import_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entity: text('entity').notNull().$type<ImportEntity>(),
    mode: text('mode').notNull().default('upsert').$type<ImportMode>(),
    sourceMediaId: uuid('source_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    filename: text('filename').notNull(),
    totalRows: integer('total_rows').notNull().default(0),
    succeededRows: integer('succeeded_rows').notNull().default(0),
    failedRows: integer('failed_rows').notNull().default(0),
    status: text('status').notNull().default('queued').$type<ImportStatus>(),
    errorReportMediaId: uuid('error_report_media_id').references(
      (): AnyPgColumn => mediaAssets.id,
      { onDelete: 'set null' },
    ),
    actorId: uuid('actor_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_import_jobs').on(t.status, t.createdAt.desc()),
    check(
      'import_jobs_entity_check',
      sql`entity IN ('products','variants','inventory','customers','campaign_recipients','pincodes','collections')`,
    ),
    check('import_jobs_mode_check', sql`mode IN ('insert','upsert','update')`),
    check(
      'import_jobs_status_check',
      sql`status IN ('queued','processing','completed','failed','cancelled')`,
    ),
    check('import_row_math', sql`succeeded_rows + failed_rows <= total_rows`),
  ],
);

export const importJobErrors = pgTable(
  'import_job_errors',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    importJobId: uuid('import_job_id')
      .notNull()
      .references((): AnyPgColumn => importJobs.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number').notNull(),
    columnName: text('column_name'),
    rawValue: text('raw_value'),
    message: text('message').notNull(),
  },
  (t) => [index('idx_import_errors').on(t.importJobId, t.rowNumber)],
);

/* ----------------------------------------------------------- app_settings */
/** The storefront's localStorage support settings belong here. */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  /** Exposed to the storefront? */
  isPublic: boolean('is_public').notNull().default(false),
  updatedBy: uuid('updated_by').references((): AnyPgColumn => staffUsers.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------- relations */

export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  actorStaff: one(staffUsers, {
    fields: [activityLogs.actorStaffId],
    references: [staffUsers.id],
  }),
  actorCustomer: one(customers, {
    fields: [activityLogs.actorCustomerId],
    references: [customers.id],
  }),
  actorApiKey: one(apiKeys, {
    fields: [activityLogs.actorApiKeyId],
    references: [apiKeys.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  staffUser: one(staffUsers, {
    fields: [notifications.staffUserId],
    references: [staffUsers.id],
  }),
  customer: one(customers, {
    fields: [notifications.customerId],
    references: [customers.id],
  }),
}));

export const webhooksRelations = relations(webhooks, ({ many }) => ({
  deliveries: many(webhookDeliveries),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  webhook: one(webhooks, {
    fields: [webhookDeliveries.webhookId],
    references: [webhooks.id],
  }),
}));

export const importJobsRelations = relations(importJobs, ({ one, many }) => ({
  sourceMedia: one(mediaAssets, {
    fields: [importJobs.sourceMediaId],
    references: [mediaAssets.id],
  }),
  errors: many(importJobErrors),
}));

export const importJobErrorsRelations = relations(importJobErrors, ({ one }) => ({
  job: one(importJobs, {
    fields: [importJobErrors.importJobId],
    references: [importJobs.id],
  }),
}));

/* ------------------------------------------------------------------ types */

export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
export type ImportJob = typeof importJobs.$inferSelect;
export type NewImportJob = typeof importJobs.$inferInsert;
export type ImportJobError = typeof importJobErrors.$inferSelect;
export type NewImportJobError = typeof importJobErrors.$inferInsert;
export type AppSetting = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;
