import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';
import { STAFF_STATUSES } from '../../db/schema/identity.js';

/**
 * Staff & team management contracts.
 *
 * `staff_users` already existed — admin-auth reads it to sign people in. This
 * module is the write side the `/settings/team` screen needs, and nothing here
 * introduces a new table.
 */

export const staffIdParam = z.object({
  id: z.uuid().describe('Staff user id from `GET /v1/admin/staff`.'),
});

export const staffStatus = z
  .enum(STAFF_STATUSES)
  .describe(
    '`invited` until a password is set, `active` once it is, `suspended` when access is withdrawn. ' +
      'Deleted accounts are not returned at all.',
  );

/**
 * Warehouse scope is a list of warehouse IDS, not labels.
 *
 * An EMPTY array means every warehouse, which is the `staff_user_warehouses`
 * convention (zero rows = unrestricted) carried through unchanged. It is
 * therefore impossible to express "no warehouses at all"; withdraw access by
 * changing the role or suspending the account instead.
 */
export const warehouseScope = z
  .array(z.uuid())
  .describe('Warehouse ids this member is restricted to. EMPTY = all warehouses.');

export const staffAccount = z.object({
  id: z.uuid().describe('Staff user id.'),
  fullName: z.string().describe('Display name.'),
  email: z.string().describe('Work email. Unique among non-deleted accounts, compared case-insensitively.'),
  roleId: z.uuid().describe('Assigned role id.'),
  roleKey: z.string().describe('Stable role key, e.g. `operations_manager`.'),
  roleName: z.string().describe('Role display name.'),
  warehouseScope,
  mfaEnabled: z.boolean().describe('Whether the member has completed TOTP enrolment.'),
  status: staffStatus,
  lastActiveAt: z.iso.datetime().nullable().describe('Last authenticated request, or null.'),
  createdAt: z.iso.datetime().describe('When the account was created.'),
  updatedAt: z.iso.datetime().describe('Last modification.'),
});

export const staffListQuery = listQuery.extend({
  status: staffStatus.optional().describe('Filter by lifecycle status.'),
  roleId: z.uuid().optional().describe('Filter by assigned role.'),
});

export const inviteStaffBody = z.object({
  fullName: z.string().trim().min(1).max(120).describe('Display name.'),
  email: z.string().trim().toLowerCase().pipe(z.email()).describe('Work email. Must not already be in use.'),
  roleId: z.uuid().describe('Role to assign. Must exist.'),
  warehouseScope: warehouseScope.optional().describe('Omit for access to all warehouses.'),
});

/**
 * Every field optional — this is a PATCH.
 *
 * `status` accepts only `active`/`suspended`: moving an account back to
 * `invited` by hand would orphan it, and `active` is refused unless a password
 * has actually been set (the `staff_active_needs_password` CHECK).
 */
export const updateStaffBody = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
    roleId: z.uuid().optional(),
    warehouseScope: warehouseScope.optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to change.' });

export const deactivateBody = z.object({
  reason: z.string().trim().max(500).optional().describe('Recorded in the log, not shown to the member.'),
});

export const staffLifecycleResult = z.object({
  id: z.uuid(),
  status: staffStatus,
  revokedSessions: z.number().int().describe('Sessions terminated by this call.'),
});

export const revokeResult = z.object({
  revokedSessions: z.number().int().describe('Live sessions terminated.'),
});

export const acknowledgedResult = z.object({
  sent: z.boolean().describe('Always true — a mail failure is logged, never reported, so this is not a probe.'),
});

export const deleteResult = z.object({
  id: z.uuid(),
  deleted: z.literal(true),
  revokedSessions: z.number().int(),
});

export type StaffAccount = z.infer<typeof staffAccount>;
export type StaffListQuery = z.infer<typeof staffListQuery>;
export type InviteStaffInput = z.infer<typeof inviteStaffBody>;
export type UpdateStaffInput = z.infer<typeof updateStaffBody>;
