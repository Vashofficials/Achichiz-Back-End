import puppeteer from 'puppeteer';
import path from 'path';

const ARTIFACT_DIR = 'C:/Users/terab/.gemini/antigravity-ide/brain/1d9f25e4-1b0e-49fc-939e-e38d236c2bee';

async function testMobile() {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.goto('http://localhost:8080', { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // Take screenshot of first slide
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'mobile_hero_slide_1.png') });
  console.log('Slide 1 screenshot saved.');

  // Click next indicator or dot to go to slide 2
  const dots = await page.$$('button[aria-label*="slide"], div[aria-roledescription="carousel"] button, .cursor-pointer');
  console.log(`Found ${dots.length} potential interactive slide buttons.`);

  // Evaluate slide switching directly
  for (let s = 1; s <= 5; s++) {
    await page.evaluate((index) => {
      // Find dots
      const allButtons = Array.from(document.querySelectorAll('button'));
      const dotButtons = allButtons.filter(b => b.getAttribute('aria-label')?.includes('Slide') || b.className.includes('rounded-full') || b.className.includes('h-1.5'));
      if (dotButtons[index - 1]) {
        dotButtons[index - 1].click();
      }
    }, s);
    await new Promise(r => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(ARTIFACT_DIR, `mobile_hero_slide_${s}.png`) });
    console.log(`Slide ${s} screenshot saved.`);
  }

  await browser.close();
}

testMobile().catch(console.error);
