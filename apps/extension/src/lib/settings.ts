import { ProviderSetup } from '@quizpilot/providers';

/** Free tier: user's own keys, called directly from the extension. Paid tier: credits via our API. */
export type Mode = 'byok' | 'paid';

export interface Settings {
  mode: Mode;
  /** Re-check low-confidence choice answers with the text model. */
  allowEscalation: boolean;
  /** Human pacing: pauses between questions and typed text, in page and continuous mode. */
  humanize: boolean;
  /** Record each step of a run for bug reports (see lib/debug.ts). */
  debug: boolean;
  /** BYOK providers and routing. Keys stay in chrome.storage.local on this device. */
  byok: ProviderSetup;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'byok',
  allowEscalation: false,
  humanize: true,
  debug: false,
  byok: { providers: [], routing: {} },
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // A hand-edited or outdated BYOK blob must not break the extension; fall back to empty.
  const byok = ProviderSetup.safeParse(merged.byok);
  return { ...merged, byok: byok.success ? byok.data : DEFAULT_SETTINGS.byok };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
