import sharp from 'sharp';
import path from 'path';

async function testCrop() {
  const dir = 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee';
  const imgPath = path.join(dir, 'subcat_necklaces_pendants_1789017601265.jpg');
  
  // Crop center focus for chain pendant set
  const out1 = path.join(dir, 'test_chain_pendant_set.webp');
  await sharp(imgPath)
    .extract({ left: 150, top: 250, width: 720, height: 720 })
    .resize(600, 600)
    .webp({ quality: 78, effort: 6 })
    .toFile(out1);

  const meta1 = await sharp(out1).metadata();
  console.log('test_chain_pendant_set.webp size:', meta1.size, 'bytes');

  // Let's also crop from cat_jewellery
  const catJewelPath = path.join(dir, 'cat_jewellery_1789017754510.jpg');
  const out2 = path.join(dir, 'test_jewellery_crop2.webp');
  await sharp(catJewelPath)
    .extract({ left: 180, top: 400, width: 520, height: 520 })
    .resize(600, 600)
    .webp({ quality: 78, effort: 6 })
    .toFile(out2);

  const meta2 = await sharp(out2).metadata();
  console.log('test_jewellery_crop2.webp size:', meta2.size, 'bytes');
}

testCrop().catch(console.error);
