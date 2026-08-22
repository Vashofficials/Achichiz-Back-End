/**
 * Roles and grants, read-side, plus the one write: re-seeding from the matrix.
 *
 * `lib/rbac-matrix.ts` is the source of truth and `roles`/`role_permissions` is
 * the derived copy that `requirePermission` resolves against at login. Two
 * copies means they can disagree — deliberately, so an operator can revoke a
 * grant during an incident without a deploy — so `permissionMatrix()` reports
 * the DRIFT rather than pretending the compiled matrix is what is enforced.
 */

import { seedRoles, roleKey, type SeedRolesResult } from '../../db/seed/roles.js';
import { NotFoundError } from '../../lib/errors.js';
import {
  ACTIONS,
  MODULES,
  ROLES,
  permissionsForRole,
  type Action,
  type ModuleKey,
} from '../../lib/rbac-matrix.js';
import { READ_ONLY_ACTIONS } from '../admin-auth/admin-auth.totp.js';
import * as repo from './rbac.repository.js';
import type { PermissionMatrixResponse, RoleDetailResponse } from './rbac.schemas.js';

const MODULE_LABELS: Record<ModuleKey, string> = {
  dashboard: 'Dashboard',
  orders: 'Orders',
  catalogue: 'Catalogue',
  inventory: 'Inventory',
  customers: 'Customers',
  corporate: 'Corporate gifting',
  delivery: 'Delivery & fulfilment',
  promotions: 'Promotions',
  content: 'Content & storefront',
  reports: 'Reports',
  settings: 'Settings',
  finance: 'Finance',
};

const ACTION_LABELS: Record<Action, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  export: 'Export',
  approve: 'Approve',
  refund: 'Refund',
  cancel: 'Cancel',
  'manage-settings': 'Manage settings',
};

/** `[{module,action}]` → `{ orders: ['view','edit'] }`. */
function pivot(grants: readonly { module: string; action: string }[]): Partial<Record<ModuleKey, Action[]>> {
  const out: Partial<Record<ModuleKey, Action[]>> = {};
  for (const grant of grants) {
    const module = grant.module as ModuleKey;
    if (!MODULES.includes(module)) continue;
    (out[module] ??= []).push(grant.action as Action);
  }
  return out;
}

export async function listRoles(): Promise<repo.RoleRow[]> {
  return repo.listRoles();
}

export async function getRole(roleId: string): Promise<RoleDetailResponse> {
  const role = await repo.findRole(roleId);
  if (!role) throw new NotFoundError('Role', roleId);

  const [grants, members] = await Promise.all([repo.grantsForRole(roleId), repo.membersOfRole(roleId)]);

  return {
    ...role,
    permissions: grants.map((g) => `${g.module}:${g.action}`),
    grants: pivot(grants),
    members,
  };
}

export function permissionCatalogue(): {
  modules: { key: ModuleKey; label: string }[];
  actions: { key: Action; label: string; mutating: boolean }[];
} {
  return {
    modules: MODULES.map((key) => ({ key, label: MODULE_LABELS[key] })),
    actions: ACTIONS.map((key) => ({
      key,
      label: ACTION_LABELS[key],
      mutating: !READ_ONLY_ACTIONS.has(key),
    })),
  };
}

/**
 * The stored matrix, plus every place it has drifted from the source.
 *
 * Drift is computed per role key, so a role that only exists in the database
 * (someone added one by hand) shows every stored grant as `extra`, and a role
 * that has never been seeded shows every matrix grant as `missing`.
 */
export async function permissionMatrix(): Promise<PermissionMatrixResponse> {
  const stored = await repo.allGrants();

  const byRole = new Map<string, { module: string; action: string }[]>();
  for (const grant of stored) {
    const bucket = byRole.get(grant.roleKey);
    if (bucket) bucket.push(grant);
    else byRole.set(grant.roleKey, [grant]);
  }

  const matrix: Record<string, Partial<Record<ModuleKey, Action[]>>> = {};
  for (const [key, grants] of byRole) matrix[key] = pivot(grants);

  const drift: PermissionMatrixResponse['drift'] = [];
  const roleKeys = new Set([...ROLES.map(roleKey), ...byRole.keys()]);

  for (const key of roleKeys) {
    const source = ROLES.find((r) => roleKey(r) === key);
    const expected = new Set(source ? permissionsForRole(source) : []);
    const actual = new Set((byRole.get(key) ?? []).map((g) => `${g.module}:${g.action}`));

    const missing = [...expected].filter((p) => !actual.has(p)).sort();
    const extra = [...actual].filter((p) => !expected.has(p)).sort();
    if (missing.length > 0 || extra.length > 0) drift.push({ roleKey: key, missing, extra });
  }

  return { roles: ROLES.map(roleKey), matrix, drift };
}

/**
 * Project `lib/rbac-matrix.ts` back onto the tables.
 *
 * Idempotent, and it REVOKES grants the matrix no longer contains — without that
 * step, narrowing a role in code would be a no-op in the database, which is the
 * one kind of seed bug that fails open.
 */
export async function syncRolesFromMatrix(): Promise<SeedRolesResult> {
  return seedRoles();
}
