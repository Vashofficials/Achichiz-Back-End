import { db } from '../config/db.js';
import { sql } from 'drizzle-orm';

async function main() {
  try {
    const tablesRes = await db.execute(sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log('--- TABLES WITH ROWS ---');
    for (const row of tablesRes.rows) {
      const tableName = (row as any).table_name;
      try {
        const countRes = await db.execute(sql.raw(`SELECT count(*)::int as count FROM "${tableName}"`));
        const count = (countRes.rows[0] as any).count;
        if (count > 0) {
          console.log(`${tableName}: ${count}`);
        }
      } catch (err: any) {
        // ignore
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

main();
