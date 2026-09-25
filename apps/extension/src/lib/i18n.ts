/**
 * UI text from public/_locales (zh_CN and en; Chrome picks by browser language, English
 * otherwise). `{name}` placeholders are filled from `params`. A missing entry shows its key, and
 * i18n.test.ts checks every key used in the code exists in both languages.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let text = '';
  try {
    text = chrome.i18n.getMessage(key);
  } catch {
    // Orphaned content script after an extension update: chrome.* is gone.
  }
  text ||= key;
  return params
    ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
    : text;
}

/** For the page's lang attribute and number formatting. */
export const uiLang = (): 'zh' | 'en' => {
  try {
    return chrome.i18n.getUILanguage().toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
};
