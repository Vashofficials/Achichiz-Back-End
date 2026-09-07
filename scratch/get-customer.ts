import { db } from '../src/db/index.js';
import { customers } from '../src/db/schema/index.js';

async function run() {
  const c = await db.select({ id: customers.id }).from(customers).limit(1);
  console.log('CUSTOMER ID:', c[0]?.id);
  process.exit(0);
}
run();
