import { db } from '../config/db.js';
import { sql } from 'drizzle-orm';

async function main() {
  try {
    const triggers = await db.execute(sql`
      SELECT event_object_table, trigger_name, event_manipulation 
      FROM information_schema.triggers 
      WHERE event_object_table IN ('orders', 'payments', 'invoices', 'activity_logs', 'collections')
      ORDER BY event_object_table;
    `);
    console.log('--- TRIGGERS ---');
    console.table(triggers.rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

main();
