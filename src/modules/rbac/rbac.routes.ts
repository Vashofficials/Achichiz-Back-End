import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok } from '../../lib/http.js';
import * as rbac from './rbac.service.js';
import {
  permissionCatalogue,
  permissionMatrixView,
  roleDetail,
  roleIdParam,
  roleView,
  seedResult,
} from './rbac.schemas.js';

/**
 * Roles and grants.
 *
 * Read-only except for the re-seed, on purpose. `lib/rbac-matrix.ts` is the
 * source and these tables are the derived copy; a per-grant PATCH endpoint would
 * let an operator make a change that the next `db:seed` silently undoes, which
 * is a worse failure than not offering the endpoint. Emergency revocation is a
 * SQL statement against `role_permissions`, and `GET /permissions/matrix` will
 * then report it as drift rather than hiding it.
 */
export const rbacRouter: Router = Router();

defineRoute(rbacRouter, {
  method: 'get',
  path: '/v1/admin/roles',
  surface: 'admin',
  operationId: 'adminListRoles',
  summary: 'List roles',
  description:
    'The eleven system roles with live staff counts and grant counts. Backs the role picker on ' +
    '`/settings/team` and the role column on the team list.',
  tags: ['RBAC'],
  auth: 'staff',
  permission: { module: 'settings', action: 'view' },
  responses: {
    200: { description: 'Roles, alphabetical.', schema: z.array(roleView) },
  },
  handler: async () => ok(await rbac.listRoles()),
});

defineRoute(rbacRouter, {
  method: 'get',
  path: '/v1/admin/roles/:roleId',
  surface: 'admin',
  operationId: 'adminGetRole',
  summary: 'Get one role',
  description:
    'The role, its grants in both shapes (a flat `module:action` list and the module-pivoted map the ' +
    'matrix screen renders), and the staff members holding it.',
  tags: ['RBAC'],
  auth: 'staff',
  permission: { module: 'settings', action: 'view' },
  request: { params: roleIdParam },
  responses: {
    200: { description: 'The role.', schema: roleDetail },
    404: { description: 'No such role.' },
  },
  handler: async ({ params }) => ok(await rbac.getRole(params.roleId)),
});

defineRoute(rbacRouter, {
  method: 'get',
  path: '/v1/admin/permissions',
  surface: 'admin',
  operationId: 'adminListPermissionCatalogue',
  summary: 'The permission vocabulary',
  description:
    'The twelve modules and nine actions, with labels. `mutating: false` marks `view` and `export` — ' +
    'a role holding nothing but those cannot change anything, which is exactly the test that decides ' +
    'whether two-factor authentication is mandatory for it.',
  tags: ['RBAC'],
  auth: 'staff',
  permission: { module: 'settings', action: 'view' },
  responses: {
    200: { description: 'Modules and actions.', schema: permissionCatalogue },
  },
  handler: () => ok(rbac.permissionCatalogue()),
});

defineRoute(rbacRouter, {
  method: 'get',
  path: '/v1/admin/permissions/matrix',
  surface: 'admin',
  operationId: 'adminGetPermissionMatrix',
  summary: 'The whole grant matrix, and its drift',
  description:
    'roleKey → module → actions, read from `role_permissions` — the copy that is actually enforced, ' +
    'not the compiled-in matrix. `drift` lists every grant the two disagree on, in both directions. An ' +
    'empty `drift` array is the healthy state; anything in it is either a deliberate emergency ' +
    'revocation or a seed that has not been run.',
  tags: ['RBAC'],
  auth: 'staff',
  permission: { module: 'settings', action: 'view' },
  responses: {
    200: { description: 'The stored matrix and its drift from source.', schema: permissionMatrixView },
  },
  handler: async () => ok(await rbac.permissionMatrix()),
});

defineRoute(rbacRouter, {
  method: 'post',
  path: '/v1/admin/roles/sync',
  surface: 'admin',
  operationId: 'adminSyncRolesFromMatrix',
  summary: 'Re-seed roles and grants from the source matrix',
  description:
    'Projects `lib/rbac-matrix.ts` onto `roles` and `role_permissions`. Idempotent, and it REVOKES ' +
    'grants the matrix no longer contains — without that step, narrowing a role in code would be a ' +
    'no-op in the database, which is the one kind of seed bug that fails open.\n\n' +
    'It therefore also **undoes any manual revocation**. Check `GET /v1/admin/permissions/matrix` ' +
    'first. Gated on `settings:manage-settings`, which only Super Admin and Finance Manager hold.',
  tags: ['RBAC'],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  responses: {
    200: { description: 'What changed.', schema: seedResult },
  },
  handler: async () => ok(await rbac.syncRolesFromMatrix()),
});
