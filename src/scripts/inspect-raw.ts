import { db } from '../config/db.js';
import { sql } from 'drizzle-orm';

async function main() {
  try {
    const cols = await db.execute(sql`SELECT id, handle, title, kind, parent_id, status FROM collections ORDER BY handle ASC`);
    console.log(JSON.stringify(cols.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

main();
