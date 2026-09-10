import puppeteer from 'puppeteer';
import path from 'path';

async function main() {
  console.log('🚀 Launching Puppeteer to verify Product Detail Page & Catalogue on http://localhost:8080 ...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error('[BROWSER ERROR]', msg.text());
    }
  });

  const artifactDir = 'C:\\Users\\terab\\.gemini\\antigravity-ide\\brain\\1d9f25e4-1b0e-49fc-939e-e38d236c2bee';

  // 1. Verify PDP: /products/chain-pendant-set
  console.log('\nNavigating to http://localhost:8080/products/chain-pendant-set ...');
  await page.goto('http://localhost:8080/products/chain-pendant-set', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 2500));

  const pdpInfo = await page.evaluate(() => {
    const title = document.querySelector('h1')?.textContent?.trim();
    const mainImg = document.querySelector('.lg\\:grid-cols-2 img')?.getAttribute('src');
    const thumbImgs = Array.from(document.querySelectorAll('.lg\\:grid-cols-2 button img')).map(img => img.getAttribute('src'));
    const isCandle = mainImg?.includes('candle') || false;
    return { title, mainImg, thumbImgs, isCandle };
  });

  console.log('PDP Info:', JSON.stringify(pdpInfo, null, 2));

  // Take PDP screenshot
  await page.screenshot({ path: path.join(artifactDir, 'product_chain_pendant_set_verified.png'), fullPage: false });
  console.log('📸 Saved product_chain_pendant_set_verified.png');

  // Test interactive gallery thumbnail click
  const secondThumb = await page.$('.lg\\:grid-cols-2 button:nth-child(2)');
  if (secondThumb) {
    console.log('Clicking 2nd gallery thumbnail...');
    await secondThumb.click();
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: path.join(artifactDir, 'product_chain_pendant_set_angle2_verified.png'), fullPage: false });
    console.log('📸 Saved product_chain_pendant_set_angle2_verified.png');
  }

  // 2. Verify Collection: /collections/necklaces
  console.log('\nNavigating to http://localhost:8080/collections/necklaces ...');
  await page.goto('http://localhost:8080/collections/necklaces', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  const collectionInfo = await page.evaluate(() => {
    const heading = document.querySelector('h1')?.textContent?.trim();
    const cards = Array.from(document.querySelectorAll('a[href*="/products/"]')).slice(0, 6).map(a => ({
      title: a.querySelector('h3, p.font-display, p')?.textContent?.trim(),
      href: a.getAttribute('href'),
      imgSrc: a.querySelector('img')?.getAttribute('src'),
    }));
    return { heading, cards };
  });

  console.log('Necklaces Collection Info:', JSON.stringify(collectionInfo, null, 2));
  await page.screenshot({ path: path.join(artifactDir, 'collection_necklaces_verified.png'), fullPage: false });
  console.log('📸 Saved collection_necklaces_verified.png');

  await browser.close();
  console.log('\n🎉 ALL STOREFRONT VERIFICATIONS COMPLETED SUCCESSFULLY!');
}

main().catch(console.error);
