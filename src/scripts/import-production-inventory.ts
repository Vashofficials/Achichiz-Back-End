import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { db } from '../config/db.js';
import {
  products,
  productVariants,
  collections,
  productCollections,
  productMedia,
  mediaAssets,
  inventoryLevels,
  warehouses,
  designers,
} from '../db/schema/index.js';
import { env } from '../config/env.js';
import { eq } from 'drizzle-orm';

const s3Client = new S3Client({
  region: env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
  },
  endpoint: env.S3_ENDPOINT || undefined,
  forcePathStyle: !!env.S3_ENDPOINT,
});

const imageRoot = 'C:\\Achichiz\\40 KB compress image';
const excelPath = 'C:\\Achichiz\\WEBSITE INVENTORY  (1).xlsx';

// Explicit mapping from raw handle or title to exact folder name in 40 KB compress image
const explicitFolderMap: Record<string, string> = {
  // Earth & aroma
  'coconute-shellrose-candle': 'coconut shell rose candle',
  'cinnamon-stick-candle': 'Cinnamon Stick candle',
  'wooden-boat-candle': 'Wooden Boat Candle',
  'soy-wax-hanging-sachet': 'Sachet Hanging Wax',
  'rose-shape-candle': 'Rose shape candle',
  'rose-candle': 'Rose shape candle',
  'daisy-jar-candle': 'Daisy Jar Candle',
  'daisy-candle': 'Daisy Candle',
  'tea-light-candle': 'Tea Light Candle',

  // Workspace
  'bamboo-bottle': 'Bamboo bottle',
  'bamboo-tumbler-handle': 'Bamboo Tumble',
  'wheat-fiber-mug': 'Wheat fiber mug',
  'mdf-diary': 'MDF Diary',
  'cork-diary': 'Cork Diary',
  'cork-flap-diary': 'Cork Flap diary',
  'bomboo-diary': 'Bamboo Diary',
  'bamboo-diary': 'Bamboo Diary',
  'bomboo-kaychain': 'Bamboo keychain',
  'bamboo-keychain': 'Bamboo keychain',
  'cork-keychain': 'Cork Keychain',
  'premium-bomboopen-box': 'Premium bamboo pen with box',
  'premium-bamboo-pen-box': 'Premium bamboo pen with box',
  'cork-pen': 'Cork Pen',
  'cork-card-holder': 'Cork Cardholder',

  // Jewellery
  'circle-pendent-necklace-black': 'Black Circle necklace',
  'hexagonal-pendent-golden&black': 'Hexagon pendent',
  'kathakkali-theme-pendent-blackbase': 'Black long necklace',
  'bamboo-desing-pendent-blackbase': 'Black bamboo pendent',
  'semicircle-pendent': 'Black Semicicle pendent',
  'bluish-green-pendent': 'Bluish green necklace',
  'orange-yellow-pendent': 'sunshine yellow pendne t',
  'red-rectangle-pendent': 'Red Square pendent',
  'circle-pendent-necklace-pink&black': 'pink circle pendent',
  'grey-and-golden-set': 'silver grey necklace',
  'circular-bead-necklace-set-golden': 'Red long necklace',
  'hollow-circular-pendent-lavender': 'lavender golden set',
  'circular-pendent-lavender': 'Necklace set lavender',
  'chain-pendent-set': 'Black chained pendent',
  'green-blue-set': 'green golden blue necklace',
  'tringular-bead-choker-golden': 'golden triangular necklace',
  'tringular-bead-choker-silver': 'silver triangluar bead',
  'golden-blue-choker': 'Golden & Blue bead necklace',
  'pink-silver-set': 'pink silver set',
  'beaded-necklace-set': 'pink necklace set',
  'silver-necklace-set': 'silver necklace',
  'temple-jewellery-set': 'green & golden necklace',
  'circular-hoop-drop-earring': 'Floral Earrings daisy',
  'red-&-black-earring': 'Red & black earring',
  'red-and-black-earring': 'Red & black earring',
  'bird_shaped_jhumka': 'Bird jhumka',
  'striped-jhumka-mini-black': 'Black yellow jhumki',
  'yellow-jhumka': 'yellow jhumka',
  'blue-danglers-black': 'Black & Blue earrings',
  'flower-dangle-(black-golden)': 'Black & golden earring',
  'flower-dangle-(black-golden': 'Black & golden earring',
  'dotted-danglers': 'Dotted Earrings',
  'green-silver-danglers': 'Green silver earring',
  'pink-danglers': 'pink dangles',
  'flower-drop-dangler-silver': 'silver earring 2.0',
  'silver-danglers': 'silver earring',
};

// Map subcategory text in sheets to collection handles
const subcatHandleMap: Record<string, string> = {
  'ALL BAMBOO PRODUCT (Workspace Collection)': 'all-bamboo-product-workspace-collection',
  'ALL CANDLE PRODUCT (EARTH & AROMA COLLECTION )': 'all-candle-product-earth-aroma-collection',
  'NECKLACES (LONG)': 'necklaces-long',
  'NECKLACE SET LONG': 'necklace-set-long',
  'SHORT NECKLACE SET': 'short-necklace-set',
  'TEMPLE JEWELLERY': 'temple-jewellery',
  'DROP EARRING': 'drop-earring',
  'JHUMKAS': 'jhumkas',
  'DANGLERS': 'danglers',
};

// Best sellers list from Sheet5
const bestSellersKeywords = [
  'bamboo bottle',
  'cork diary',
  'daisy jar candle',
  'daisy jar cande',
  'green silver earrings',
  'green silver danglers',
  'black & gold chain pendent',
  'chain pendent set',
];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parsePaise(priceStr: string | number | undefined): number {
  if (priceStr == null) return 0;
  if (typeof priceStr === 'number') return Math.round(priceStr * 100);
  const match = priceStr.toString().match(/(?:₹\s*)?([0-9]+(?:\.[0-9]+)?)/);
  if (!match || !match[1]) return 0;
  const val = parseFloat(match[1]);
  return isNaN(val) ? 0 : Math.round(val * 100);
}

async function uploadImageToS3(storageKey: string, fileBuffer: Buffer, contentType: string): Promise<string> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: storageKey,
      Body: fileBuffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000',
    })
  );

  return env.S3_PUBLIC_BASE_URL
    ? `${env.S3_PUBLIC_BASE_URL}/${storageKey}`
    : `https://${env.S3_BUCKET}.s3.${env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${storageKey}`;
}

async function main() {
  console.log('=== STARTING PRODUCTION INVENTORY IMPORT ===\n');

  const wb = XLSX.readFile(excelPath);

  // 1. Get Core Database IDs
  console.log('Fetching database reference IDs...');
  const [designerRow] = await db
    .select({ id: designers.id })
    .from(designers)
    .where(eq(designers.handle, 'achichiz'));
  const achichizDesignerId = designerRow?.id;
  console.log(`  Designer (Achichiz): ${achichizDesignerId}`);

  const [warehouseRow] = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(eq(warehouses.code, 'WH-MAIN'));
  const mainWarehouseId = warehouseRow?.id;
  console.log(`  Warehouse (WH-MAIN): ${mainWarehouseId}`);

  const allCols = await db.select().from(collections);
  const colHandleMap = new Map<string, string>();
  for (const c of allCols) {
    colHandleMap.set(c.handle, c.id);
  }
  console.log(`  Loaded ${colHandleMap.size} collections.`);

  const sheetsToProcess = [
    {
      sheetName: 'WORKSPACE COLLECTION',
      dirName: 'Workspace collection',
      parentHandle: 'workspace-collection',
      defaultSubcatHandle: 'all-bamboo-product-workspace-collection',
    },
    {
      sheetName: 'EARTH & AROMA COLLECTION ',
      dirName: 'Earth and aroma collection',
      parentHandle: 'earth-aroma-collection',
      defaultSubcatHandle: 'all-candle-product-earth-aroma-collection',
    },
    {
      sheetName: 'JEWELLERY  COLLECTION ',
      dirName: 'jewellery collection',
      parentHandle: 'jewellery-collection',
      defaultSubcatHandle: 'necklaces-long',
    },
  ];

  let totalProductsImported = 0;
  let totalImagesImported = 0;

  for (const item of sheetsToProcess) {
    console.log(`\n================== PROCESSING: ${item.sheetName} ==================`);
    const ws = wb.Sheets[item.sheetName];
    if (!ws) continue;
    const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

    const colDirPath = path.join(imageRoot, item.dirName);
    const existingFolders = fs.readdirSync(colDirPath);

    let currentSubcatName = '';

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (!row || row.length === 0) continue;

      // Track subcategory headers
      if (row.length === 1 && !row[0].toString().startsWith('NEW PRODUCT') && !row[0].toString().startsWith('NEW VARIANT') && row[0] !== item.sheetName.trim()) {
        currentSubcatName = row[0].toString().trim();
      }

      if (row[0] && row[0].toString().startsWith('NEW PRODUCT')) {
        const rawProdHeader = row[0].toString();
        let handle = '';
        let title = '';
        let subtitle = '';
        let description = '';
        let careNote = '';
        let deliveryNote = '';
        let tagsRaw = '';
        let sku = '';
        let pricePaise = 0;
        let compareAtPaise: number | null = null;
        let optionLabel = 'Standard';
        let optionValue = 'standard';

        for (let j = i + 1; j < Math.min(i + 45, data.length); j++) {
          const fieldRow = data[j];
          if (!fieldRow || fieldRow.length < 2) continue;
          if (fieldRow[0] && fieldRow[0].toString().startsWith('NEW PRODUCT') && j !== i) break;

          const fName = (fieldRow[1] || '').toString().trim();
          const fVal = fieldRow[2];

          if (fName === 'Handle *') handle = (fVal || '').toString().trim();
          if (fName === 'Title *') title = (fVal || '').toString().trim();
          if (fName === 'Subtitle') subtitle = (fVal || '').toString().trim();
          if (fName === 'Description') description = (fVal || '').toString().trim();
          if (fName === 'Packaging / care note') careNote = (fVal || '').toString().trim();
          if (fName === 'Delivery note') deliveryNote = (fVal || '').toString().trim();
          if (fName === 'Tags') tagsRaw = (fVal || '').toString().trim();
          if (fName === 'SKU *') sku = (fVal || '').toString().trim();
          if (fName === 'Option label *') optionLabel = (fVal || 'Standard').toString().trim();
          if (fName === 'Option value *') optionValue = (fVal || 'standard').toString().trim();
          if (fName === 'Price *') pricePaise = parsePaise(fVal);
          if (fName === 'Compare-at price') {
            const comp = parsePaise(fVal);
            if (comp > pricePaise) compareAtPaise = comp;
          }
        }

        if (!title) {
          title = rawProdHeader.replace(/^NEW PRODUCT\s*—\s*/i, '').trim();
        }

        const rawHandleKey = handle.toLowerCase();
        const cleanHandle = slugify(handle || title);

        // Specific overrides
        if (cleanHandle === 'temple-jewellery-set') {
          sku = 'ACH-TERR-TMP-NKL-022';
        } else if (cleanHandle === 'daisy-jar-candle') {
          pricePaise = 14900;
          compareAtPaise = 17200;
          optionLabel = 'Pack of 2';
          optionValue = 'pack-of-2';
        }

        // Determine HSN code
        let hsnCode = '7117';
        if (item.sheetName.includes('EARTH')) {
          hsnCode = '3406';
        } else if (item.sheetName.includes('WORKSPACE')) {
          if (cleanHandle.includes('diary')) hsnCode = '4820';
          else if (cleanHandle.includes('pen') || cleanHandle.includes('card') || cleanHandle.includes('keychain')) hsnCode = '4420';
          else hsnCode = '4419';
        }

        // Parse tags
        const tags = tagsRaw
          ? tagsRaw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
          : ['sustainable', 'achichiz'];

        // Determine leaf subcategory
        let subcatHandle = subcatHandleMap[currentSubcatName] || item.defaultSubcatHandle;
        const parentColId = colHandleMap.get(item.parentHandle);
        const subcatColId = colHandleMap.get(subcatHandle) || parentColId;

        // Check if Best Seller
        const isBestSeller = bestSellersKeywords.some((k) =>
          title.toLowerCase().includes(k) || cleanHandle.includes(k.replace(/\s+/g, '-'))
        );

        if (!sku || sku === 'Not available from image') {
          sku = `ACH-${cleanHandle.toUpperCase().slice(0, 12)}-001`;
        }

        console.log(`\nImporting Product #${totalProductsImported + 1}: "${title}" [${cleanHandle}]`);

        // Insert Product
        const [prodRow] = await db
          .insert(products)
          .values({
            handle: cleanHandle,
            title,
            subtitle: subtitle || null,
            description: description || null,
            careNote: careNote || null,
            deliveryNote: deliveryNote || null,
            kind: 'single_gift',
            designerId: achichizDesignerId,
            primaryCollectionId: subcatColId || parentColId || null,
            hsnCode,
            isPersonalisable: false,
            isPerishable: false,
            isFragile: cleanHandle.includes('mug') || cleanHandle.includes('candle'),
            requiresShipping: true,
            lowStockThreshold: 10,
            badgeOverride: isBestSeller ? 'best_seller' : 'none',
            tags,
            status: 'active',
            publishedAt: new Date(),
          })
          .returning();

        if (!prodRow) throw new Error(`Failed to insert product: ${title}`);

        // Insert Variants
        if (cleanHandle === 'tea-light-candle') {
          const [v1] = await db.insert(productVariants).values({
            productId: prodRow.id,
            sku: 'ACH-TEAL-CND-PK6-008',
            optionLabel: 'Pack of 6',
            optionValue: 'pack-of-6',
            pricePaise: 4900,
            compareAtPaise: 6000,
            isDefault: true,
            position: 0,
            status: 'active',
          }).returning();
          if (v1 && mainWarehouseId) {
            await db.insert(inventoryLevels).values({ variantId: v1.id, warehouseId: mainWarehouseId, onHandQty: 50, reservedQty: 0 });
          }

          const [v2] = await db.insert(productVariants).values({
            productId: prodRow.id,
            sku: 'ACH-TEAL-CND-PK12-008',
            optionLabel: 'Pack of 12',
            optionValue: 'pack-of-12',
            pricePaise: 9900,
            compareAtPaise: 11000,
            isDefault: false,
            position: 1,
            status: 'active',
          }).returning();
          if (v2 && mainWarehouseId) {
            await db.insert(inventoryLevels).values({ variantId: v2.id, warehouseId: mainWarehouseId, onHandQty: 50, reservedQty: 0 });
          }
        } else if (cleanHandle === 'daisy-candle') {
          const [v1] = await db.insert(productVariants).values({
            productId: prodRow.id,
            sku: 'ACH-DAIS-CND-SGL-007',
            optionLabel: 'Single Piece',
            optionValue: 'single-piece',
            pricePaise: 3000,
            compareAtPaise: 3500,
            isDefault: true,
            position: 0,
            status: 'active',
          }).returning();
          if (v1 && mainWarehouseId) {
            await db.insert(inventoryLevels).values({ variantId: v1.id, warehouseId: mainWarehouseId, onHandQty: 50, reservedQty: 0 });
          }

          const [v2] = await db.insert(productVariants).values({
            productId: prodRow.id,
            sku: 'ACH-DAIS-CND-PK6-007',
            optionLabel: 'Pack of 6',
            optionValue: 'pack-of-6',
            pricePaise: 14900,
            compareAtPaise: 17500,
            isDefault: false,
            position: 1,
            status: 'active',
          }).returning();
          if (v2 && mainWarehouseId) {
            await db.insert(inventoryLevels).values({ variantId: v2.id, warehouseId: mainWarehouseId, onHandQty: 50, reservedQty: 0 });
          }

          const [v3] = await db.insert(productVariants).values({
            productId: prodRow.id,
            sku: 'ACH-DAIS-CND-PK12-007',
            optionLabel: 'Pack of 12',
            optionValue: 'pack-of-12',
            pricePaise: 20000,
            compareAtPaise: 23000,
            isDefault: false,
            position: 2,
            status: 'active',
          }).returning();
          if (v3 && mainWarehouseId) {
            await db.insert(inventoryLevels).values({ variantId: v3.id, warehouseId: mainWarehouseId, onHandQty: 50, reservedQty: 0 });
          }
        } else {
          const [variantRow] = await db
            .insert(productVariants)
            .values({
              productId: prodRow.id,
              sku,
              optionLabel: optionLabel || 'Standard',
              optionValue: slugify(optionValue || 'standard'),
              pricePaise,
              compareAtPaise,
              isDefault: true,
              position: 0,
              status: 'active',
            })
            .returning();

          if (variantRow && mainWarehouseId) {
            await db.insert(inventoryLevels).values({
              variantId: variantRow.id,
              warehouseId: mainWarehouseId,
              onHandQty: 50,
              reservedQty: 0,
            });
          }
        }

        // Link Collections
        if (parentColId) {
          await db
            .insert(productCollections)
            .values({ productId: prodRow.id, collectionId: parentColId, position: totalProductsImported })
            .onConflictDoNothing();
        }
        if (subcatColId && subcatColId !== parentColId) {
          await db
            .insert(productCollections)
            .values({ productId: prodRow.id, collectionId: subcatColId, position: totalProductsImported })
            .onConflictDoNothing();
        }
        if (isBestSeller) {
          const bestSellerColId = colHandleMap.get('best-sellers');
          if (bestSellerColId) {
            await db
              .insert(productCollections)
              .values({ productId: prodRow.id, collectionId: bestSellerColId, position: totalProductsImported })
              .onConflictDoNothing();
          }
        }

        // Upload and link product images
        let matchedFolder = explicitFolderMap[rawHandleKey] || explicitFolderMap[cleanHandle];
        if (!matchedFolder) {
          matchedFolder = existingFolders.find(
            (f) =>
              f.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanHandle.replace(/[^a-z0-9]/g, '') ||
              f.toLowerCase().includes(title.toLowerCase().slice(0, 10))
          );
        }

        if (matchedFolder && fs.existsSync(path.join(colDirPath, matchedFolder))) {
          const folderFiles = fs.readdirSync(path.join(colDirPath, matchedFolder));
          const imgFiles = folderFiles.filter((f) => /\.(jpe?g|png|webp)$/i.test(f));

          imgFiles.sort((a, b) => {
            const aIsPrimary = /primary/i.test(a) ? -1 : 1;
            const bIsPrimary = /primary/i.test(b) ? -1 : 1;
            return aIsPrimary - bIsPrimary;
          });

          for (let pos = 0; pos < imgFiles.length; pos++) {
            const imgFilename = imgFiles[pos];
            if (!imgFilename) continue;
            const imgFilePath = path.join(colDirPath, matchedFolder, imgFilename);
            const fileBuf = fs.readFileSync(imgFilePath);
            const ext = path.extname(imgFilename).toLowerCase();
            const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
            const s3StorageKey = `products/${cleanHandle}/${pos}-${imgFilename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

            const s3Url = await uploadImageToS3(s3StorageKey, fileBuf, mimeType);

            const [mediaAsset] = await db
              .insert(mediaAssets)
              .values({
                storageKey: s3StorageKey,
                url: s3Url,
                cdnUrl: s3Url,
                filename: imgFilename,
                mimeType,
                kind: 'image',
                bytes: fileBuf.length,
                folder: 'products',
              })
              .returning();

            if (mediaAsset) {
              await db.insert(productMedia).values({
                productId: prodRow.id,
                mediaId: mediaAsset.id,
                position: pos,
                altText: `${title} - Image ${pos + 1}`,
              });
            }

            totalImagesImported++;
          }
        }

        totalProductsImported++;
      }
    }
  }

  console.log(`\n=== IMPORT COMPLETE: ${totalProductsImported} PRODUCTS & ${totalImagesImported} IMAGES IMPORTED ===\n`);
}

main()
  .catch((err) => {
    console.error('Fatal import error:', err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
