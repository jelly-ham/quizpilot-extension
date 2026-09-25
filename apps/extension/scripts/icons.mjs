// Render assets/icon.svg into the PNG sizes the manifest needs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './chromium.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'assets/icon.svg'), 'utf8');
// Thicker strokes for the toolbar sizes.
const small = readFileSync(join(root, 'assets/icon-small.svg'), 'utf8');
const browser = await launchChromium();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${size <= 32 ? small : svg}`,
  );
  await page.screenshot({
    path: join(root, `public/icons/icon-${size}.png`),
    omitBackground: true,
  });
}
await browser.close();
console.log('icons written to public/icons/');
