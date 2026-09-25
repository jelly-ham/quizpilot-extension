// Launch Playwright's Chromium, using user-level deps from ~/.local/chromium-libs if present.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

export function browserEnv() {
  const deps = process.env.QP_CHROMIUM_DEPS ?? join(homedir(), '.local/chromium-libs');
  const libs = join(deps, 'usr/lib/x86_64-linux-gnu');
  return existsSync(libs)
    ? { ...process.env, LD_LIBRARY_PATH: libs, FONTCONFIG_FILE: join(deps, 'fonts.conf') }
    : process.env;
}

export function launchChromium() {
  return chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    env: browserEnv(),
  });
}
