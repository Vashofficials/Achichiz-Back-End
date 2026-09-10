import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

async function main() {
  const dir = 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee';
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
  for (const f of files) {
    if (f.startsWith('cat_') || f.startsWith('hero_') || f.startsWith('subcat_')) {
      const meta = await sharp(path.join(dir, f)).metadata();
      console.log(f, `${meta.width}x${meta.height}`, meta.format);
    }
  }
}

main().catch(console.error);
