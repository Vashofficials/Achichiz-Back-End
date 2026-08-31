import { sql } from 'drizzle-orm';
import { db } from '../../config/db.js';

/**
 * Layer-0 seed: `hsn_codes`, the tariff headings this catalogue actually sells
 * under.
 *
 * `products.hsn_code`, `add_ons.hsn_code`, `hamper_items.hsn_code` and
 * `gst_rates.hsn_code` all reference this table, and a CHECK constraint
 * (`product_active_needs_hsn`) refuses to let a product go active without one.
 * With the table empty, no product can be published at all — and there is no
 * admin API that manages HSN codes, so a seed is the only way in.
 *
 * ## Scope, deliberately narrow
 *
 * The published HSN schedule runs to thousands of headings. Shipping all of them
 * would be noise: this seeds only the four-digit headings that Achichiz's own
 * catalogue uses — bamboo and wooden articles, textiles, candles, confectionery,
 * ceramics, paper and packaging — plus the SAC for gift-wrapping as a service.
 *
 * Four digits is the correct granularity here: GST requires six or eight only
 * above a turnover threshold, and a four-digit heading remains valid as a prefix
 * if a finer code is added later.
 *
 * These are published codes, not invented ones. Rates are NOT set here — they
 * live in `gst_rates`, are time-bounded, and change by notification.
 *
 * Idempotent, like the other layer-0 seeds. Nothing is deleted: a product or an
 * invoice may still reference a heading that has since been superseded.
 */

type Hsn = { code: string; description: string; isService: boolean };

const CODES: readonly Hsn[] = [
  // Wood, bamboo and cane — the core of a sustainable gifting range.
  { code: '4419', description: 'Tableware and kitchenware of wood', isService: false },
  { code: '4420', description: 'Wood marquetry; caskets and cases for jewellery or cutlery', isService: false },
  { code: '4602', description: 'Basketwork and wickerwork made from plaiting materials, incl. bamboo', isService: false },
  { code: '1401', description: 'Vegetable plaiting materials, incl. bamboo and rattan', isService: false },

  // Textiles and soft goods.
  { code: '6302', description: 'Bed linen, table linen, toilet linen and kitchen linen', isService: false },
  { code: '6304', description: 'Other furnishing articles', isService: false },
  { code: '5607', description: 'Twine, cordage, ropes and cables of jute or other textile fibres', isService: false },

  // Home fragrance and decor.
  { code: '3406', description: 'Candles, tapers and the like', isService: false },
  { code: '3307', description: 'Preparations for perfuming or deodorising rooms', isService: false },
  { code: '6912', description: 'Ceramic tableware, kitchenware and other household articles', isService: false },
  { code: '7013', description: 'Glassware of a kind used for table, kitchen or indoor decoration', isService: false },

  // Edible gifting.
  { code: '1806', description: 'Chocolate and other food preparations containing cocoa', isService: false },
  { code: '2008', description: 'Fruit, nuts and other edible parts of plants, otherwise prepared', isService: false },
  { code: '0902', description: 'Tea, whether or not flavoured', isService: false },
  { code: '0901', description: 'Coffee, whether or not roasted or decaffeinated', isService: false },
  { code: '1704', description: 'Sugar confectionery not containing cocoa', isService: false },

  // Stationery, paper and the packaging a hamper ships in.
  { code: '4817', description: 'Envelopes, letter cards and correspondence cards of paper', isService: false },
  { code: '4820', description: 'Registers, notebooks, diaries and similar articles of paper', isService: false },
  { code: '4819', description: 'Cartons, boxes and cases of paper or paperboard', isService: false },
  { code: '4823', description: 'Other paper, paperboard and cellulose wadding, cut to size', isService: false },

  // Personal care and metal giftware.
  { code: '3401', description: 'Soap; organic surface-active products for washing the skin', isService: false },
  { code: '3304', description: 'Beauty, make-up and skin-care preparations', isService: false },
  { code: '7323', description: 'Table, kitchen or other household articles of iron or steel', isService: false },
  { code: '7418', description: 'Table, kitchen or other household articles of copper', isService: false },

  // Services. A SAC, not an HSN — the flag is what distinguishes them.
  { code: '9985', description: 'Support services, incl. gift wrapping and packing', isService: true },
  { code: '9989', description: 'Other manufacturing services, incl. personalisation and engraving', isService: true },
] as const;

export async function seedHsnCodes(): Promise<{ upserted: number }> {
  for (const hsn of CODES) {
    await db.execute(sql`
      INSERT INTO hsn_codes (code, description, is_service)
      VALUES (${hsn.code}, ${hsn.description}, ${hsn.isService})
      ON CONFLICT (code) DO UPDATE
        SET description = EXCLUDED.description,
            is_service = EXCLUDED.is_service
    `);
  }

  return { upserted: CODES.length };
}

/** Exported so a test can assert the codes are well-formed (4, 6 or 8 digits). */
export const HSN_CODES = CODES;
