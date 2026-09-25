import { defineManifest } from '@crxjs/vite-plugin';
import { existsSync, readFileSync } from 'node:fs';
import pkg from './package.json' with { type: 'json' };

const ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

/** Public key that pins the extension ID in dev builds (scripts/extension-key.mjs). */
function publicKey(): string | undefined {
  const path = new URL('./extension-key.pub', import.meta.url);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
}

export interface ManifestOptions {
  /** Grant <all_urls> so e2e screenshots work without a user gesture. */
  e2e?: boolean;
  /** Chrome Web Store upload: the store assigns the ID, so `key` is left out. */
  store?: boolean;
  /** Build label for version_name, e.g. "dev.11 0ab5580". */
  build?: string;
}

export function createManifest(apiBase: string, opts: ManifestOptions = {}) {
  const apiOrigin = new URL(apiBase).origin;
  const key = opts.store ? undefined : publicKey();
  return defineManifest({
    ...(key ? { key } : {}),
    manifest_version: 3,
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    // Chinese browsers get zh_CN; everyone else English.
    default_locale: 'en',
    version: pkg.version,
    ...(opts.build ? { version_name: `${pkg.version} (${opts.build})` } : {}),
    icons: ICONS,
    // AbortSignal.any in service workers.
    minimum_chrome_version: '116',
    action: {
      default_popup: 'src/popup/index.html',
      default_title: '__MSG_extName__',
      default_icon: ICONS,
    },
    options_page: 'src/options/index.html',
    background: {
      service_worker: 'src/background/worker.ts',
      type: 'module',
    },
    // activeTab covers the page the user invokes us on (scripting + screenshot) without
    // blanket host access. identity is for Google sign-in.
    permissions: ['storage', 'activeTab', 'scripting', 'contextMenus', 'identity'],
    // The e2e build also gets <all_urls> so screenshots work without a user gesture (activeTab).
    host_permissions: opts.e2e ? [`${apiOrigin}/*`, '<all_urls>'] : [`${apiOrigin}/*`],
    // Requested at runtime: BYOK model endpoints, and cross-origin quiz iframes.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // Chrome allows at most four suggested keys; the rest are bound at chrome://extensions/shortcuts.
    // Digits in popup order (1 solve, 2 assist, 3 continuous, 4 area): Option+Shift+letter types
    // characters on macOS and letter combos collided with system and IME shortcuts, so Macs get
    // Control+Shift. Chrome silently skips keys it reserves (Alt+Shift+A focuses inactive
    // dialogs), so check chrome.commands.getAll() after changing one.
    commands: {
      'solve-page': {
        suggested_key: { default: 'Alt+Shift+1', mac: 'MacCtrl+Shift+1' },
        description: '__MSG_solvePage__',
      },
      'solve-assist': {
        suggested_key: { default: 'Alt+Shift+2', mac: 'MacCtrl+Shift+2' },
        description: '__MSG_cmd_assist__',
      },
      'solve-auto': {
        suggested_key: { default: 'Alt+Shift+3', mac: 'MacCtrl+Shift+3' },
        description: '__MSG_cmd_auto__',
      },
      'solve-region': {
        suggested_key: { default: 'Alt+Shift+4', mac: 'MacCtrl+Shift+4' },
        description: '__MSG_solveRegion__',
      },
      'stop-run': {
        description: '__MSG_cmd_stop__',
      },
      'relearn-page': {
        description: '__MSG_relearnPage__',
      },
    },
  });
}
