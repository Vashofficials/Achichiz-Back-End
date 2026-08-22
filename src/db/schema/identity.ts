/**
 * identity.ts — §2.1 (+ otp_challenges from §2.12)
 *
 * Staff authentication, RBAC, API keys and the shared OTP challenge table
 * (used by both staff and customer flows).
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - DOMAIN mobile_in — TEXT + '^[6-9][0-9]{9}$'
 *  - CITEXT           — staff_users.email is CITEXT in the database; Drizzle has
 *                       no CITEXT type, so it is declared text() here.
 *  - staff_users.avatar_initials is GENERATED ALWAYS AS ... STORED. It is
 *    declared with .generatedAlwaysAs() below so it is typed on select, but the
 *    SQL migration is authoritative for the expression.
 *  - TRIGGER trg_<table>_updated BEFORE UPDATE — set_updated_at() on every table
 *    with an updated_at column.
 *  - §7 correction 2: staff_users.email uses a PARTIAL unique index
 *    (WHERE deleted_at IS NULL), not an inline UNIQUE.
 */

import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  smallint,
  inet,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { warehouses } from './inventory.js';

/* ------------------------------------------------------------------ roles */

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'operations_manager' */
    key: text('key').notNull().unique(),
    /** 'Operations Manager' */
    name: text('name').notNull().unique(),
    description: text('description'),
    /** System roles cannot be deleted. */
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // No columns param: this check is raw SQL and does not reference the table map.
  () => [check('roles_key_check', sql`key ~ '^[a-z0-9_]+$'`)],
);

/* -------------------------------------------------------- role_permissions */

export const RBAC_MODULES = [
  'dashboard',
  'orders',
  'catalogue',
  'inventory',
  'customers',
  'corporate',
  'delivery',
  'promotions',
  'content',
  'reports',
  'settings',
  'finance',
] as const;
export type RbacModule = (typeof RBAC_MODULES)[number];

export const RBAC_ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'export',
  'approve',
  'refund',
  'cancel',
  'manage-settings',
] as const;
export type RbacAction = (typeof RBAC_ACTIONS)[number];

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references((): AnyPgColumn => roles.id, { onDelete: 'cascade' }),
    module: text('module').notNull().$type<RbacModule>(),
    action: text('action').notNull().$type<RbacAction>(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.module, t.action] }),
    index('idx_role_permissions_module').on(t.module, t.action),
    check(
      'role_permissions_module_check',
      sql`module IN ('dashboard','orders','catalogue','inventory','customers','corporate','delivery','promotions','content','reports','settings','finance')`,
    ),
    check(
      'role_permissions_action_check',
      sql`action IN ('view','create','edit','delete','export','approve','refund','cancel','manage-settings')`,
    ),
  ],
);

/* ------------------------------------------------------------ staff_users */

export const STAFF_STATUSES = ['active', 'invited', 'suspended'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

export const staffUsers = pgTable(
  'staff_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: CITEXT. Uniqueness is the partial index below (§7 correction 2). */
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    /** NULL while status='invited'. */
    passwordHash: text('password_hash'),
    roleId: uuid('role_id')
      .notNull()
      .references((): AnyPgColumn => roles.id, { onDelete: 'restrict' }),
    /** DB type: DOMAIN mobile_in. */
    phone: text('phone'),
    /** SQL-only semantics: GENERATED ALWAYS AS ... STORED; never written by the app. */
    avatarInitials: text('avatar_initials').generatedAlwaysAs(
      sql`upper(left(split_part(full_name,' ',1),1) || coalesce(left(nullif(split_part(full_name,' ',2),''),1),''))`,
    ),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaSecret: text('mfa_secret'),
    status: text('status').notNull().default('invited').$type<StaffStatus>(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    failedLoginCount: smallint('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_staff_email').on(t.email).where(sql`deleted_at IS NULL`),
    index('idx_staff_users_role').on(t.roleId).where(sql`deleted_at IS NULL`),
    index('idx_staff_users_status').on(t.status).where(sql`deleted_at IS NULL`),
    index('idx_staff_users_name_trgm').using('gin', sql`${t.fullName} gin_trgm_ops`),
    check('staff_users_status_check', sql`status IN ('active','invited','suspended')`),
    check(
      'staff_active_needs_password',
      sql`status <> 'active' OR password_hash IS NOT NULL`,
    ),
  ],
);

/* -------------------------------------------------- staff_user_warehouses */
/** Zero rows = access to all warehouses. */
export const staffUserWarehouses = pgTable(
  'staff_user_warehouses',
  {
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references((): AnyPgColumn => staffUsers.id, { onDelete: 'cascade' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references((): AnyPgColumn => warehouses.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.staffUserId, t.warehouseId] })],
);

/* --------------------------------------------------------- staff_sessions */

export const staffSessions = pgTable(
  'staff_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references((): AnyPgColumn => staffUsers.id, { onDelete: 'cascade' }),
    /** The hash, never the token. */
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    /** 'MacBook Pro · Chrome' */
    deviceLabel: text('device_label'),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    locationLabel: text('location_label'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_staff_sessions_user')
      .on(t.staffUserId, t.lastActiveAt.desc())
      .where(sql`revoked_at IS NULL`),
    index('idx_staff_sessions_expiry').on(t.expiresAt).where(sql`revoked_at IS NULL`),
    check('staff_session_window', sql`expires_at > issued_at`),
  ],
);

/* --------------------------------------------------------------- api_keys */

export const API_KEY_ENVIRONMENTS = ['live', 'test'] as const;
export type ApiKeyEnvironment = (typeof API_KEY_ENVIRONMENTS)[number];

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    /** 'ach_live_7f3a' — shown in the UI. */
    keyPrefix: text('key_prefix').notNull().unique(),
    /** argon2/bcrypt of the full key. The key itself is never stored. */
    keyHash: text('key_hash').notNull(),
    environment: text('environment').notNull().default('live').$type<ApiKeyEnvironment>(),
    /** {'orders:read','products:write'} */
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_api_keys_active').on(t.keyPrefix).where(sql`revoked_at IS NULL`),
    check('api_keys_environment_check', sql`environment IN ('live','test')`),
  ],
);

/* --------------------------------------------------------- otp_challenges */

export const OTP_CHANNELS = ['sms', 'email', 'whatsapp'] as const;
export type OtpChannel = (typeof OTP_CHANNELS)[number];

export const OTP_PURPOSES = [
  'login',
  'signup',
  'verify',
  'password_reset',
  'order_track',
] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull().$type<OtpChannel>(),
    destination: text('destination').notNull(),
    codeHash: text('code_hash').notNull(),
    purpose: text('purpose').notNull().$type<OtpPurpose>(),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(5),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_otp_dest')
      .on(t.destination, t.purpose, t.createdAt.desc())
      .where(sql`consumed_at IS NULL`),
    check('otp_challenges_channel_check', sql`channel IN ('sms','email','whatsapp')`),
    check(
      'otp_challenges_purpose_check',
      sql`purpose IN ('login','signup','verify','password_reset','order_track')`,
    ),
    check('otp_challenges_attempts_check', sql`attempts >= 0`),
  ],
);

/* -------------------------------------------------------------- relations */

export const rolesRelations = relations(roles, ({ many }) => ({
  permissions: many(rolePermissions),
  staffUsers: many(staffUsers),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
}));

export const staffUsersRelations = relations(staffUsers, ({ one, many }) => ({
  role: one(roles, { fields: [staffUsers.roleId], references: [roles.id] }),
  sessions: many(staffSessions),
  warehouses: many(staffUserWarehouses),
}));

export const staffSessionsRelations = relations(staffSessions, ({ one }) => ({
  staffUser: one(staffUsers, {
    fields: [staffSessions.staffUserId],
    references: [staffUsers.id],
  }),
}));

/* ------------------------------------------------------------------ types */

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;
export type StaffUser = typeof staffUsers.$inferSelect;
export type NewStaffUser = typeof staffUsers.$inferInsert;
export type StaffUserWarehouse = typeof staffUserWarehouses.$inferSelect;
export type NewStaffUserWarehouse = typeof staffUserWarehouses.$inferInsert;
export type StaffSession = typeof staffSessions.$inferSelect;
export type NewStaffSession = typeof staffSessions.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type OtpChallenge = typeof otpChallenges.$inferSelect;
export type NewOtpChallenge = typeof otpChallenges.$inferInsert;
