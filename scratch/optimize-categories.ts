import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const TARGET_MIN = 31 * 1024; // 31,744 bytes (~31 KB)
const TARGET_MAX = 39.5 * 1024; // 40,448 bytes (< 40 KB)

const subcategories = [
  {
    name: 'subcat-bamboo-cork.webp',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/subcat_bamboo_cork_1789017494252.jpg',
    width: 600,
    height: 600,
  },
  {
    name: 'subcat-candles-aroma.webp',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/subcat_candles_aroma_1789017580185.jpg',
    width: 600,
    height: 600,
  },
  {
    name: 'subcat-necklaces-pendants.webp',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/subcat_necklaces_pendants_1789017601265.jpg',
    width: 600,
    height: 600,
  },
  {
    name: 'subcat-jhumkas-danglers.webp',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/subcat_jhumkas_danglers_1789017618675.jpg',
    width: 600,
    height: 600,
  },
  {
    name: 'subcat-temple-jewellery.webp',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/subcat_temple_jewellery_1789017642030.jpg',
    width: 600,
    height: 600,
  },
];

const categories = [
  {
    name: 'cat-bamboo-drinkware.webp',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/cat_bamboo_drinkware_1789017714681.jpg',
    width: 640,
    height: 800,
  },
  {
    name: 'cat-eco-stationery.webp',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/cat_eco_stationery_1789017734157.jpg',
    width: 640,
    height: 800,
  },
  {
    name: 'cat-jewellery.webp',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/cat_jewellery_1789017754510.jpg',
    width: 640,
    height: 800,
  },
  {
    name: 'cat-earth-aroma.webp',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/subcat_candles_aroma_1789017580185.jpg',
    width: 640,
    height: 800,
  },
  {
    name: 'cat-earrings.webp',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/subcat_jhumkas_danglers_1789017618675.jpg',
    width: 640,
    height: 800,
  },
  {
    name: 'cat-workspace.webp',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/subcat_bamboo_cork_1789017494252.jpg',
    width: 640,
    height: 800,
  },
];

async function compressImageTo3040Kb(src: string, width: number, height: number, outPath: string) {
  let bestBuffer: Buffer | null = null;
  let bestQ = 50;
  let closestDiff = Infinity;

  // Broad search from q = 4 to 98
  for (let q = 4; q <= 98; q++) {
    const buf = await sharp(src)
      .resize(width, height, { fit: 'cover', position: 'center' })
      .webp({ quality: q, effort: 4 })
      .toBuffer();

    if (buf.length >= TARGET_MIN && buf.length <= TARGET_MAX) {
      bestBuffer = buf;
      bestQ = q;
      break;
    }

    const diff = Math.abs(buf.length - 35 * 1024);
    if (buf.length <= TARGET_MAX && diff < closestDiff) {
      closestDiff = diff;
      bestBuffer = buf;
      bestQ = q;
    }
  }

  // If still below TARGET_MIN even at q=98, scale dimensions up slightly
  if (bestBuffer && bestBuffer.length < TARGET_MIN) {
    for (let scale = 1.1; scale <= 1.6; scale += 0.05) {
      const nw = Math.round(width * scale);
      const nh = Math.round(height * scale);
      for (let q = 30; q <= 95; q += 2) {
        const buf = await sharp(src)
          .resize(nw, nh, { fit: 'cover', position: 'center' })
          .webp({ quality: q, effort: 4 })
          .toBuffer();
        if (buf.length >= TARGET_MIN && buf.length <= TARGET_MAX) {
          bestBuffer = buf;
          bestQ = q;
          break;
        }
      }
      if (bestBuffer && bestBuffer.length >= TARGET_MIN && bestBuffer.length <= TARGET_MAX) break;
    }
  }

  if (!bestBuffer) {
    throw new Error(`Failed to compress ${src}`);
  }

  fs.writeFileSync(outPath, bestBuffer);
  const kb = (bestBuffer.length / 1024).toFixed(2);
  console.log(`✅ ${path.basename(outPath)}: ${kb} KB (${bestBuffer.length} bytes) [quality ${bestQ}]`);
  return { outPath, bytes: bestBuffer.length };
}

async function main() {
  const scratchSub = path.resolve('./scratch/optimized_subcategories');
  const scratchCat = path.resolve('./scratch/optimized_categories');
  if (!fs.existsSync(scratchSub)) fs.mkdirSync(scratchSub, { recursive: true });
  if (!fs.existsSync(scratchCat)) fs.mkdirSync(scratchCat, { recursive: true });

  const publicSub = path.resolve('../Fron-End/public/subcategories');
  const publicCat = path.resolve('../Fron-End/public/categories');
  if (!fs.existsSync(publicSub)) fs.mkdirSync(publicSub, { recursive: true });
  if (!fs.existsSync(publicCat)) fs.mkdirSync(publicCat, { recursive: true });

  console.log('--- COMPRESSING SUB-CATEGORIES (TARGET: 30–40 KB) ---');
  for (const item of subcategories) {
    const outPath = path.join(scratchSub, item.name);
    await compressImageTo3040Kb(item.src, item.width, item.height, outPath);
    fs.copyFileSync(outPath, path.join(publicSub, item.name));
  }

  console.log('\n--- COMPRESSING CATEGORIES (TARGET: 30–40 KB) ---');
  for (const item of categories) {
    const outPath = path.join(scratchCat, item.name);
    await compressImageTo3040Kb(item.src, item.width, item.height, outPath);
    fs.copyFileSync(outPath, path.join(publicCat, item.name));
  }

  console.log('\n🎉 ALL IMAGES OPTIMIZED AND SAVED LOCALLY IN FRON-END/PUBLIC!');
}

main().catch(console.error);
