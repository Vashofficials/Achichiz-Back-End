import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

async function testCompression() {
  const dir = 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee';
  const catJewelPath = path.join(dir, 'cat_jewellery_1789017754510.jpg');

  for (const q of [35, 45, 55, 65]) {
    const out = path.join(dir, `test_q${q}.webp`);
    await sharp(catJewelPath)
      .extract({ left: 180, top: 400, width: 520, height: 520 })
      .resize(550, 550)
      .webp({ quality: q, effort: 6 })
      .toFile(out);

    console.log(`Quality ${q}: ${fs.statSync(out).size} bytes (~${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
  }
}

testCompression().catch(console.error);
