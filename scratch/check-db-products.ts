import { pool } from '../src/config/db.js';
import fs from 'fs';

async function check() {
  const parsed = JSON.parse(fs.readFileSync('scratch/inventory_products_parsed.json', 'utf-8'));
  const prodsInDb = await pool.query('SELECT id, handle, title, status FROM products');
  const dbHandles = new Map(prodsInDb.rows.map(r => [r.handle, r]));
  
  let matched = 0;
  let missing = 0;
  const missingList: any[] = [];

  for (const p of parsed) {
    const handle = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (dbHandles.has(handle)) {
      matched++;
    } else {
      missing++;
      missingList.push({ name: p.name, handle });
    }
  }
  console.log(`Matched in DB: ${matched}, Missing: ${missing}, Total in sheet: ${parsed.length}`);
  if (missingList.length > 0) {
    console.log('Missing items:', JSON.stringify(missingList, null, 2));
  }
  process.exit(0);
}

check().catch(e => {
  console.error(e);
  process.exit(1);
});
