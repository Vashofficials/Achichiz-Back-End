import fs from 'fs';
import { pool } from '../src/config/db.js';

async function main() {
  const data = JSON.parse(fs.readFileSync('scratch/inventory_products_parsed.json', 'utf8'));

  console.log(`Checking mappings for ${data.length} inventory products...`);

  let checked = 0;
  let missingMappingCount = 0;

  for (const item of data) {
    let handle = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

    // Find product in DB
    const res = await pool.query(`
      SELECT p.id, p.handle, p.title, p.status, p.deleted_at, p.published_at,
             json_agg(json_build_object('handle', c.handle, 'title', c.title, 'kind', c.kind)) as collections
      FROM products p
      LEFT JOIN product_collections pc ON pc.product_id = p.id
      LEFT JOIN collections c ON pc.collection_id = c.id
      WHERE p.handle = $1 OR p.handle = $2
      GROUP BY p.id, p.handle, p.title, p.status, p.deleted_at, p.published_at;
    `, [handle, handle.replace('-pendent-', '-pendant-')]);

    if (res.rows.length === 0) {
      console.warn(`⚠️ Product not found in DB: "${item.name}" (${handle})`);
      missingMappingCount++;
      continue;
    }

    const prod = res.rows[0];
    const cols = prod.collections.filter((c: any) => c.handle !== null);
    const colHandles = cols.map((c: any) => c.handle);

    console.log(`[${++checked}] "${prod.title}" (${prod.handle}) - status: ${prod.status} - collections: [${colHandles.join(', ')}]`);
  }

  process.exit(0);
}

main().catch(console.error);
