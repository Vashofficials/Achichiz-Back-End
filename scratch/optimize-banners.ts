import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const sources = [
  {
    id: 'workspace',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/hero_slider_workspace_1789015952364.jpg',
    outName: 'hero-slider-workspace.webp',
  },
  {
    id: 'earth-aroma',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/hero_slider_earth_aroma_1789015969005.jpg',
    outName: 'hero-slider-earth-aroma.webp',
  },
  {
    id: 'jewellery',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/hero_slider_jewellery_1789015986536.jpg',
    outName: 'hero-slider-jewellery.webp',
  },
  {
    id: 'gift-hampers',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/hero_slider_gift_hampers_1789016005883.jpg',
    outName: 'hero-slider-gift-hampers.webp',
  },
  {
    id: 'corporate',
    src: 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee/hero_slider_corporate_1789016022279.jpg',
    outName: 'hero-slider-corporate.webp',
  },
];

const TARGET_MIN_BYTES = 81 * 1024; // 82,944 bytes (~81 KB)
const TARGET_MAX_BYTES = 98 * 1024; // 100,352 bytes (< 98 KB)

async function compressToTarget(srcPath: string, outPath: string) {
  let bestBuffer: Buffer | null = null;
  let bestQ = 50;
  let closestDiff = Infinity;

  // Search through qualities from 25 to 95 to find the quality that fits inside 81-98 KB
  for (let q = 25; q <= 95; q++) {
    const buf = await sharp(srcPath)
      .resize(1920, 1080, { fit: 'cover' })
      .webp({ quality: q, effort: 4 })
      .toBuffer();

    if (buf.length >= TARGET_MIN_BYTES && buf.length <= TARGET_MAX_BYTES) {
      bestBuffer = buf;
      bestQ = q;
      break;
    }

    const diff = Math.abs(buf.length - 88 * 1024);
    if (buf.length <= TARGET_MAX_BYTES && diff < closestDiff) {
      closestDiff = diff;
      bestBuffer = buf;
      bestQ = q;
    }
  }

  if (!bestBuffer) {
    throw new Error(`Could not find suitable quality for ${srcPath}`);
  }

  fs.writeFileSync(outPath, bestBuffer);
  const kb = (bestBuffer.length / 1024).toFixed(2);
  console.log(`✅ ${path.basename(outPath)}: ${kb} KB (${bestBuffer.length} bytes) at quality ${bestQ}`);
  return { outPath, bytes: bestBuffer.length, quality: bestQ };
}

async function main() {
  const outputDir = path.resolve('./scratch/optimized_banners');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const publicBannersDir = path.resolve('../Fron-End/public/banners');
  if (!fs.existsSync(publicBannersDir)) fs.mkdirSync(publicBannersDir, { recursive: true });

  console.log(`Optimizing 5 banners targeting 81 KB – 98 KB (strictly under 100 KB)...`);
  for (const item of sources) {
    const outPath = path.join(outputDir, item.outName);
    const result = await compressToTarget(item.src, outPath);
    // Copy to Fron-End/public/banners
    fs.copyFileSync(outPath, path.join(publicBannersDir, item.outName));
  }
  console.log('All 5 banners successfully compressed and saved!');
}

main().catch(console.error);
