import xlsx from 'xlsx';
import fs from 'fs';

const workbook = xlsx.readFile('inventory.xlsx');
const result: any = {};

for (const sheetName of workbook.SheetNames) {
  const sheet = workbook.Sheets[sheetName];
  result[sheetName] = xlsx.utils.sheet_to_json(sheet);
}

fs.writeFileSync('inventory_dump.json', JSON.stringify(result, null, 2));
console.log('Dumped inventory to inventory_dump.json');
