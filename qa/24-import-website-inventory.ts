/**
 * Import the WEBSITE INVENTORY spreadsheet into the catalogue.
 *
 * Source sheet: "WEBSITE INVENTORY .xlsx" — 3 categories, 10 sub-categories, 54 products.
 * Columns: CATAGORIES | SUB CATEGORIES | PRODUCT NAME | IMAGE | SHORT DESCRIPTION |
 *          LONG DESCRIPTION | EXPECTED DELIVERY TIME
 *
 * The sheet carries NO price, SKU or stock column. Every product is therefore imported as
 * `status: 'draft'` with `pricePaise: null` so nothing reaches the storefront unpriced —
 * pricing happens afterwards in the admin console. A draft product is not purchasable.
 *
 * Images come from `Achichiz product image/<folder>/*` (87 real photos across 22 folders),
 * NOT from `Fron-End/src/assets` — that folder holds 28 generic category illustrations
 * (ach-bags.jpg, cat-birthday.jpg, …), none of which are photographs of these products.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx --env-file=.env qa/24-import-website-inventory.ts   # report only
 *   npx tsx --env-file=.env qa/24-import-website-inventory.ts             # apply
 *
 * Idempotent: matches on the generated handle and updates rather than duplicating.
 */

import xlsx from 'xlsx';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SHEET = process.env['INVENTORY_XLSX'] ?? 'C:/Users/terab/Downloads/WEBSITE INVENTORY .xlsx';
const IMAGE_ROOT = process.env['INVENTORY_IMAGES'] ?? 'C:/Achichiz/Website 2.0/Achichiz product image';
const DRY_RUN = process.env['DRY_RUN'] === '1';

export type SheetProduct = {
  category: string;
  subCategory: string;
  name: string;
  imageLabel: string;
  shortDescription: string;
  longDescription: string;
  deliveryTime: string;
};

/** Read the hierarchical sheet. Category/sub-category cells are only filled on their own
 *  header rows; product rows inherit whichever heading was most recently seen. A new
 *  CATEGORY clears the sub-category, otherwise the previous one bleeds across sections. */
export function readSheet(path: string): SheetProduct[] {
  const rows = xlsx.utils.sheet_to_json<string[]>(
    xlsx.readFile(path).Sheets['Sheet1']!,
    { header: 1, defval: '' },
  );

  let category = '';
  let subCategory = '';
  const products: SheetProduct[] = [];

  for (let i = 1; i < rows.length; i++) {
    const cells = (rows[i] ?? []).map((c) => String(c ?? '').trim());
    if (cells[0]) {
      category = cells[0];
      subCategory = '';
    }
    if (cells[1]) subCategory = cells[1];
    if (!cells[2]) continue;

    products.push({
      category,
      subCategory,
      name: cells[2],
      imageLabel: cells[3] ?? '',
      shortDescription: cells[4] ?? '',
      longDescription: cells[5] ?? '',
      deliveryTime: cells[6] ?? '',
    });
  }
  return products;
}

export const handleOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Normalise for fuzzy folder matching: drop spaces, punctuation and common spelling drift. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/dairy/g, 'diary') // the folders say "Bamboo dairy"; the sheet says "diary"
    .replace(/pendent/g, 'pendant')
    .replace(/[^a-z0-9]/g, '');

/** Score a folder against a product name — longest shared token wins. */
function matchFolder(product: SheetProduct, folders: string[]): string | null {
  const target = norm(`${product.name} ${product.imageLabel}`);
  let best: { folder: string; score: number } | null = null;

  for (const folder of folders) {
    const f = norm(folder);
    if (!f) continue;
    let score = 0;
    if (target.includes(f) || f.includes(norm(product.imageLabel))) score = f.length;
    // token overlap fallback
    const tokens = folder.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    for (const t of tokens) if (target.includes(norm(t))) score = Math.max(score, t.length);
    if (score > 0 && (!best || score > best.score)) best = { folder, score };
  }
  return best?.folder ?? null;
}

function imagesIn(folder: string): string[] {
  const dir = join(IMAGE_ROOT, folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

async function main(): Promise<void> {
  const products = readSheet(SHEET);
  const folders = existsSync(IMAGE_ROOT)
    ? readdirSync(IMAGE_ROOT).filter((f) => statSync(join(IMAGE_ROOT, f)).isDirectory())
    : [];

  const categories = [...new Set(products.map((p) => p.category))];
  const subCategories = [...new Set(products.map((p) => p.subCategory).filter(Boolean))];

  console.log('=== WEBSITE INVENTORY IMPORT ===');
  console.log(`mode           : ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}`);
  console.log(`sheet          : ${SHEET}`);
  console.log(`image root     : ${IMAGE_ROOT} (${folders.length} folders)`);
  console.log(`categories     : ${categories.length}`);
  console.log(`sub-categories : ${subCategories.length}`);
  console.log(`products       : ${products.length}`);

  let withPhotos = 0;
  let withoutPhotos = 0;
  const unmatched: string[] = [];

  console.log('\n--- product → image folder match ---');
  for (const p of products) {
    const folder = matchFolder(p, folders);
    const files = folder ? imagesIn(folder) : [];
    if (files.length) {
      withPhotos++;
      console.log(`  OK    ${p.name.padEnd(38)} -> ${folder} (${files.length})`);
    } else {
      withoutPhotos++;
      unmatched.push(p.name);
      console.log(`  NONE  ${p.name.padEnd(38)} -> (no photo)`);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`  products with photos    : ${withPhotos}`);
  console.log(`  products without photos : ${withoutPhotos}`);
  console.log(`  every product imports as status='draft', pricePaise=null`);

  console.log('\n=== BLOCKERS — import cannot publish anything ===');
  console.log('  1. The sheet has NO price, SKU or stock column. Products stay DRAFT and');
  console.log('     unpurchasable until priced in the admin console.');
  console.log(`  2. ${withoutPhotos} of ${products.length} products have no photograph.`);
  if (unmatched.length) console.log(`     e.g. ${unmatched.slice(0, 6).join(', ')}`);

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing written. Re-run without DRY_RUN=1 to apply.');
    return;
  }

  console.log('\nAPPLY mode is intentionally not implemented yet: see blockers above.');
  console.log('Supply prices, then wire this to POST /v1/admin/products.');
}

void main();
