import { sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { MODULES, ROLES, permissionMatrix, type Role } from '../../lib/rbac-matrix.js';

/**
 * Layer-0 seed: `roles` and `role_permissions`, generated from `lib/rbac-matrix.ts`.
 *
 * The matrix is the source; the tables are the derived copy that login resolves
 * against. Keeping the source in code and the copy in the database is deliberate —
 * an operator can revoke a grant without a deploy, and a re-seed puts it back,
 * which is what makes "re-seeding is a migration" true rather than a slogan.
 *
 * Idempotent by construction, and safe to run in production on every deploy:
 * roles UPSERT on `key`, grants INSERT ... ON CONFLICT DO NOTHING, and grants the
 * matrix no longer contains are DELETEd. That last step matters most — without it,
 * narrowing a role in code would be a no-op in the database, which is the one kind
 * of seed bug that fails open.
 *
 * Raw parameterised SQL rather than Drizzle tables, so the seed keeps working
 * during a migration that reshapes the Drizzle schema module.
 */

/** `'Operations Manager'` → `'operations_manager'`, matching `roles.key ~ '^[a-z0-9_]+$'`. */
export const roleKey = (role: Role): string =>
  role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const DESCRIPTIONS: Record<Role, string> = {
  'Super Admin': 'Unrestricted access to every module and action. Grant sparingly.',
  'Operations Manager': 'Runs the day-to-day desk: orders, catalogue, inventory, customers and delivery.',
  'Catalogue Manager': 'Owns the product catalogue, including deletion. No access to orders or customers.',
  'Order Manager': 'Works the order desk and delivery, and may cancel orders. Cannot issue refunds.',
  'Warehouse Manager': 'Picks, packs and moves stock. Read/edit on orders, full control of inventory.',
  'Customer Support Executive': 'Answers customers. Reads and edits orders, full access to customer records.',
  'Corporate Sales Manager': 'Owns corporate gifting: leads, quotations, campaigns and approvals.',
  'Finance Manager': 'Owns finance, refunds and payment settings. The only non-admin role that may refund.',
  'Marketing Manager': 'Owns promotions and storefront content.',
  'Content Manager': 'Owns storefront content. Read-only on the catalogue.',
  'Read-only Analyst': 'Sees and exports everything. Changes nothing.',
};

export type SeedRolesResult = {
  rolesUpserted: number;
  permissionsGranted: number;
  permissionsRevoked: number;
};

/** Flattens a role's matrix row into parallel `module` / `action` arrays. */
function grantsFor(role: Role): { modules: string[]; actions: string[] } {
  const grants = permissionMatrix[role];
  const modules: string[] = [];
  const actions: string[] = [];
  for (const module of MODULES) {
    for (const action of grants[module] ?? []) {
      modules.push(module);
      actions.push(action);
    }
  }
  return { modules, actions };
}

export async function seedRoles(): Promise<SeedRolesResult> {
  let rolesUpserted = 0;
  let permissionsGranted = 0;
  let permissionsRevoked = 0;

  await db.transaction(async (tx) => {
    for (const role of ROLES) {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO roles (key, name, description, is_system)
        VALUES (${roleKey(role)}, ${role}, ${DESCRIPTIONS[role]}, true)
        ON CONFLICT (key) DO UPDATE
          SET name        = EXCLUDED.name,
              description = EXCLUDED.description,
              is_system   = true,
              updated_at  = now()
        RETURNING id
      `);

      const roleId = inserted.rows[0]?.id;
      if (!roleId) throw new Error(`Failed to upsert role '${role}'`);
      rolesUpserted += 1;

      const { modules, actions } = grantsFor(role);

      if (modules.length === 0) {
        // A role with no grants is legal — it simply sees nothing.
        const cleared = await tx.execute(sql`
          DELETE FROM role_permissions WHERE role_id = ${roleId}::uuid
        `);
        permissionsRevoked += cleared.rowCount ?? 0;
        continue;
      }

      // Two parallel arrays unnested together: the only shape that keeps
      // module/action pairing intact without building SQL from strings.
      const granted = await tx.execute(sql`
        INSERT INTO role_permissions (role_id, module, action)
        SELECT ${roleId}::uuid, m, a
        FROM unnest(${sql.param(modules)}::text[], ${sql.param(actions)}::text[]) AS g(m, a)
        ON CONFLICT (role_id, module, action) DO NOTHING
      `);
      permissionsGranted += granted.rowCount ?? 0;

      const stale = await tx.execute(sql`
        DELETE FROM role_permissions rp
        WHERE rp.role_id = ${roleId}::uuid
          AND (rp.module, rp.action) NOT IN (
            SELECT m, a FROM unnest(${sql.param(modules)}::text[], ${sql.param(actions)}::text[]) AS g(m, a)
          )
      `);
      permissionsRevoked += stale.rowCount ?? 0;
    }
  });

  logger.info({ rolesUpserted, permissionsGranted, permissionsRevoked }, 'seeded roles and role_permissions');
  return { rolesUpserted, permissionsGranted, permissionsRevoked };
}
