/// <reference types="node" />
// Unit tests run outside the extension: answer chrome.i18n from the Chinese catalog.
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(
  readFileSync(`${process.cwd()}/public/_locales/zh_CN/messages.json`, 'utf8'),
) as Record<string, { message: string }>;

(globalThis as unknown as { chrome: unknown }).chrome = {
  i18n: {
    getMessage: (key: string) => catalog[key]?.message ?? '',
    getUILanguage: () => 'zh-CN',
  },
};
