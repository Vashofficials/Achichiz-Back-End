import puppeteer from 'puppeteer';
import path from 'path';

async function main() {
  console.log('Launching browser to test http://localhost:8080 ...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error('[BROWSER ERROR]', msg.text());
    }
  });

  console.log('Navigating to http://localhost:8080 ...');
  await page.goto('http://localhost:8080', { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for hero carousel section
  console.log('Waiting for hero slider element...');
  await page.waitForSelector('section[aria-label="Featured gifting collections"]', { timeout: 15000 });

  // Extract slide information
  const slideInfo = await page.evaluate(() => {
    const section = document.querySelector('section[aria-label="Featured gifting collections"]');
    if (!section) return null;
    const slides = Array.from(section.querySelectorAll('.relative.h-\\[62vh\\] > div, .relative.h-\\[76vh\\] > div, [aria-roledescription="carousel"] img'));
    const titles = Array.from(section.querySelectorAll('h1, p.font-display')).map(el => el.textContent?.trim());
    const subtitles = Array.from(section.querySelectorAll('p.eyebrow')).map(el => el.textContent?.trim());
    const buttons = Array.from(section.querySelectorAll('a, button')).filter(b => b.textContent?.trim() && !b.getAttribute('aria-label')?.includes('slide')).map(b => ({
      text: b.textContent?.trim(),
      href: b.getAttribute('href'),
    }));
    const images = Array.from(section.querySelectorAll('img')).map(img => ({
      src: img.src,
      alt: img.alt,
    }));
    return { titles, subtitles, buttons, images };
  });

  console.log('Hero Slider Info:', JSON.stringify(slideInfo, null, 2));

  // Take screenshot of Slide 1
  const screenshotPath1 = path.resolve('./scratch/slide1_rendered.png');
  await page.screenshot({ path: screenshotPath1, clip: { x: 0, y: 0, width: 1440, height: 800 } });
  console.log('Saved slide 1 screenshot to:', screenshotPath1);

  // Click next slide button
  const nextBtn = await page.$('button[aria-label="Next slide"]');
  if (nextBtn) {
    console.log('Clicking Next slide button...');
    await nextBtn.click();
    await new Promise(r => setTimeout(r, 1200)); // wait for transition
    const screenshotPath2 = path.resolve('./scratch/slide2_rendered.png');
    await page.screenshot({ path: screenshotPath2, clip: { x: 0, y: 0, width: 1440, height: 800 } });
    console.log('Saved slide 2 screenshot to:', screenshotPath2);
  }

  await browser.close();
  console.log('Verification completed successfully!');
}

main().catch(console.error);
