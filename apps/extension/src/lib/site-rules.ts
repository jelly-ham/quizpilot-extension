import type { SiteRule } from '../content/extract/rules';

/** Learned layouts, keyed by ruleKey() (host + number-free path). Local to this browser. */
interface StoredRule {
  rule: SiteRule;
  learnedAt: number;
}

const KEY = 'siteRules';

export async function getRules(): Promise<Record<string, SiteRule>> {
  const stored = ((await chrome.storage.local.get(KEY))[KEY] ?? {}) as Record<string, StoredRule>;
  return Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, v.rule]));
}

export async function saveRule(key: string, rule: SiteRule): Promise<void> {
  const stored = ((await chrome.storage.local.get(KEY))[KEY] ?? {}) as Record<string, StoredRule>;
  await chrome.storage.local.set({ [KEY]: { ...stored, [key]: { rule, learnedAt: Date.now() } } });
}

export async function forgetRule(key: string): Promise<void> {
  const stored = ((await chrome.storage.local.get(KEY))[KEY] ?? {}) as Record<string, StoredRule>;
  delete stored[key];
  await chrome.storage.local.set({ [KEY]: stored });
}
