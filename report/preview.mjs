/** Captures individual .page sections as PNGs under print emulation, for visual review. */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'client-briefing.html');
const outDir = join(here, '_preview');
mkdirSync(outDir, { recursive: true });

const executablePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const MM = 96 / 25.4;
const W = Math.round((210 - 34) * MM);
const H = Math.round((297 - 35) * MM);

const wanted = process.argv.slice(2).map(Number);

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  pipe: true,
  args: ['--disable-gpu', '--no-first-run'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
  await page.emulateMediaType('print');
  await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });

  const sections = await page.$$('.page');
  const targets = wanted.length ? wanted : sections.map((_, i) => i);

  for (const i of targets) {
    const el = sections[i];
    if (!el) continue;
    const file = join(outDir, `page-${String(i).padStart(2, '0')}.png`);
    await el.screenshot({ path: file });
    console.log(`captured ${file}`);
  }
} finally {
  await browser.close();
}
