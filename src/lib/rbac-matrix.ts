/**
 * Ported VERBATIM from the admin console's `src/lib/rbac.tsx`.
 *
 * In the frontend this matrix only hides buttons — and `setRole()` lets a user
 * assign themselves any role. Here it is the authorization boundary. Same data,
 * inverted trust.
 *
 * This file is the seed source for the `roles` / `role_permissions` tables. It is
 * NOT read at request time — `requirePermission` resolves against the database,
 * so an operator can change a grant without a deploy. Re-seeding is a migration.
 */
export const ROLES = [
  'Super Admin',
  'Operations Manager',
  'Catalogue Manager',
  'Order Manager',
  'Warehouse Manager',
  'Customer Support Executive',
  'Corporate Sales Manager',
  'Finance Manager',
  'Marketing Manager',
  'Content Manager',
  'Read-only Analyst',
] as const;
export type Role = (typeof ROLES)[number];

export const MODULES = [
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
export type ModuleKey = (typeof MODULES)[number];

export const ACTIONS = [
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
export type Action = (typeof ACTIONS)[number];

const ALL: Action[] = [...ACTIONS];
const RW: Action[] = ['view', 'create', 'edit', 'export'];
const RO: Action[] = ['view', 'export'];

export const permissionMatrix: Record<Role, Partial<Record<ModuleKey, Action[]>>> = {
  'Super Admin': Object.fromEntries(MODULES.map((m) => [m, ALL])),
  'Operations Manager': {
    dashboard: RO,
    orders: [...RW, 'cancel', 'approve'],
    catalogue: RW,
    inventory: RW,
    customers: RW,
    corporate: RO,
    delivery: RW,
    promotions: RO,
    content: RO,
    reports: RO,
    settings: RO,
    finance: RO,
  },
  'Catalogue Manager': {
    dashboard: RO,
    catalogue: [...RW, 'delete'],
    inventory: RO,
    reports: RO,
    content: RO,
  },
  'Order Manager': {
    dashboard: RO,
    orders: [...RW, 'cancel'],
    customers: RO,
    delivery: RW,
    inventory: RO,
    reports: RO,
  },
  'Warehouse Manager': {
    dashboard: RO,
    orders: ['view', 'edit'],
    inventory: [...RW, 'delete'],
    delivery: RW,
    reports: RO,
  },
  'Customer Support Executive': {
    dashboard: RO,
    orders: ['view', 'edit'],
    customers: RW,
    delivery: RO,
    content: RO,
  },
  'Corporate Sales Manager': {
    dashboard: RO,
    corporate: [...RW, 'approve'],
    customers: RO,
    orders: RO,
    reports: RO,
  },
  // NOTE: `settings: ['view','manage-settings']` lets Finance edit payment settings.
  // Flagged for sign-off before seeding — see roadmap §9 item 13.
  'Finance Manager': {
    dashboard: RO,
    orders: ['view', 'refund', 'cancel', 'export'],
    finance: ALL,
    reports: RO,
    corporate: ['view', 'approve', 'export'],
    settings: ['view', 'manage-settings'],
  },
  'Marketing Manager': {
    dashboard: RO,
    promotions: [...RW, 'delete', 'approve'],
    customers: RO,
    content: RW,
    reports: RO,
  },
  'Content Manager': {
    dashboard: RO,
    content: [...RW, 'delete'],
    catalogue: RO,
    reports: RO,
  },
  'Read-only Analyst': Object.fromEntries(MODULES.map((m) => [m, RO])),
};

/** `orders:refund` — the wire format stored in `role_permissions` and in the staff JWT. */
export const permissionKey = (module: ModuleKey, action: Action): string => `${module}:${action}`;

export function permissionsForRole(role: Role): string[] {
  const grants = permissionMatrix[role] ?? {};
  return Object.entries(grants)
    .flatMap(([module, actions]) => (actions ?? []).map((a) => permissionKey(module as ModuleKey, a)))
    .sort();
}
