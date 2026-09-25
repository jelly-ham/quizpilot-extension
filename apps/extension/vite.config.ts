import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import { execSync } from 'node:child_process';
import { defineConfig, loadEnv } from 'vite';
import { createManifest } from './manifest.config.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiBase = env.VITE_API_BASE || 'http://localhost:8787';
  // Shown in chrome://extensions, the popup and debug logs, so a report says which build it came
  // from: VITE_BUILD (e.g. "dev.11") plus the commit.
  let commit = '';
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // not a git checkout
  }
  const build = [env.VITE_BUILD, commit].filter(Boolean).join(' ');
  return {
    plugins: [
      preact(),
      crx({
        manifest: createManifest(apiBase, {
          e2e: env.VITE_E2E === '1',
          store: env.VITE_STORE === '1',
          build,
        }),
      }),
    ],
    define: {
      'import.meta.env.VITE_API_BASE': JSON.stringify(apiBase),
    },
    server: {
      port: 5173,
      strictPort: true,
      cors: { origin: [/^chrome-extension:\/\//] },
    },
  };
});
