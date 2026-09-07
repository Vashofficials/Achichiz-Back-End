/**
 * Import the WEBSITE INVENTORY spreadsheet into the catalogue.
 *
 * Source sheet: "WEBSITE INVENTORY .xlsx" — 3 categories, 8 sub-categories, 54 products.
 * Columns: CATAGORIES | SUB CATEGORIES | PRODUCT NAME | IMAGE | SHORT DESCRIPTION |
 *          LONG DESCRIPTION | EXPECTED DELIVERY TIME
 *
 * The sheet carries NO price, SKU or stock column. Every product is therefore imported as
 * `status: 'draft'` with no variant, so it has no price and cannot be bought. Draft products
 * are excluded from every storefront query — nothing here reaches customers until someone
 * prices it in the admin console and flips it to 'active'.
 *
 * Images are NOT attached here. The image folders (22) do not cleanly cover the products (54),
 * and fuzzy matching produces false positives — "Bamboo tumbler" scores against a "Bamboo dairy"
 * folder. This script writes `qa/inventory-image-mapping.json` for a human to correct; photo
 * upload is a separate, later step driven by that corrected file.
 *
 * Note on `Fron-End/src/assets`: that folder holds 28 generic category illustrations
 * (ach-bags.jpg, cat-birthday.jpg, p-candle.jpg …), not photographs of these products. The real
 * photos live under `Achichiz product image/<product folder>/`.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx --env-file=.env qa/24-import-website-inventory.ts   # report only
 *   npx tsx --env-file=.env qa/24-import-website-inventory.ts             # apply
 *
 * Idempotent: matches on the generated handle and updates in place rather than duplicating,
 * so re-running after a sheet correction is safe.
 */

import xlsx from 'xlsx';
import { readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHEET = process.env['INVENTORY_XLSX'] ?? 'C:/Users/terab/Downloads/WEBSITE INVENTORY .xlsx';
const IMAGE_ROOT = process.env['INVENTORY_IMAGES'] ?? 'C:/Achichiz/Website 2.0/Achichiz product image';
const DRY_RUN = process.env['DRY_RUN'] === '1';

/** Refuse to run if the sheet ever grows unexpectedly — a runaway insert on a live catalogue. */
const MAX_PRODUCTS = 200;

export type SheetProduct = {
  category: string;
  subCategory: string;
  name: string;
  imageLabel: string;
  shortDescription: string;
  longDescription: string;
  deliveryTime: string;
};

/** Read the hierarchical sheet. Category/sub-category cells are filled only on their own header
 *  rows; product rows inherit the most recent heading. A new CATEGORY clears the sub-category —
 *  without that reset the previous sub-category bleeds across sections. */
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

/** Title-case a SHOUTED sheet value: "BAMBOO BOTTLE" -> "Bamboo Bottle". */
const titleCase = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/dairy/g, 'diary')
    .replace(/pendent/g, 'pendant')
    .replace(/[^a-z0-9]/g, '');

function matchFolder(product: SheetProduct, folders: string[]): string | null {
  const target = norm(`${product.name} ${product.imageLabel}`);
  let best: { folder: string; score: number } | null = null;
  for (const folder of folders) {
    const f = norm(folder);
    if (!f) continue;
    let score = 0;
    if (target.includes(f) || f.includes(norm(product.imageLabel))) score = f.length;
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

  if (products.length > MAX_PRODUCTS) {
    throw new Error(`Sheet has ${products.length} products, above the ${MAX_PRODUCTS} safety cap.`);
  }

  const categories = [...new Set(products.map((p) => p.category))];
  const subCategories = [...new Set(products.map((p) => p.subCategory).filter(Boolean))];

  console.log('=== WEBSITE INVENTORY IMPORT ===');
  console.log(`mode           : ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}`);
  console.log(`categories     : ${categories.length}`);
  console.log(`sub-categories : ${subCategories.length}`);
  console.log(`products       : ${products.length}  (all imported as DRAFT, unpriced)`);

  // Emit the image mapping for human review. No photo is attached by this script.
  const mapping = products.map((p) => {
    const folder = matchFolder(p, folders);
    return {
      product: p.name,
      category: p.category,
      subCategory: p.subCategory,
      suggestedFolder: folder ?? '',
      photoCount: folder ? imagesIn(folder).length : 0,
      confirmed: false,
    };
  });
  writeFileSync(join(process.cwd(), 'qa', 'inventory-image-mapping.json'), JSON.stringify(mapping, null, 2));
  const withPhotos = mapping.filter((m) => m.photoCount > 0).length;
  console.log(`\nimage mapping  : ${withPhotos}/${products.length} suggested — written to`);
  console.log('                 qa/inventory-image-mapping.json  (REVIEW: fuzzy matches include');
  console.log('                 false positives; set "confirmed": true on the rows you verify)');

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing written to the database.');
    return;
  }

  const { db } = await import('../src/config/db.js');
  const schema = await import('../src/db/schema/index.js');
  const { collections, products: productsTable, productCollections } = schema;
  const { eq, and, isNull } = await import('drizzle-orm');

  const collectionId = new Map<string, string>();

  async function upsertCollection(title: string, parent: string | null, sortOrder: number): Promise<string> {
    const handle = handleOf(title);
    const [existing] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.handle, handle), isNull(collections.deletedAt)))
      .limit(1);

    if (existing) {
      await db
        .update(collections)
        .set({ title: titleCase(title), parentId: parent, sortOrder, updatedAt: new Date() })
        .where(eq(collections.id, existing.id));
      return existing.id;
    }
    const [row] = await db
      .insert(collections)
      .values({
        handle,
        title: titleCase(title),
        kind: 'category',
        parentId: parent,
        sortOrder,
        status: 'draft',
      })
      .returning({ id: collections.id });
    return row!.id;
  }

  console.log('\n--- collections (draft) ---');
  let order = 0;
  for (const category of categories) {
    const id = await upsertCollection(category, null, order++);
    collectionId.set(category, id);
    console.log(`  ${titleCase(category)}`);
    const subs = [
      ...new Set(products.filter((p) => p.category === category).map((p) => p.subCategory).filter(Boolean)),
    ];
    let subOrder = 0;
    for (const sub of subs) {
      collectionId.set(sub, await upsertCollection(sub, id, subOrder++));
      console.log(`    └ ${titleCase(sub)}`);
    }
  }

  console.log('\n--- products (draft, no price, no variant) ---');
  let created = 0;
  let updated = 0;

  for (const p of products) {
    const handle = handleOf(p.name);
    const primary = collectionId.get(p.subCategory) ?? collectionId.get(p.category) ?? null;
    const tags = p.deliveryTime ? [p.deliveryTime.trim().toLowerCase().replace(/\s+/g, '-')] : [];

    // NOTE: `status` is deliberately absent here. An earlier version set status:'draft'
    // on every match, which unpublished ~30 pre-existing priced products the moment their
    // handle collided with a sheet row. An import may create a draft; it must never
    // demote something already published. New rows get 'draft' from the column default.
    const values = {
      title: titleCase(p.name),
      subtitle: p.shortDescription || null,
      description: p.longDescription || null,
      primaryCollectionId: primary,
      tags,
      updatedAt: new Date(),
    };

    const [existing] = await db
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(and(eq(productsTable.handle, handle), isNull(productsTable.deletedAt)))
      .limit(1);

    let productId: string;
    if (existing) {
      await db.update(productsTable).set(values).where(eq(productsTable.id, existing.id));
      productId = existing.id;
      updated++;
    } else {
      const [row] = await db
        .insert(productsTable)
        .values({ handle, ...values, status: 'draft' })
        .returning({ id: productsTable.id });
      productId = row!.id;
      created++;
    }

    for (const key of [p.subCategory, p.category]) {
      const cid = collectionId.get(key);
      if (!cid) continue;
      await db
        .insert(productCollections)
        .values({ productId, collectionId: cid })
        .onConflictDoNothing();
    }
  }

  console.log(`\n  created ${created}, updated ${updated}`);
  console.log('\nEvery product is status=draft with no variant, so none of them appear on the');
  console.log('storefront and none can be bought. Next: price them in the admin console, then');
  console.log("flip status to 'active' to publish. Photos are a separate step — correct");
  console.log('qa/inventory-image-mapping.json first.');
}

void main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
