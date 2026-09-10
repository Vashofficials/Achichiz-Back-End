import xlsx from 'xlsx';
import fs from 'fs';

const filePath = fs.existsSync('inventory.xlsx') ? 'inventory.xlsx' : 'C:/Users/terab/Downloads/WEBSITE INVENTORY .xlsx';
const wb = xlsx.readFile(filePath);
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows: any[][] = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

let currentCat = '';
let currentSubCat = '';
const products: any[] = [];

for (let i = 1; i < rows.length; i++) {
  const [cat, subCat, prodName, img, shortDesc, longDesc, delivery] = rows[i];
  if (cat && String(cat).trim()) {
    currentCat = String(cat).trim();
    currentSubCat = '';
  }
  if (subCat && String(subCat).trim()) {
    currentSubCat = String(subCat).trim();
  }
  if (prodName && String(prodName).trim()) {
    products.push({
      index: products.length + 1,
      category: currentCat,
      subCategory: currentSubCat,
      name: String(prodName).trim(),
      shortDesc: String(shortDesc || '').trim(),
      longDesc: String(longDesc || '').trim(),
    });
  }
}

console.log(`Total valid products: ${products.length}`);
console.log('\n--- Products by Category & SubCategory ---');

const grouped: Record<string, any[]> = {};
for (const p of products) {
  const key = `${p.category} -> ${p.subCategory}`;
  if (!grouped[key]) grouped[key] = [];
  grouped[key].push(p);
}

for (const [group, prods] of Object.entries(grouped)) {
  console.log(`\n### ${group} (${prods.length} products):`);
  prods.forEach(p => {
    console.log(`  ${p.index}. ${p.name} | ${p.shortDesc.slice(0, 45)}...`);
  });
}

fs.writeFileSync('scratch/inventory_products_parsed.json', JSON.stringify(products, null, 2));
console.log('\nWrote scratch/inventory_products_parsed.json successfully.');
