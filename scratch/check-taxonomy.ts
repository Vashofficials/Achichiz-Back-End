import fs from 'fs';
import { pool } from '../src/config/db.js';

async function main() {
  const data = JSON.parse(fs.readFileSync('scratch/inventory_products_parsed.json', 'utf8'));
  const catMap = new Map<string, Set<string>>();
  for (const item of data) {
    const cat = item.category || 'NO_CAT';
    const sub = item.subCategory || 'NO_SUB';
    if (!catMap.has(cat)) catMap.set(cat, new Set());
    catMap.get(cat)!.add(sub);
  }

  console.log('=== Inventory Categories & Subcategories ===');
  for (const [cat, subs] of catMap.entries()) {
    console.log(`[Category]: ${cat}`);
    for (const s of subs) {
      const prods = data.filter((d: any) => d.category === cat && d.subCategory === s);
      console.log(`   -> [SubCategory]: "${s}" (${prods.length} products)`);
    }
  }

  console.log('\n=== DB Collections matching these handles ===');
  const dbCols = await pool.query(`
    SELECT id, handle, title, kind, parent_id FROM collections ORDER BY title;
  `);

  for (const row of dbCols.rows) {
    console.log(`DB Col: "${row.title}" (handle: "${row.handle}", kind: "${row.kind}")`);
  }

  process.exit(0);
}

main().catch(console.error);
