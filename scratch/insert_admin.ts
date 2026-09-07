import { db } from '../src/config/db.js';
import { sql } from 'drizzle-orm';
import * as argon2 from 'argon2';
async function main() {
  const passwordHash = await argon2.hash('password123');
  try {
    const res1 = await db.execute(sql
      INSERT INTO staff (id, email, first_name, last_name, status, password_hash)
      VALUES ('11111111-1111-1111-1111-111111111111', 'admin@example.com', 'Admin', 'User', 'active', )
      ON CONFLICT (email) DO NOTHING
      RETURNING id;
    );
    
    let staffId = res1.rows[0]?.id;
    if (!staffId) {
       const existing = await db.execute(sqlSELECT id FROM staff WHERE email = 'admin@example.com');
       staffId = existing.rows[0].id;
    }

    await db.execute(sql
      INSERT INTO staff_roles (staff_id, role_key)
      VALUES (, 'super_admin')
      ON CONFLICT DO NOTHING;
    );
    console.log('Admin inserted successfully!');
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
main();
