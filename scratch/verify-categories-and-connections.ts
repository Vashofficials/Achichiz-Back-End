import puppeteer from 'puppeteer';
import path from 'path';

async function main() {
  console.log('🚀 Launching Puppeteer to test http://localhost:8080 ...');
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

  console.log('Navigating to http://localhost:8080 ...');
  await page.goto('http://localhost:8080', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  // 1. Verify Hero Slider
  console.log('Checking Hero Slider...');
  await page.waitForSelector('section[aria-label="Featured gifting collections"]', { timeout: 15000 });
  
  // 2. Verify Shop by Category section
  console.log('Checking Shop by Category section...');
  const categoryCards = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h2'));
    const catHeading = headings.find(h => h.textContent?.includes('Shop by Category'));
    if (!catHeading) return null;
    const section = catHeading.closest('section');
    if (!section) return null;
    return Array.from(section.querySelectorAll('a')).map(a => ({
      title: a.querySelector('p')?.textContent?.trim(),
      href: a.getAttribute('href'),
      imgSrc: a.querySelector('img')?.getAttribute('src'),
      imgAlt: a.querySelector('img')?.getAttribute('alt'),
    }));
  });
  console.log('Shop by Category Cards:', JSON.stringify(categoryCards, null, 2));

  // 3. Verify Treasured Connections (Sub-Categories) section
  console.log('Checking Treasured Connections (Sub-Categories)...');
  const subCategoryTiles = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h2'));
    const connHeading = headings.find(h => h.textContent?.includes('Treasured Connections'));
    if (!connHeading) return null;
    const section = connHeading.closest('section');
    if (!section) return null;
    return Array.from(section.querySelectorAll('a')).map(a => ({
      label: a.querySelector('p')?.textContent?.trim(),
      href: a.getAttribute('href'),
      imgSrc: a.querySelector('img')?.getAttribute('src'),
      imgAlt: a.querySelector('img')?.getAttribute('alt'),
    }));
  });
  console.log('Sub-Category Tiles:', JSON.stringify(subCategoryTiles, null, 2));

  // 4. Verify Our Collections section
  console.log('Checking Our Collections section...');
  const ourCollectionsCards = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h2'));
    const colHeading = headings.find(h => h.textContent?.includes('Four collections'));
    if (!colHeading) return null;
    const section = colHeading.closest('section');
    if (!section) return null;
    return Array.from(section.querySelectorAll('a')).map(a => ({
      name: a.querySelector('.font-display')?.textContent?.trim(),
      copy: a.querySelector('.text-ink-foreground\\/70')?.textContent?.trim(),
      href: a.getAttribute('href'),
      imgSrc: a.querySelector('img')?.getAttribute('src'),
    }));
  });
  console.log('Our Collections Cards:', JSON.stringify(ourCollectionsCards, null, 2));

  // Take Screenshots
  const artifactDir = 'C:\\Users\\terab\\.gemini\\antigravity-ide\\brain\\1d9f25e4-1b0e-49fc-939e-e38d236c2bee';

  // Screenshot 1: Hero Carousel
  const heroSection = await page.$('section[aria-label="Featured gifting collections"]');
  if (heroSection) {
    await heroSection.screenshot({ path: path.join(artifactDir, 'homepage_hero_slider_verified.png') });
    console.log('📸 Saved homepage_hero_slider_verified.png');
  }

  // Screenshot 2: Shop by Category
  const catSectionHandle = await page.evaluateHandle(() => {
    const headings = Array.from(document.querySelectorAll('h2'));
    const h = headings.find(el => el.textContent?.includes('Shop by Category'));
    return h ? h.closest('section') : null;
  });
  if (catSectionHandle.asElement()) {
    await catSectionHandle.asElement()!.screenshot({ path: path.join(artifactDir, 'shop_by_category_verified.png') });
    console.log('📸 Saved shop_by_category_verified.png');
  }

  // Screenshot 3: Treasured Connections (Sub-Categories)
  const connSectionHandle = await page.evaluateHandle(() => {
    const headings = Array.from(document.querySelectorAll('h2'));
    const h = headings.find(el => el.textContent?.includes('Treasured Connections'));
    return h ? h.closest('section') : null;
  });
  if (connSectionHandle.asElement()) {
    await connSectionHandle.asElement()!.screenshot({ path: path.join(artifactDir, 'treasured_connections_subcategories_verified.png') });
    console.log('📸 Saved treasured_connections_subcategories_verified.png');
  }

  // Screenshot 4: Our Collections
  const ourColSectionHandle = await page.evaluateHandle(() => {
    const headings = Array.from(document.querySelectorAll('h2'));
    const h = headings.find(el => el.textContent?.includes('Four collections'));
    return h ? h.closest('section') : null;
  });
  if (ourColSectionHandle.asElement()) {
    await ourColSectionHandle.asElement()!.screenshot({ path: path.join(artifactDir, 'our_collections_categories_verified.png') });
    console.log('📸 Saved our_collections_categories_verified.png');
  }

  await browser.close();
  console.log('🎉 Verification and screenshot capture completed successfully!');
}

main().catch(console.error);
