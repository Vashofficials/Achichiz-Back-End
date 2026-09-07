import { db } from './src/config/db.js';
import { hsnCodes } from './src/db/schema/tax.js';

async function main() {
  const [hsn] = await db.select().from(hsnCodes).limit(1);
  console.log('HSN CODE:', hsn?.code);
  process.exit(0);
}
main().catch(console.error);
