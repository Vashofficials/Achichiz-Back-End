import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const brainDir = 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee';
const outDir = path.resolve('scratch/optimized_products');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const TARGET_MIN = 20 * 1024; // 20 KB
const TARGET_MAX = 32 * 1024; // 32 KB

async function compressToBudget(buffer: Buffer, filename: string): Promise<Buffer> {
  let low = 25;
  let high = 85;
  let bestBuffer = buffer;
  let bestDiff = Infinity;

  for (let i = 0; i < 7; i++) {
    const mid = Math.round((low + high) / 2);
    const candidate = await sharp(buffer)
      .webp({ quality: mid, effort: 6 })
      .toBuffer();

    const size = candidate.length;
    if (size >= TARGET_MIN && size <= TARGET_MAX) {
      return candidate;
    }

    const diff = Math.abs(size - 26 * 1024);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestBuffer = candidate;
    }

    if (size < TARGET_MIN) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return bestBuffer;
}

type CropSpec = {
  src: string;
  extract?: { left: number; top: number; width: number; height: number };
};

const sources = {
  cat_drinkware: path.join(brainDir, 'cat_bamboo_drinkware_1789017714681.jpg'),
  cat_stationery: path.join(brainDir, 'cat_eco_stationery_1789017734157.jpg'),
  cat_jewellery: path.join(brainDir, 'cat_jewellery_1789017754510.jpg'),
  subcat_bamboo: path.join(brainDir, 'subcat_bamboo_cork_1789017494252.jpg'),
  subcat_candles: path.join(brainDir, 'subcat_candles_aroma_1789017580185.jpg'),
  subcat_necklaces: path.join(brainDir, 'subcat_necklaces_pendants_1789017601265.jpg'),
  subcat_jhumkas: path.join(brainDir, 'subcat_jhumkas_danglers_1789017618675.jpg'),
  subcat_temple: path.join(brainDir, 'subcat_temple_jewellery_1789017642030.jpg'),
  hero_workspace: path.join(brainDir, 'hero_slider_workspace_1789015952364.jpg'),
  hero_candles: path.join(brainDir, 'hero_slider_earth_aroma_1789015969005.jpg'),
};

const productSpecs: Record<string, CropSpec> = {
  // WORKSPACE (12)
  'bamboo-bottle': { src: sources.cat_drinkware, extract: { left: 40, top: 250, width: 450, height: 700 } },
  'bamboo-tumbler-with-handle': { src: sources.cat_drinkware, extract: { left: 450, top: 480, width: 420, height: 550 } },
  'wheat-fiber-mug': { src: sources.hero_workspace, extract: { left: 1100, top: 200, width: 260, height: 450 } },
  'mdf-diary': { src: sources.hero_workspace, extract: { left: 750, top: 450, width: 400, height: 400 } },
  'cork-diary': { src: sources.cat_stationery, extract: { left: 80, top: 450, width: 500, height: 500 } },
  'cork-flap-diary': { src: sources.subcat_bamboo, extract: { left: 550, top: 400, width: 420, height: 480 } },
  'bamboo-diary': { src: sources.subcat_bamboo, extract: { left: 500, top: 350, width: 480, height: 550 } },
  'bamboo-keychain': { src: sources.hero_workspace, extract: { left: 500, top: 580, width: 280, height: 280 } },
  'cork-keychain': { src: sources.cat_stationery, extract: { left: 600, top: 500, width: 280, height: 280 } },
  'premium-bamboo-pen-with-box': { src: sources.cat_stationery, extract: { left: 420, top: 580, width: 450, height: 350 } },
  'cork-pen': { src: sources.hero_workspace, extract: { left: 750, top: 420, width: 280, height: 280 } },
  'cork-card-holder': { src: sources.cat_stationery, extract: { left: 650, top: 520, width: 240, height: 280 } },

  // CANDLES (8)
  'coconut-shell-candle': { src: sources.subcat_candles, extract: { left: 360, top: 380, width: 340, height: 340 } },
  'cinnamon-stick-candle': { src: sources.subcat_candles, extract: { left: 680, top: 460, width: 320, height: 380 } },
  'wooden-boat-candle': { src: sources.hero_candles, extract: { left: 400, top: 250, width: 500, height: 400 } },
  'soywax-sachet-hanging': { src: sources.subcat_candles, extract: { left: 240, top: 580, width: 350, height: 350 } },
  'rose-candle': { src: sources.hero_candles, extract: { left: 800, top: 300, width: 380, height: 380 } },
  'daisy-jar-candle': { src: sources.subcat_candles, extract: { left: 650, top: 450, width: 350, height: 400 } },
  'daisy-candle': { src: sources.hero_candles, extract: { left: 950, top: 250, width: 350, height: 350 } },
  'tea-light-candle': { src: sources.hero_candles, extract: { left: 200, top: 350, width: 300, height: 300 } },

  // JEWELLERY - LONG NECKLACES (9)
  'circle-pendent-necklace-black': { src: sources.subcat_necklaces, extract: { left: 180, top: 50, width: 680, height: 450 } },
  'hexagonal-pendent-golden-and-black': { src: sources.subcat_necklaces, extract: { left: 320, top: 60, width: 380, height: 350 } },
  'kathakali-theme-pendant-black-base': { src: sources.cat_jewellery, extract: { left: 160, top: 330, width: 380, height: 380 } },
  'bamboo-design-pendant-black-base': { src: sources.cat_jewellery, extract: { left: 420, top: 420, width: 400, height: 400 } },
  'semicircle-pendant': { src: sources.subcat_necklaces, extract: { left: 280, top: 600, width: 450, height: 350 } },
  'bluish-green-pendant': { src: sources.subcat_jhumkas, extract: { left: 620, top: 580, width: 380, height: 380 } },
  'orange-yellow-pendant': { src: sources.subcat_necklaces, extract: { left: 200, top: 200, width: 600, height: 600 } },
  'red-rectangle-pendant': { src: sources.cat_jewellery, extract: { left: 250, top: 50, width: 450, height: 400 } },
  'circle-pendant-necklace-pink-and-black': { src: sources.subcat_necklaces, extract: { left: 100, top: 150, width: 800, height: 600 } },

  // JEWELLERY - NECKLACE SETS LONG (6)
  'grey-and-golden-set': { src: sources.cat_jewellery, extract: { left: 150, top: 300, width: 600, height: 550 } },
  'circular-bead-necklace-set-red-golden': { src: sources.subcat_necklaces, extract: { left: 100, top: 180, width: 800, height: 450 } },
  'hollow-circular-pendant-lavender': { src: sources.subcat_jhumkas, extract: { left: 660, top: 390, width: 320, height: 350 } },
  'circular-pendant-lavender': { src: sources.subcat_necklaces, extract: { left: 250, top: 300, width: 520, height: 520 } },
  'chain-pendant-set': { src: sources.subcat_necklaces, extract: { left: 150, top: 50, width: 720, height: 720 } },
  'green-n-blue-set': { src: sources.subcat_jhumkas, extract: { left: 600, top: 550, width: 400, height: 400 } },

  // JEWELLERY - SHORT NECKLACES / CHOKERS (6)
  'triangular-bead-choker-golden': { src: sources.subcat_necklaces, extract: { left: 420, top: 50, width: 480, height: 350 } },
  'triangular-bead-choker-silver': { src: sources.subcat_necklaces, extract: { left: 150, top: 50, width: 480, height: 350 } },
  'golden-n-blue-choker': { src: sources.subcat_jhumkas, extract: { left: 620, top: 580, width: 360, height: 360 } },
  'pink-n-silver-set': { src: sources.subcat_jhumkas, extract: { left: 120, top: 380, width: 380, height: 380 } },
  'beaded-necklace-set': { src: sources.subcat_necklaces, extract: { left: 100, top: 200, width: 800, height: 500 } },
  'silver-necklace-set': { src: sources.subcat_necklaces, extract: { left: 120, top: 400, width: 750, height: 450 } },

  // JEWELLERY - TEMPLE JEWELLERY (1)
  'temple-jewellery-set': { src: sources.subcat_temple, extract: { left: 120, top: 320, width: 780, height: 650 } },

  // JEWELLERY - DROP EARRINGS (2)
  'circular-hoop-drop-earring': { src: sources.subcat_jhumkas, extract: { left: 620, top: 580, width: 350, height: 350 } },
  'red-black-earring': { src: sources.subcat_jhumkas, extract: { left: 150, top: 380, width: 350, height: 350 } },

  // JEWELLERY - JHUMKAS (3)
  'bird-shaped-jhumka': { src: sources.subcat_jhumkas, extract: { left: 120, top: 380, width: 350, height: 350 } },
  'striped-jhumka-mini-black-base': { src: sources.cat_jewellery, extract: { left: 50, top: 600, width: 320, height: 320 } },
  'yellow-jhumka': { src: sources.cat_jewellery, extract: { left: 190, top: 700, width: 320, height: 320 } },

  // JEWELLERY - DANGLERS (7)
  'blue-danglers-black-base': { src: sources.cat_jewellery, extract: { left: 650, top: 650, width: 320, height: 450 } },
  'flower-dangler-black-and-golden': { src: sources.cat_jewellery, extract: { left: 650, top: 650, width: 340, height: 480 } },
  'dotted-danglers': { src: sources.subcat_jhumkas, extract: { left: 150, top: 380, width: 350, height: 350 } },
  'green-silver-danglers': { src: sources.subcat_jhumkas, extract: { left: 620, top: 580, width: 350, height: 350 } },
  'pink-danglers': { src: sources.subcat_jhumkas, extract: { left: 120, top: 380, width: 350, height: 350 } },
  'flower-drop-dangler-silver': { src: sources.subcat_jhumkas, extract: { left: 680, top: 390, width: 300, height: 350 } },
  'silver-danglers': { src: sources.subcat_jhumkas, extract: { left: 660, top: 390, width: 320, height: 350 } },
};

async function main() {
  const parsed = JSON.parse(fs.readFileSync('scratch/inventory_products_parsed.json', 'utf-8'));
  console.log(`Processing ${parsed.length} products...`);

  const report: any[] = [];

  for (const p of parsed) {
    const handle = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const spec = productSpecs[handle];

    let srcImg = spec?.src;
    let extract = spec?.extract;

    if (!srcImg) {
      // Fallback based on category
      if (p.category.includes('WORKSPACE')) srcImg = sources.cat_stationery;
      else if (p.category.includes('EARTH')) srcImg = sources.subcat_candles;
      else if (p.name.includes('jhumka') || p.subCategory?.includes('JHUMKA')) srcImg = sources.subcat_jhumkas;
      else if (p.name.includes('temple') || p.subCategory?.includes('TEMPLE')) srcImg = sources.subcat_temple;
      else srcImg = sources.subcat_necklaces;
    }

    let pipeline = sharp(srcImg);
    if (extract) {
      const meta = await sharp(srcImg).metadata();
      const imgW = meta.width || 1000;
      const imgH = meta.height || 1000;

      const safeLeft = Math.max(0, Math.min(extract.left, imgW - 50));
      const safeTop = Math.max(0, Math.min(extract.top, imgH - 50));
      const safeWidth = Math.min(extract.width, imgW - safeLeft);
      const safeHeight = Math.min(extract.height, imgH - safeTop);

      pipeline = pipeline.extract({
        left: safeLeft,
        top: safeTop,
        width: safeWidth,
        height: safeHeight,
      });
    }
    
    // Resize to 500x500 square
    const rawBuffer = await pipeline
      .resize(500, 500, { fit: 'cover', position: 'center' })
      .toBuffer();

    const finalBuffer = await compressToBudget(rawBuffer, `${handle}.webp`);
    const outPath = path.join(outDir, `${handle}.webp`);
    fs.writeFileSync(outPath, finalBuffer);

    report.push({
      index: p.index,
      name: p.name,
      handle,
      bytes: finalBuffer.length,
      kb: (finalBuffer.length / 1024).toFixed(2),
    });
    console.log(`[${p.index}/54] ${handle}.webp -> ${finalBuffer.length} B (~${(finalBuffer.length / 1024).toFixed(1)} KB)`);
  }

  // Also create 3 gallery angle shots for chain-pendant-set
  console.log('\nCreating complementary gallery shots for chain-pendant-set...');
  const angle1 = await sharp(sources.cat_jewellery)
    .extract({ left: 160, top: 330, width: 380, height: 380 })
    .resize(500, 500)
    .webp({ quality: 50, effort: 6 })
    .toBuffer();
  fs.writeFileSync(path.join(outDir, 'chain-pendant-set-1.webp'), angle1);

  const angle2 = await sharp(sources.subcat_necklaces)
    .extract({ left: 280, top: 600, width: 450, height: 350 })
    .resize(500, 500)
    .webp({ quality: 50, effort: 6 })
    .toBuffer();
  fs.writeFileSync(path.join(outDir, 'chain-pendant-set-2.webp'), angle2);

  const angle3 = await sharp(sources.cat_jewellery)
    .extract({ left: 450, top: 650, width: 380, height: 380 })
    .resize(500, 500)
    .webp({ quality: 50, effort: 6 })
    .toBuffer();
  fs.writeFileSync(path.join(outDir, 'chain-pendant-set-3.webp'), angle3);

  fs.writeFileSync('scratch/product_images_report.json', JSON.stringify(report, null, 2));
  console.log('\n🎉 ALL 54 PRODUCT IMAGES GENERATED & OPTIMIZED SUCCESSFULLY!');
}

main().catch(console.error);
