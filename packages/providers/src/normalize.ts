import {
  FALSE_WORDS,
  splitOptionKey,
  TRUE_WORDS,
  type Answer,
  type Question,
} from '@quizpilot/shared';

/** Loosely-typed answer as a model returns it, before validation against the question. */
export interface RawAnswer {
  choice?: unknown;
  choices?: unknown;
  bool?: unknown;
  text?: unknown;
  confidence?: unknown;
}

export class InvalidAnswer extends Error {}

// Model replies also use y/n and 1/0; those are too ambiguous for spotting options on a page.
const TRUE_REPLIES = new Set([...TRUE_WORDS, 'y', '1']);
const FALSE_REPLIES = new Set([...FALSE_WORDS, 'n', '0']);

/** Validate a model's raw answer against the question and coerce it into an Answer. */
export function normalizeAnswer(q: Question, raw: RawAnswer, model: string): Answer {
  const confidence = toConfidence(raw.confidence);
  const base = {
    id: q.id,
    kind: q.kind,
    model,
    ...(confidence === undefined ? {} : { confidence }),
  };

  switch (q.kind) {
    case 'single': {
      const key = matchOption(
        q,
        raw.choice ?? (Array.isArray(raw.choices) ? raw.choices[0] : undefined),
      );
      return { ...base, choice: key };
    }
    case 'multi': {
      const list = Array.isArray(raw.choices)
        ? raw.choices
        : raw.choice !== undefined
          ? [raw.choice]
          : [];
      const keys = new Set(list.map((c) => matchOption(q, c)));
      if (keys.size === 0) throw new InvalidAnswer('no options chosen');
      // Keep page order so filling is predictable.
      return { ...base, choices: q.options!.map((o) => o.key).filter((k) => keys.has(k)) };
    }
    case 'judge':
      return { ...base, bool: toBool(raw.bool ?? raw.choice ?? raw.text) };
    case 'fill': {
      const texts = (Array.isArray(raw.text) ? raw.text : [raw.text]).map(toText);
      if (q.blanks !== undefined && texts.length !== q.blanks) {
        throw new InvalidAnswer(`expected ${q.blanks} blanks, got ${texts.length}`);
      }
      return { ...base, text: texts };
    }
    case 'essay': {
      const text = Array.isArray(raw.text) ? raw.text.map(toText).join('\n') : toText(raw.text);
      return { ...base, text };
    }
  }
}

function matchOption(q: Question, value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new InvalidAnswer('option must be a string');
  }
  const v = String(value).trim();
  const options = q.options ?? [];
  // Models sometimes answer "B." or "(B)" or "B. 4".
  const labelled = splitOptionKey(v)?.key;
  const byKey =
    options.find((o) => o.key === v) ??
    options.find((o) => o.key.toLowerCase() === v.toLowerCase()) ??
    (labelled ? options.find((o) => o.key.toUpperCase() === labelled) : undefined);
  if (byKey) return byKey.key;
  const byText = options.filter((o) => o.text.trim() === v);
  if (byText.length === 1) return byText[0]!.key;
  throw new InvalidAnswer(`"${v}" is not one of the options`);
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  if (TRUE_REPLIES.has(s)) return true;
  if (FALSE_REPLIES.has(s)) return false;
  throw new InvalidAnswer(`"${s}" is not a boolean`);
}

function toText(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  throw new InvalidAnswer('missing text');
}

function toConfidence(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}
