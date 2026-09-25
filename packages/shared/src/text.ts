/**
 * Words that mean true / false, shared by the page reader (to spot 对/错 option pairs) and the answer
 * normalizer (to read a model's boolean). Compared lowercased and trimmed.
 */
export const TRUE_WORDS: ReadonlySet<string> = new Set([
  '对',
  '正确',
  '是',
  '√',
  '✓',
  'true',
  't',
  'yes',
  'right',
]);
export const FALSE_WORDS: ReadonlySet<string> = new Set([
  '错',
  '错误',
  '否',
  '×',
  '✗',
  'false',
  'f',
  'no',
  'wrong',
]);

/** "(B)", "B.", "b、", "12)" … : an option label at the start of a string. */
const KEY_PREFIX = /^\s*[(（[]?\s*([A-Za-z]|\d{1,2})\s*[)）\].．、:：]\s*/;

/** Split "B. 4" into { key: "B", text: "4" }; null if there is no label. */
export function splitOptionKey(text: string): { key: string; text: string } | null {
  const m = KEY_PREFIX.exec(text);
  if (!m) return null;
  return { key: m[1]!.toUpperCase(), text: text.slice(m[0].length).trim() };
}
