import { pool } from '../src/config/db.js';

async function main() {
  const hsnRes = await pool.query('SELECT code, description FROM hsn_codes;');
  console.log('Existing HSN codes in DB:');
  console.table(hsnRes.rows);

  const prodHsn = await pool.query(`
    SELECT DISTINCT hsn_code, count(*)
    FROM products
    GROUP BY hsn_code;
  `);
  console.log('Products grouped by HSN code:');
  console.table(prodHsn.rows);

  const missingHsn = await pool.query(`
    SELECT id, handle, title, hsn_code, status
    FROM products
    WHERE hsn_code IS NULL;
  `);
  console.log(`Found ${missingHsn.rows.length} products with NULL hsn_code:`);
  console.table(missingHsn.rows.slice(0, 15));

  await pool.end();
}

main().catch(console.error);
