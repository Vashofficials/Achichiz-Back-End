const { Pool } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const dbUrl = env.split('\n').find(l => l.startsWith('DATABASE_URL=')).split('=')[1].trim();
const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
async function main() {
  const argon2 = await import('argon2');
  const passwordHash = await argon2.hash('password123');
  try {
    const res1 = await pool.query('INSERT INTO staff (id, email, first_name, last_name, status, password_hash) VALUES (\'11111111-1111-1111-1111-111111111111\', \'admin@example.com\', \'Admin\', \'User\', \'active\', $1) ON CONFLICT (email) DO NOTHING RETURNING id;', [passwordHash]);
    let staffId = res1.rows[0]?.id;
    if (!staffId) {
       const existing = await pool.query('SELECT id FROM staff WHERE email = \'admin@example.com\'');
       staffId = existing.rows[0].id;
    }
    await pool.query('INSERT INTO staff_roles (staff_id, role_key) VALUES ($1, \'super_admin\') ON CONFLICT DO NOTHING;', [staffId]);
    console.log('Admin inserted successfully!');
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
main();
