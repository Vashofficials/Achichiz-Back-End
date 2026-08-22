import { logger } from '../../config/logger.js';
import { closeDb } from '../../config/db.js';
import { seedRoles } from './roles.js';

/**
 * Seeds reference data the application cannot function without.
 *
 * Idempotent by construction — every seed upserts — so running this against a
 * database that already has data is safe, and is the normal way to apply a change
 * to the permission matrix.
 *
 * This is NOT demo or fixture data. Nothing here creates a product, a customer or
 * an order; it only installs the rows the code assumes already exist.
 */
async function main(): Promise<void> {
  logger.info('seeding reference data');

  const roles = await seedRoles();
  logger.info(
    {
      roles: roles.rolesUpserted,
      granted: roles.permissionsGranted,
      revoked: roles.permissionsRevoked,
    },
    'roles and permissions seeded from lib/rbac-matrix.ts',
  );

  logger.info('seed complete');
  await closeDb();
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'seed failed');
  process.exit(1);
});
