import { db } from '../config/db.js';
import { deliveryZones, deliveryZonePincodes, gstStates } from '../db/schema/index.js';

async function main() {
  try {
    const states = await db.select().from(gstStates);
    console.log('GST STATES COUNT:', states.length);
    const upState = states.find((s) => s.code === '09' || s.name.toLowerCase().includes('uttar'));
    console.log('UP in GST STATES:', upState);

    const zones = await db.select().from(deliveryZones);
    console.log('EXISTING ZONES COUNT:', zones.length);
    console.log('ZONES:', JSON.stringify(zones, null, 2));

    const pincodes = await db.select().from(deliveryZonePincodes);
    console.log('EXISTING PINCODES COUNT:', pincodes.length);
    console.log('SAMPLE PINCODES:', JSON.stringify(pincodes.slice(0, 10), null, 2));
  } catch (err) {
    console.error('ERROR INSPECTING DB:', err);
  } finally {
    process.exit(0);
  }
}

main();
