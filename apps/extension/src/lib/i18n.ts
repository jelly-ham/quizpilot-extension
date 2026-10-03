/**
 * UI text from public/_locales (zh_CN, en, ja, ko; Chrome picks by browser language, English
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

export type UiLang = 'zh' | 'en' | 'ja' | 'ko';

/** The locale Chrome shows the extension in; also sent to the API for emails and checkout. */
export const uiLang = (): UiLang => {
  let lang: string;
  try {
    lang = chrome.i18n.getUILanguage();
  } catch {
    lang = navigator.language;
  }
  const base = lang.toLowerCase().slice(0, 2);
  return base === 'zh' || base === 'ja' || base === 'ko' ? base : 'en';
};

/** For the page's lang attribute. */
export const htmlLang = () => (uiLang() === 'zh' ? 'zh-CN' : uiLang());
