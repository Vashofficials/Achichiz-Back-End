import { pool } from '../src/config/db.js';

async function main() {
  // Rename draft duplicate handles if any
  await pool.query(`
    UPDATE products
    SET handle = 'draft-' || id || '-' || handle
    WHERE status = 'draft' AND handle = 'chain-pendent-set';
  `);

  // Un-delete the active chain-pendent-set
  await pool.query(`
    UPDATE products
    SET deleted_at = NULL, status = 'active', published_at = NOW()
    WHERE id = '7a375403-df76-494e-b232-5f287b312f53';
  `);

  console.log('Un-deleted chain-pendent-set!');
  process.exit(0);
}

main().catch(console.error);
