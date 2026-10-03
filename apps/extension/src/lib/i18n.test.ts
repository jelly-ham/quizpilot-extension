/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from apps/extension.
const root = process.cwd();
const load = (loc: string) =>
  JSON.parse(readFileSync(join(root, `public/_locales/${loc}/messages.json`), 'utf8')) as Record<
    string,
    { message: string }
  >;
const zh = load('zh_CN');
const en = load('en');
const others = { en, ja: load('ja'), ko: load('ko') };
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f: string) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(f) && !f.endsWith('.test.ts') ? [p] : [];
  });
}

describe('locales', () => {
  it.each(Object.entries(others))('%s has the same keys and placeholders as zh_CN', (_, loc) => {
    expect(Object.keys(loc).sort()).toEqual(Object.keys(zh).sort());
    for (const k of Object.keys(zh))
      expect(placeholders(loc[k]!.message), k).toEqual(placeholders(zh[k]!.message));
  });

  it("every t('key') in the code exists", () => {
    const used = sources(join(root, 'src')).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/\bt\(\s*'(\w+)'/g)].map((m) => m[1]!),
    );
    expect(used.length).toBeGreaterThan(100);
    expect(used.filter((k) => !(k in zh))).toEqual([]);
  });
});
