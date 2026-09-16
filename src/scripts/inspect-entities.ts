import { db } from '../config/db.js';
import { sql } from 'drizzle-orm';

async function main() {
  try {
    const c = await db.execute(sql`SELECT id, full_name, email, mobile, firebase_uid, created_at FROM customers`);
    console.log('--- ALL CUSTOMERS ---');
    console.table(c.rows);

    const s = await db.execute(sql`SELECT id, code, name, contact_person, email, phone FROM suppliers`);
    console.log('--- ALL SUPPLIERS ---');
    console.table(s.rows);

    const b = await db.execute(sql`SELECT id, title, placement, is_active FROM banners`);
    console.log('--- BANNERS ---');
    console.table(b.rows);

    const t = await db.execute(sql`SELECT id, author_name, rating, is_featured FROM testimonials`);
    console.log('--- TESTIMONIALS ---');
    console.table(t.rows);

  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

main();
