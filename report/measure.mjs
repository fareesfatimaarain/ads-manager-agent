/** Reports which .page sections overflow a single A4 page under print emulation. */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'client-briefing.html');

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const executablePath = CANDIDATES.find((p) => existsSync(p));

const MM = 96 / 25.4;
const PRINT_W = Math.round((210 - 17 - 17) * MM); // 176mm
const PRINT_H = Math.round((297 - 19 - 16) * MM); // 262mm

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  pipe: true,
  args: ['--disable-gpu', '--no-first-run'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: PRINT_W, height: PRINT_H });
  await page.emulateMediaType('print');
  await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });

  const rows = await page.evaluate((limit) => {
    return [...document.querySelectorAll('.page')].map((el, i) => {
      const heading = el.querySelector('.sec-title, .cover-title');
      const label = heading ? heading.textContent.trim().replace(/\s+/g, ' ').slice(0, 42) : `page ${i}`;
      const num = el.querySelector('.sec-num');
      return {
        n: num ? num.textContent.trim() : '--',
        label,
        height: Math.round(el.getBoundingClientRect().height),
        over: Math.round(el.getBoundingClientRect().height - limit),
      };
    });
  }, PRINT_H);

  console.log(`Printable area: ${PRINT_W} x ${PRINT_H} px\n`);
  for (const r of rows) {
    const flag = r.over > 0 ? `OVERFLOW by ${r.over}px` : 'ok';
    console.log(`${r.n.padEnd(4)} ${r.label.padEnd(44)} ${String(r.height).padStart(5)}px  ${flag}`);
  }
} finally {
  await browser.close();
}
