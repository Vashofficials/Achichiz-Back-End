import { Router } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok, paginated, pageMeta } from '../../lib/http.js';
import * as staff from './admin-staff.service.js';
import {
  acknowledgedResult,
  deactivateBody,
  deleteResult,
  inviteStaffBody,
  revokeResult,
  staffAccount,
  staffIdParam,
  staffLifecycleResult,
  staffListQuery,
  updateStaffBody,
} from './admin-staff.schemas.js';

/**
 * Staff & team management — the write side of `/settings/team`.
 *
 * Reads are gated on `settings:view`; everything that changes an account
 * requires `settings:manage-settings`, which in the shipped matrix only
 * `super_admin` holds. That asymmetry is deliberate: seeing who has access is a
 * normal operational need, granting it is not.
 *
 * The lifecycle transitions are separate endpoints rather than a PATCH on
 * `status` because each has side effects a generic field write would hide —
 * deactivation terminates live sessions, reactivation is refused for an account
 * that never set a password.
 */
export const adminStaffRouter: Router = Router();

const TAG = 'Admin staff';

/* --------------------------------------------------------------- the reads */

defineRoute(adminStaffRouter, {
  method: 'get',
  path: '/v1/admin/staff',
  surface: 'admin',
  operationId: 'adminListStaff',
  summary: 'List staff accounts',
  description:
    'Every staff account except deleted ones, with role, MFA state and warehouse scope. ' +
    'Filter by `status` or `roleId`; `q` matches name or email.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'view' },
  request: { query: staffListQuery },
  responses: { 200: { description: 'A page of staff accounts.', schema: staffAccount.array() } },
  handler: async ({ query }) => {
    const { rows, total } = await staff.listStaff(query);
    return paginated(rows, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminStaffRouter, {
  method: 'get',
  path: '/v1/admin/staff/:id',
  surface: 'admin',
  operationId: 'adminGetStaff',
  summary: 'Get one staff account',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'view' },
  request: { params: staffIdParam },
  responses: {
    200: { description: 'The staff account.', schema: staffAccount },
    404: { description: 'No such staff account.' },
  },
  handler: async ({ params }) => ok(await staff.getStaff(params.id)),
});

/* -------------------------------------------------------------- the writes */

defineRoute(adminStaffRouter, {
  method: 'post',
  path: '/v1/admin/staff',
  surface: 'admin',
  operationId: 'adminInviteStaff',
  summary: 'Invite a staff member',
  description:
    'Creates the account as `invited` with no password and emails a one-time token valid for seven days. ' +
    'The account cannot sign in until that token is used. A mail failure does NOT roll back the account — ' +
    'use the password-reset endpoint to send another.\n\n' +
    'REQUIRES an `Idempotency-Key` header (a UUID, reused on retry). It is the only endpoint in this module ' +
    'that does: a repeated invite creates a second account and sends a second setup token, whereas the ' +
    'lifecycle transitions below are all safe to repeat.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { body: inviteStaffBody },
  idempotent: true,
  responses: {
    201: { description: 'The new account.', schema: staffAccount },
    409: { description: 'That email is already in use.' },
    422: { description: 'Unknown role.' },
  },
  handler: async ({ body }) => created(await staff.inviteStaff(body)),
});

defineRoute(adminStaffRouter, {
  method: 'patch',
  path: '/v1/admin/staff/:id',
  surface: 'admin',
  operationId: 'adminUpdateStaff',
  summary: 'Update a staff member',
  description:
    'Change name, email, role or warehouse scope. Reassigning a role or suspending the account terminates ' +
    'its live sessions, because the old JWT still carries the old grants. Setting `status: active` is refused ' +
    'for an account that has never set a password.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { params: staffIdParam, body: updateStaffBody },
  responses: {
    200: { description: 'The updated account.', schema: staffAccount },
    404: { description: 'No such staff account.' },
    409: { description: 'That email belongs to another account.' },
    422: { description: 'Unknown role, no password set, or the last super admin.' },
  },
  handler: async ({ params, body }) => ok(await staff.updateStaff(params.id, body)),
});

defineRoute(adminStaffRouter, {
  method: 'post',
  path: '/v1/admin/staff/:id/deactivate',
  surface: 'admin',
  operationId: 'adminDeactivateStaff',
  summary: 'Suspend a staff member',
  description:
    'Sets `suspended` and terminates every live session immediately, in both the session table and the ' +
    'token revocation set. Refused for your own account and for the last active super admin.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { params: staffIdParam, body: deactivateBody },
  responses: {
    200: { description: 'Suspended.', schema: staffLifecycleResult },
    404: { description: 'No such staff account.' },
    422: { description: 'Your own account, or the last active super admin.' },
  },
  handler: async ({ params, body, auth }) =>
    ok(await staff.deactivateStaff(params.id, auth.staffId, body.reason)),
});

defineRoute(adminStaffRouter, {
  method: 'post',
  path: '/v1/admin/staff/:id/reactivate',
  surface: 'admin',
  operationId: 'adminReactivateStaff',
  summary: 'Restore a suspended staff member',
  description:
    'Returns the account to `active`, or to `invited` if it never set a password — a database CHECK forbids ' +
    'an active account without one, so the status reported back may not be `active`.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { params: staffIdParam },
  responses: {
    200: { description: 'Restored.', schema: staffLifecycleResult },
    404: { description: 'No such staff account.' },
    422: { description: 'That account is not suspended.' },
  },
  handler: async ({ params }) => ok(await staff.reactivateStaff(params.id)),
});

defineRoute(adminStaffRouter, {
  method: 'post',
  path: '/v1/admin/staff/:id/sessions/revoke',
  surface: 'admin',
  operationId: 'adminRevokeStaffSessions',
  summary: 'Force sign-out',
  description:
    'Terminates live sessions without changing the account status — the member can sign straight back in. ' +
    'To withdraw access, suspend the account instead.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { params: staffIdParam },
  responses: {
    200: { description: 'Sessions terminated.', schema: revokeResult },
    404: { description: 'No such staff account.' },
  },
  handler: async ({ params }) => ok(await staff.revokeStaffSessions(params.id)),
});

defineRoute(adminStaffRouter, {
  method: 'post',
  path: '/v1/admin/staff/:id/password/reset',
  surface: 'admin',
  operationId: 'adminSendStaffPasswordReset',
  summary: 'Send a password reset',
  description:
    'Emails a one-time token valid for 30 minutes. `sent` is always true: a mail failure is logged rather ' +
    'than reported, so the response cannot be used to probe anything.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { params: staffIdParam },
  responses: {
    200: { description: 'Reset dispatched.', schema: acknowledgedResult },
    404: { description: 'No such staff account.' },
  },
  handler: async ({ params }) => ok(await staff.sendPasswordReset(params.id)),
});

defineRoute(adminStaffRouter, {
  method: 'delete',
  path: '/v1/admin/staff/:id',
  surface: 'admin',
  operationId: 'adminDeleteStaff',
  summary: 'Delete a staff member',
  description:
    'A SOFT delete: the row is retained with `deleted_at` set so sessions, audit records and order history ' +
    'keep their references, and the email becomes free for re-use. Refused for your own account and for the ' +
    'last active super admin.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { params: staffIdParam },
  responses: {
    200: { description: 'Deleted.', schema: deleteResult },
    404: { description: 'No such staff account.' },
    422: { description: 'Your own account, or the last active super admin.' },
  },
  handler: async ({ params, auth }) => ok(await staff.deleteStaff(params.id, auth.staffId)),
});
