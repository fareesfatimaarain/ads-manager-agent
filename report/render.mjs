/**
 * Renders the client briefing to PDF.
 *
 *   node report/render.mjs
 *
 * Uses puppeteer-core against the locally installed Chrome or Edge, driven over a debugging
 * pipe. This is deliberately not `chrome --print-to-pdf`: that route hands the request to any
 * already-running browser session ("Opening in existing browser session"), which silently
 * produces no file, and it mishandles paths containing spaces.
 */
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'client-briefing.html');
const output = join(here, 'AI-Ad-Manager-Client-Briefing.pdf');

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chrome or Edge installation found.');
if (!existsSync(source)) throw new Error(`Source not found: ${source}`);

const footer = `
  <div style="width:100%;font-family:Georgia,serif;font-size:7.5pt;color:#8C8676;
              padding:0 17mm;display:flex;justify-content:space-between;align-items:center;">
    <span style="letter-spacing:.04em;">The AI Ad Manager &nbsp;&middot;&nbsp; Client Briefing</span>
    <span class="pageNumber" style="font-variant-numeric:tabular-nums;"></span>
  </div>`;

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  // A pipe rather than a port, so this never attaches to the user's running browser.
  pipe: true,
  args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'],
});

try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });
  // Ensure webfont/layout settling before measuring pages.
  await page.evaluateHandle('document.fonts.ready');

  await page.pdf({
    path: output,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: footer,
    margin: { top: '19mm', right: '17mm', bottom: '16mm', left: '17mm' },
    preferCSSPageSize: false,
  });

  const { size } = await stat(output);
  console.log(`Rendered : ${resolve(output)}`);
  console.log(`Size     : ${Math.round(size / 1024)} KB`);
} finally {
  await browser.close();
}
