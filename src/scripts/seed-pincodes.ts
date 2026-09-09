import { eq, sql } from 'drizzle-orm';
import { db } from '../config/db.js';
import { deliveryZones, deliveryZonePincodes, gstStates } from '../db/schema/index.js';

export const LUCKNOW_AREAS_AND_PINCODES = [
  { sl: '01', area: 'Indira Nagar', pincode: '226016', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '02', area: 'Alambagh', pincode: '226018', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '03', area: 'Gomti Nagar', pincode: '226010', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '04', area: 'Chowk', pincode: '226003', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '05', area: 'Alishbagh', pincode: '226004', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '06', area: 'Rajajipuram', pincode: '226017', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '07', area: 'Chinhat', pincode: '226028', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '08', area: 'Jankipuram Extension', pincode: '226031', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '09', area: 'Hans Khera', pincode: '226011', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '10', area: 'Ashlyana', pincode: '226012', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '11', area: 'Kalyanpur Vikas Nagar', pincode: '226022', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '12', area: 'Kapoorthala', pincode: '226024', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '13', area: 'Mahanagar', pincode: '226006', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '14', area: 'Nishatganj', pincode: '226007', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '15', area: 'Integral University', pincode: '226026', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '16', area: 'SGPGI Bijnor', pincode: '226014', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '17', area: 'South City', pincode: '226025', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '18', area: 'Vrindavan Yojna', pincode: '226029', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '19', area: 'Mohanlalganj', pincode: '226301', city: 'Mohanlalganj', state: 'Uttar Pradesh' },
  { sl: '20', area: 'Sushant Golf City', pincode: '226030', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '21', area: 'Fazullaganj', pincode: '226020', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '22', area: 'Hazratganj', pincode: '226001', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '23', area: 'IIM Lucknow', pincode: '226013', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '24', area: 'Aliganj', pincode: '226024', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '25', area: 'Sitapur Road', pincode: '226021', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '26', area: 'Krishna Nagar', pincode: '226012', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '27', area: 'Alambagh', pincode: '226005', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '28', area: 'Sarojini Nagar', pincode: '226008', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '29', area: 'Amausi Airport', pincode: '226009', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '30', area: 'CIMAP Indira Nagar Ext', pincode: '226015', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '31', area: 'Manas Nagar', pincode: '226023', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '32', area: 'Bakshi Ka Talab', pincode: '226201', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '33', area: 'Dubagga', pincode: '226101', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '34', area: 'Faridipur', pincode: '226101', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '35', area: 'Balaganj, Dubbagga, Munnu khera, Sadrauna', pincode: '226003', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '36', area: 'Raj Bhawan Hazratganj', pincode: '226027', city: 'Lucknow', state: 'Uttar Pradesh' },
  { sl: '37', area: 'Gomti Nagar Extension', pincode: '226002', city: 'Lucknow', state: 'Uttar Pradesh' },
];

async function seed() {
  console.log('--- Starting Pincodes & Delivery Zone Sync ---');

  // 1. Verify UP in gstStates
  const up = await db.select().from(gstStates).where(eq(gstStates.code, '09')).limit(1);
  if (!up.length) {
    console.log('Inserting 09 (Uttar Pradesh) into gst_states...');
    await db.insert(gstStates).values({
      code: '09',
      name: 'Uttar Pradesh',
      isUnionTerr: false,
    }).onConflictDoNothing();
  }

  // 2. Ensure Lucknow Zone exists
  const targetZoneId = 'a24756c8-ba55-47db-8265-d8b3146f1fae';
  const existingZone = await db.select().from(deliveryZones).where(eq(deliveryZones.id, targetZoneId)).limit(1);

  if (existingZone.length > 0) {
    console.log('Updating existing zone a24756c8-ba55-47db-8265-d8b3146f1fae to active Lucknow Zone...');
    await db.update(deliveryZones).set({
      code: 'LUCKNOW-CENTRAL',
      name: 'Lucknow Delivery Zone',
      city: 'Lucknow',
      stateCode: '09',
      tier: 'tier_1',
      supportsSameDay: true,
      supportsMidnight: false,
      supportsCod: true,
      baseFeePaise: 0,
      sameDayCutoff: '15:00:00',
      standardTatDays: 1,
      status: 'active',
      updatedAt: new Date(),
    }).where(eq(deliveryZones.id, targetZoneId));
  } else {
    console.log('Inserting new Lucknow zone...');
    await db.insert(deliveryZones).values({
      id: targetZoneId,
      code: 'LUCKNOW-CENTRAL',
      name: 'Lucknow Delivery Zone',
      city: 'Lucknow',
      stateCode: '09',
      tier: 'tier_1',
      supportsSameDay: true,
      supportsMidnight: false,
      supportsCod: true,
      baseFeePaise: 0,
      sameDayCutoff: '15:00:00',
      standardTatDays: 1,
      status: 'active',
    });
  }

  // 3. Upsert all 37 delivery areas/pincodes into delivery_zone_pincodes
  console.log(`Upserting ${LUCKNOW_AREAS_AND_PINCODES.length} delivery pin codes into delivery_zone_pincodes...`);

  // De-duplicate unique pincodes while preserving city/area info
  const pincodeMap = new Map<string, { pincode: string; city: string; stateCode: string }>();
  for (const item of LUCKNOW_AREAS_AND_PINCODES) {
    pincodeMap.set(item.pincode, {
      pincode: item.pincode,
      city: item.city || 'Lucknow',
      stateCode: '09',
    });
  }

  for (const [pincode, data] of pincodeMap.entries()) {
    await db.insert(deliveryZonePincodes).values({
      pincode,
      zoneId: targetZoneId,
      city: data.city,
      stateCode: data.stateCode,
      isServiceable: true,
      codAllowed: true,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: deliveryZonePincodes.pincode,
      set: {
        zoneId: targetZoneId,
        city: data.city,
        stateCode: data.stateCode,
        isServiceable: true,
        codAllowed: true,
        updatedAt: new Date(),
      },
    });
    console.log(`✓ Added/Updated PIN: ${pincode} (${data.city})`);
  }

  const allPincodes = await db.select().from(deliveryZonePincodes).where(eq(deliveryZonePincodes.zoneId, targetZoneId));
  console.log(`\nSUCCESS: Zone now has ${allPincodes.length} serviceable PIN codes in DB!`);

  process.exit(0);
}

seed().catch((err) => {
  console.error('FAILED TO SEED PINCODES:', err);
  process.exit(1);
});
