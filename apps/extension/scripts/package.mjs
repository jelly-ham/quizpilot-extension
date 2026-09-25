// Build and zip the extension for the Chrome Web Store.
//
//   VITE_API_BASE=https://api.example.com [VITE_GOOGLE_CLIENT_ID=...] pnpm package [--with-key]
//
// --with-key puts keys/extension-key.pem into the zip as key.pem. Only for the very first upload,
// so the store keeps the extension ID from extension-key.pub (see docs/STORE.md).
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '../..');
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const apiBase = process.env.VITE_API_BASE ?? '';
let api;
try {
  api = new URL(apiBase);
} catch {
  fail('set VITE_API_BASE to the production API, e.g. https://api.quizpilot.app');
}
if (api.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(api.hostname)) {
  fail(`VITE_API_BASE must be a public https URL, got ${apiBase}`);
}
if (!process.env.VITE_GOOGLE_CLIENT_ID)
  console.warn('! VITE_GOOGLE_CLIENT_ID not set: Google login will be hidden');

const dist = join(root, 'dist-store');
execSync(`pnpm exec vite build --outDir ${dist} --emptyOutDir`, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_STORE: '1', VITE_E2E: '' },
});

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.key) fail('store manifest must not contain `key`');
if (manifest.host_permissions.some((p) => p === '<all_urls>'))
  fail('store manifest must not request <all_urls>');
if (!manifest.icons?.['128']) fail('manifest has no 128px icon');

// Unfilled 【…】 placeholders on the website (privacy policy, terms) block a real launch.
// (Only in the full repository: the open-source copy has no website.)
const webDir = join(repo, 'apps/web/public');
const placeholders = new Set();
for (const f of (existsSync(webDir) ? readdirSync(webDir, { recursive: true }) : [])
  .map(String)
  .filter((f) => f.endsWith('.html'))) {
  for (const m of readFileSync(join(webDir, f), 'utf8').matchAll(/【[^】]+】/g))
    placeholders.add(m[0]);
}
if (placeholders.size)
  console.warn(`! website still has placeholders: ${[...placeholders].join(' ')}`);

const files = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(dist, p)] = readFileSync(p);
  }
};
walk(dist);
if (process.argv.includes('--with-key')) {
  const pem = join(root, 'keys/extension-key.pem');
  if (!existsSync(pem)) fail('keys/extension-key.pem not found; run scripts/extension-key.mjs');
  files['key.pem'] = readFileSync(pem);
}

const outDir = join(repo, 'release');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `quizpilot-${manifest.version}.zip`);
writeFileSync(out, zipSync(files, { level: 9 }));
console.log(
  `✓ ${relative(repo, out)} (${Object.keys(files).length} files, ${(statSync(out).size / 1024).toFixed(0)} KB)`,
);
console.log(`  api: ${api.origin} · permissions: ${manifest.permissions.join(', ')}`);
