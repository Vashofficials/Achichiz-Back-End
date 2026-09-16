import { db } from '../config/db.js';
import { hsnCodes } from '../db/schema/index.js';

async function main() {
  try {
    const list = await db.select().from(hsnCodes);
    console.log('--- HSN CODES IN DB ---');
    console.table(list.map((h) => ({ code: h.code, description: h.description, isService: h.isService })));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

main();
