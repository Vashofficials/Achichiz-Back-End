import { sql } from 'drizzle-orm';
import { db } from '../../config/db.js';

/**
 * Layer-0 seed: `gst_states`, the official GST state/UT code list.
 *
 * Fourteen foreign keys across ten tables reference this one table —
 * `addresses`, `orders` (ship/bill/supplier/place-of-supply), `invoices`,
 * `warehouses`, `suppliers`, `delivery_zones`, `delivery_zone_pincodes`,
 * `corporate_accounts`, `corporate_leads` and `campaign_recipients`. With it
 * empty, no customer address can be written, so no order can be placed and no
 * invoice raised: the storefront is unusable end to end.
 *
 * This is reference data published by the GST Council, not fixture data. The
 * two-digit code is the first two digits of every GSTIN, so `place_of_supply`
 * arithmetic — and therefore the CGST/SGST vs IGST split — is decided by these
 * values. They are not ours to invent.
 *
 * Idempotent, like `roles`: UPSERT on the primary key so a re-seed corrects a
 * renamed state rather than failing on the unique `name`. Rows are never
 * deleted here — an address or an invoice may still reference a superseded
 * code, and `onDelete: 'restrict'` would rightly refuse to let history rot.
 */

type State = { code: string; name: string; isUnionTerr: boolean };

/**
 * Codes 25 (Daman and Diu) and 28 (undivided Andhra Pradesh) are deliberately
 * absent: both were superseded — 25 merged into 26 in 2020, and 28 became 37
 * when Telangana was formed — and reissuing them would collide with the unique
 * `name` constraint on their successors.
 */
const STATES: readonly State[] = [
  { code: '01', name: 'Jammu and Kashmir', isUnionTerr: true },
  { code: '02', name: 'Himachal Pradesh', isUnionTerr: false },
  { code: '03', name: 'Punjab', isUnionTerr: false },
  { code: '04', name: 'Chandigarh', isUnionTerr: true },
  { code: '05', name: 'Uttarakhand', isUnionTerr: false },
  { code: '06', name: 'Haryana', isUnionTerr: false },
  { code: '07', name: 'Delhi', isUnionTerr: true },
  { code: '08', name: 'Rajasthan', isUnionTerr: false },
  { code: '09', name: 'Uttar Pradesh', isUnionTerr: false },
  { code: '10', name: 'Bihar', isUnionTerr: false },
  { code: '11', name: 'Sikkim', isUnionTerr: false },
  { code: '12', name: 'Arunachal Pradesh', isUnionTerr: false },
  { code: '13', name: 'Nagaland', isUnionTerr: false },
  { code: '14', name: 'Manipur', isUnionTerr: false },
  { code: '15', name: 'Mizoram', isUnionTerr: false },
  { code: '16', name: 'Tripura', isUnionTerr: false },
  { code: '17', name: 'Meghalaya', isUnionTerr: false },
  { code: '18', name: 'Assam', isUnionTerr: false },
  { code: '19', name: 'West Bengal', isUnionTerr: false },
  { code: '20', name: 'Jharkhand', isUnionTerr: false },
  { code: '21', name: 'Odisha', isUnionTerr: false },
  { code: '22', name: 'Chhattisgarh', isUnionTerr: false },
  { code: '23', name: 'Madhya Pradesh', isUnionTerr: false },
  { code: '24', name: 'Gujarat', isUnionTerr: false },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', isUnionTerr: true },
  { code: '27', name: 'Maharashtra', isUnionTerr: false },
  { code: '29', name: 'Karnataka', isUnionTerr: false },
  { code: '30', name: 'Goa', isUnionTerr: false },
  { code: '31', name: 'Lakshadweep', isUnionTerr: true },
  { code: '32', name: 'Kerala', isUnionTerr: false },
  { code: '33', name: 'Tamil Nadu', isUnionTerr: false },
  { code: '34', name: 'Puducherry', isUnionTerr: true },
  { code: '35', name: 'Andaman and Nicobar Islands', isUnionTerr: true },
  { code: '36', name: 'Telangana', isUnionTerr: false },
  { code: '37', name: 'Andhra Pradesh', isUnionTerr: false },
  { code: '38', name: 'Ladakh', isUnionTerr: true },
  // 97 and 99 are not geographies. They are required by GSTR filings: 97 covers
  // supplies to the exclusive economic zone, 99 is the Centre's own jurisdiction.
  { code: '97', name: 'Other Territory', isUnionTerr: true },
  { code: '99', name: 'Centre Jurisdiction', isUnionTerr: true },
] as const;

export async function seedGstStates(): Promise<{ upserted: number }> {
  for (const state of STATES) {
    /*
     * Raw parameterised SQL rather than the Drizzle table, matching `roles.ts`:
     * the seed must keep working during a migration that reshapes the schema
     * module.
     */
    await db.execute(sql`
      INSERT INTO gst_states (code, name, is_union_terr)
      VALUES (${state.code}, ${state.name}, ${state.isUnionTerr})
      ON CONFLICT (code) DO UPDATE
        SET name = EXCLUDED.name,
            is_union_terr = EXCLUDED.is_union_terr
    `);
  }

  return { upserted: STATES.length };
}

/** Exported for the test that guards against a duplicate or malformed code. */
export const GST_STATES = STATES;
