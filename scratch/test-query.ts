import { pool } from '../src/config/db.js';

async function main() {
  const r = await pool.query(`
    SELECT p.id, p.handle, p.status, p.deleted_at, p.published_at, p.published_at <= now() as is_published
    FROM products p
    WHERE p.handle = 'chain-pendent-set';
  `);
  console.log('Query result:', r.rows);

  const directCheck = await pool.query(`
    SELECT p.id, p.handle, p.status, p.deleted_at, p.published_at
    FROM products p
    WHERE p.handle = 'chain-pendent-set'
      AND p.status = 'active'
      AND p.deleted_at IS NULL
      AND p.published_at IS NOT NULL
      AND p.published_at <= now();
  `);
  console.log('Live check result:', directCheck.rows);

  process.exit(0);
}

main().catch(console.error);
