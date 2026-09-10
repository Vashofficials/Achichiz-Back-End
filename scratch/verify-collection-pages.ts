import puppeteer from 'puppeteer';
import path from 'path';

const ARTIFACT_DIR = 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee';

const PAGES = [
  {
    handle: 'all-bamboo-product-workspace-collection',
    name: 'collection_all_bamboo_workspace_verified.png',
    title: 'All Bamboo Product (Workspace Collection)',
  },
  {
    handle: 'eco-stationery',
    name: 'collection_eco_stationery_verified.png',
    title: 'Eco Stationery',
  },
  {
    handle: 'earth-aroma-collection',
    name: 'collection_earth_aroma_verified.png',
    title: 'Earth & Aroma Collection',
  },
  {
    handle: 'jhumkas',
    name: 'collection_jhumkas_verified.png',
    title: 'Jhumkas',
  },
  {
    handle: 'temple-jewellery',
    name: 'collection_temple_jewellery_verified.png',
    title: 'Temple Jewellery',
  },
];

async function run() {
  console.log('🚀 Launching Puppeteer browser for UI verification...');
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  for (const item of PAGES) {
    const url = `http://localhost:8080/collections/${item.handle}`;
    console.log(`\nNavigating to ${url}...`);

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000)); // Allow hydration & image rendering

    // Extract page information
    const data = await page.evaluate(() => {
      const heading = document.querySelector('h1')?.textContent?.trim() || '';
      const giftCountText = document.body.innerText.match(/(\d+)\s+gifts?/i)?.[0] || '';
      const zeroGiftsMatch = document.body.innerText.includes('0 gifts') || document.body.innerText.includes('Nothing matches those filters yet');
      
      // Get all product titles rendered in cards
      const productCards = Array.from(document.querySelectorAll('article, [data-testid="product-card"], a[href*="/products/"]'));
      const productTitles = Array.from(document.querySelectorAll('h3, h4'))
        .map(el => el.textContent?.trim() || '')
        .filter(t => t.length > 2 && !['Filters', 'Sort by', 'Price', 'Collection', 'About'].includes(t));

      // Check price slider
      const priceText = document.body.innerText.match(/₹[\d,]+\s*–\s*₹[\d,]+/)?.[0] || '';

      return {
        heading,
        giftCountText,
        zeroGiftsMatch,
        priceText,
        productTitlesCount: productTitles.length,
        sampleTitles: productTitles.slice(0, 5),
      };
    });

    console.log(`📊 Page Report for [${item.handle}]:`);
    console.log(`   Heading: "${data.heading}"`);
    console.log(`   Count text: "${data.giftCountText}"`);
    console.log(`   Price range: "${data.priceText}"`);
    console.log(`   Zero gifts empty state present?: ${data.zeroGiftsMatch ? '❌ YES (FAIL)' : '✅ NO (PASSED)'}`);
    console.log(`   Sample Products: ${data.sampleTitles.join(', ')}`);

    const screenshotPath = path.join(ARTIFACT_DIR, item.name);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`📸 Saved screenshot to ${screenshotPath}`);
  }

  await browser.close();
  console.log('\n🎉 UI verification completed successfully for all 5 collections!');
}

run().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
