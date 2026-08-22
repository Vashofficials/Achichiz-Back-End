import { z } from 'zod';
import { ACTIONS, MODULES } from '../../lib/rbac-matrix.js';

export const moduleKey = z.enum(MODULES).describe('One of the twelve RBAC module keys.');
export const actionKey = z.enum(ACTIONS).describe('One of the nine RBAC action keys.');

export const roleIdParam = z.object({
  roleId: z.uuid().describe('Role id from `GET /v1/admin/roles`.'),
});

export const roleView = z.object({
  id: z.uuid().describe('Role id.'),
  key: z.string().describe('Stable machine key, e.g. `operations_manager`. Matches `^[a-z0-9_]+$`.'),
  name: z.string().describe('Display name, e.g. `Operations Manager`.'),
  description: z.string().nullable().describe('What the role is for.'),
  isSystem: z.boolean().describe('True for the eleven roles the matrix owns. They cannot be deleted.'),
  staffCount: z.number().int().describe('Live staff members holding this role.'),
  grantCount: z.number().int().describe('Number of `module:action` grants.'),
});

export const roleDetail = roleView.extend({
  permissions: z
    .array(z.string())
    .describe('Flat `module:action` grants — the exact strings the staff JWT carries.'),
  // partialRecord, not record: with an enum key zod 4 infers an EXHAUSTIVE
  // Record, which would promise the frontend a key for all twelve modules. A
  // Catalogue Manager has no `finance` grant at all, so that key is genuinely
  // absent — the contract must say so rather than hand out `undefined`.
  grants: z
    .partialRecord(moduleKey, z.array(actionKey))
    .describe('The same grants pivoted by module, which is the shape the matrix screen renders.'),
  members: z
    .array(
      z.object({
        id: z.uuid().describe('Staff user id.'),
        fullName: z.string().describe('Display name.'),
        email: z.string().describe('Work email.'),
        status: z.string().describe('`active`, `invited` or `suspended`.'),
      }),
    )
    .describe('Staff members currently holding this role.'),
});

export const permissionCatalogue = z.object({
  modules: z
    .array(
      z.object({
        key: moduleKey,
        label: z.string().describe('Human label for the nav and the 403 message.'),
      }),
    )
    .describe('The twelve modules, in matrix order.'),
  actions: z
    .array(
      z.object({
        key: actionKey,
        label: z.string().describe('Human label.'),
        mutating: z
          .boolean()
          .describe('False for `view` and `export`. A role holding only these needs no second factor.'),
      }),
    )
    .describe('The nine actions, in matrix order.'),
});

export const permissionMatrixView = z.object({
  roles: z.array(z.string()).describe('Role keys, in the order the matrix declares them.'),
  matrix: z
    .record(z.string(), z.partialRecord(moduleKey, z.array(actionKey)))
    .describe(
      'roleKey → module → actions, read from `role_permissions` — the DATABASE copy, not the ' +
        'compiled-in matrix. If an operator has revoked a grant by hand this shows the revoked state, ' +
        'which is the point of having the copy.',
    ),
  drift: z
    .array(
      z.object({
        roleKey: z.string().describe('Role whose stored grants differ from `lib/rbac-matrix.ts`.'),
        missing: z.array(z.string()).describe('In the matrix, absent from the database.'),
        extra: z.array(z.string()).describe('In the database, absent from the matrix.'),
      }),
    )
    .describe('Where the database and the source matrix disagree. Empty is the healthy state.'),
});

export const seedResult = z.object({
  rolesUpserted: z.number().int().describe('Roles inserted or refreshed.'),
  permissionsGranted: z.number().int().describe('Grants added.'),
  permissionsRevoked: z.number().int().describe('Grants removed because the matrix no longer has them.'),
});

export type RoleDetailResponse = z.infer<typeof roleDetail>;
export type PermissionMatrixResponse = z.infer<typeof permissionMatrixView>;
