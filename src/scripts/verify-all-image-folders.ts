import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

const wb = XLSX.readFile('C:/Achichiz/WEBSITE INVENTORY  (1).xlsx');
const imageRoot = 'C:/Achichiz/40 KB compress image';

// Explicit overrides mapping product handle or normalized title to exact folder name
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
  'bamboo-diary': 'Bamboo Diary',
  'bamboo-keychain': 'Bamboo keychain',
  'cork-keychain': 'Cork Keychain',
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
  'bird_shaped_jhumka': 'Bird jhumka',
  'striped-jhumka-mini-black': 'Black yellow jhumki',
  'yellow-jhumka': 'yellow jhumka',
  'blue-danglers-black': 'Black & Blue earrings',
  'flower-dangle-(black-golden)': 'Black & golden earring',
  'dotted-danglers': 'Dotted Earrings',
  'green-silver-danglers': 'Green silver earring',
  'pink-danglers': 'pink dangles',
  'flower-drop-dangler-silver': 'silver earring 2.0',
  'silver-danglers': 'silver earring',
};

const sheetDirMap: Record<string, string> = {
  'JEWELLERY  COLLECTION ': 'jewellery collection',
  'WORKSPACE COLLECTION': 'Workspace collection',
  'EARTH & AROMA COLLECTION ': 'Earth and aroma collection',
};

let totalFound = 0;
let totalMissing = 0;

for (const [sheetName, dirName] of Object.entries(sheetDirMap)) {
  console.log(`\n=== Checking: ${sheetName} ===`);
  const ws = wb.Sheets[sheetName];
  if (!ws) continue;
  const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const colPath = path.join(imageRoot, dirName);

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (r && r[0] && r[0].toString().startsWith('NEW PRODUCT')) {
      let title = '';
      let handle = '';
      for (let j = i + 1; j < Math.min(i + 30, data.length); j++) {
        const row = data[j];
        if (row && row[1] === 'Title *') title = row[2]?.toString().trim() || '';
        if (row && row[1] === 'Handle *') handle = row[2]?.toString().trim().toLowerCase() || '';
      }

      const folderName = explicitFolderMap[handle] || explicitFolderMap[handle.replace(/\s+/g, '-')];
      if (folderName && fs.existsSync(path.join(colPath, folderName))) {
        const files = fs.readdirSync(path.join(colPath, folderName));
        console.log(`  ✓ 100% MATCH: [${handle}] "${title}" -> "${folderName}" (${files.length} images)`);
        totalFound++;
      } else {
        console.log(`  ✗ MISSING: [${handle}] "${title}" -> Folder: "${folderName}"`);
        totalMissing++;
      }
    }
  }
}

console.log(`\nTOTAL MATCHED: ${totalFound} / ${totalFound + totalMissing}`);
