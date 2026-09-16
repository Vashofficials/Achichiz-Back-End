import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

const wb = XLSX.readFile('C:/Achichiz/WEBSITE INVENTORY  (1).xlsx');
const imageRoot = 'C:/Achichiz/40 KB compress image';

const sheetDirMap: Record<string, string> = {
  'JEWELLERY  COLLECTION ': 'jewellery collection',
  'WORKSPACE COLLECTION': 'Workspace collection',
  'EARTH & AROMA COLLECTION ': 'Earth and aroma collection',
};

for (const [sheetName, dirName] of Object.entries(sheetDirMap)) {
  console.log(`\n================== ${sheetName} -> ${dirName} ==================`);
  const ws = wb.Sheets[sheetName];
  if (!ws) continue;
  const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  
  const colPath = path.join(imageRoot, dirName);
  const existingFolders = fs.readdirSync(colPath);

  // Extract products from sheet
  const prods: { title: string; handle: string; sku: string; price: string }[] = [];
  let currentProd: any = null;

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (!r || r.length === 0) continue;

    if (r[0] && r[0].toString().startsWith('NEW PRODUCT')) {
      if (currentProd) prods.push(currentProd);
      currentProd = { raw: r[0], title: '', handle: '', sku: '', price: '' };
    } else if (currentProd) {
      if (r[1] === 'Handle *') currentProd.handle = r[2];
      if (r[1] === 'Title *') currentProd.title = r[2];
      if (r[1] === 'SKU *') currentProd.sku = r[2];
      if (r[1] === 'Price *') currentProd.price = r[2];
    }
  }
  if (currentProd) prods.push(currentProd);

  console.log(`Total products parsed: ${prods.length}`);

  // Try to match each product with an image folder
  for (const p of prods) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const pNorm = norm(p.title);
    
    // Find matching folder
    const match = existingFolders.find(f => {
      const fNorm = norm(f);
      return pNorm.includes(fNorm) || fNorm.includes(pNorm);
    });

    if (match) {
      const files = fs.readdirSync(path.join(colPath, match));
      console.log(`  ✓ MATCH: "${p.title}" -> "${match}" (${files.length} images)`);
    } else {
      console.log(`  ✗ NO MATCH: "${p.title}" (Handle: ${p.handle})`);
    }
  }
}
