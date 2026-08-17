/** Screenshots the running dashboard. Usage: node report/shot.mjs [tabIndex] [outName] */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const executablePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const tabIndex = Number(process.argv[2] ?? 0);
const outName = process.argv[3] ?? `dash-${tabIndex}.png`;
const dark = process.argv[4] === 'dark';

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  pipe: true,
  args: ['--disable-gpu', '--no-first-run'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100, deviceScaleFactor: 2 });
  if (dark) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  }
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });

  if (tabIndex > 0) {
    const tabs = await page.$$('[role="tab"]');
    await tabs[tabIndex]?.click();
    await new Promise((r) => setTimeout(r, 700));
  }
  // Let staggered reveals finish before capturing.
  await new Promise((r) => setTimeout(r, 700));

  const path = join(here, outName);
  await page.screenshot({ path, fullPage: true });
  console.log(`captured ${path}`);
} finally {
  await browser.close();
}
