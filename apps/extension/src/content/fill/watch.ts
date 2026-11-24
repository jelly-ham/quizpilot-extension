import type { Answer, Verdict } from '@quizpilot/shared';
import type { Anchor } from '../extract/generic';
import { isChecked, wantedKeys } from './fill';

/**
 * Paid mode's answer records: after the extension fills a question (or, in assist mode, outlines
 * its suggestion), watch what the page ends up showing for it. When the user moves on, report
 * whether the answer stayed (kept), was replaced (changed) or emptied (cleared). Only this
 * verdict leaves the page, plus the chosen option keys when the user opted in to sharing.
 */

export interface WatchedVerdict {
  /** The question's id in this frame. */
  id: string;
  verdict: Verdict;
  picked?: string[];
}

/**
 * Options whose chosen state is only a class name (no input, no aria state). Sites style hover and
 * focus with the same classes (`active`, `on`), so such an option is not read while the pointer or
 * focus is on it.
 */
const classOnly = (el: Element) =>
  !(el instanceof HTMLInputElement) &&
  !el.hasAttribute('aria-checked') &&
  !el.hasAttribute('aria-selected') &&
  el.querySelectorAll('input[type=radio], input[type=checkbox]').length === 0;

const unsettled = (el: Element) => {
  try {
    return el.matches(':hover') || el.matches(':focus-within');
  } catch {
    return false;
  }
};

/**
 * What a question shows now: chosen option keys, or the text in its blanks. `before` (the keys
 * read last time) stands in for class-only options under the pointer or focus.
 */
export function shownAnswer(
  anchor: Anchor,
  before?: string[],
): { value: string; picked: string[]; empty: boolean } {
  if (anchor.type === 'choice') {
    const picked = anchor.options
      .filter((o) =>
        anchor.select
          ? (o.control as HTMLOptionElement).selected
          : before && classOnly(o.control) && unsettled(o.control)
            ? before.includes(o.key)
            : isChecked(o.control),
      )
      .map((o) => o.key);
    return { value: [...picked].sort().join(','), picked, empty: picked.length === 0 };
  }
  const values = anchor.blanks.map((el) =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : (el.textContent ?? ''),
  );
  return { value: values.join('\u0001'), picked: [], empty: values.every((v) => !v.trim()) };
}

/**
 * The question's text, to notice a page reusing the same controls for the next question. The
 * block's whole text when the stem sits inside it (no separate stem elements); a site adding
 * feedback there ("✓ 回答正确") then ends the watch early, with the answer shown at that point.
 */
const stemText = (anchor: Anchor) =>
  (anchor.stemEls.length ? anchor.stemEls : [anchor.block])
    .map((e) => e.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The option keys an answer suggests, as shownAnswer() would show them; null if none. */
export function suggested(answer: Answer, anchor: Anchor): string | null {
  if (anchor.type !== 'choice') return null;
  try {
    return [...wantedKeys(answer, anchor)].sort().join(',');
  } catch {
    return null;
  }
}

interface Item {
  anchor: Anchor;
  expected: string;
  stem: string;
  verdict: Verdict;
  picked: string[];
  /** The question left the page (or the page reused its controls for another question). */
  done: boolean;
}

/**
 * Longest a run's questions are watched, for pages that never unload or drop the questions;
 * whatever they show then is the verdict. Long enough for a long exam.
 */
export const WATCH_MS = 4 * 60 * 60_000;

export class AnswerWatch {
  private items = new Map<string, Item>();
  private sent = false;

  constructor(
    readonly runId: string,
    private readonly share: boolean,
    private readonly send: (verdicts: WatchedVerdict[]) => void,
    private readonly started = Date.now(),
  ) {}

  /**
   * Watch a question. `expected` is the answer it should show: the suggested option keys for
   * choice questions (so a page still settling after the fill isn't read as a change), and by
   * default what it shows now (blanks just filled).
   */
  add(id: string, anchor: Anchor, expected = shownAnswer(anchor).value) {
    this.items.set(id, {
      anchor,
      expected,
      stem: stemText(anchor),
      verdict: 'kept',
      // Read in full once; later reads fall back on it for options under the pointer.
      picked: shownAnswer(anchor).picked,
      done: false,
    });
    this.update(this.items.get(id)!);
  }

  get size() {
    return this.items.size;
  }

  private update(item: Item) {
    if (item.done) return;
    // Gone, or the same controls now show another question: keep the last verdict seen.
    if (!item.anchor.block.isConnected || stemText(item.anchor) !== item.stem) {
      item.done = true;
      return;
    }
    const now = shownAnswer(item.anchor, item.picked);
    item.verdict = now.value === item.expected ? 'kept' : now.empty ? 'cleared' : 'changed';
    item.picked = now.picked;
  }

  /** Re-reads every question. True once there is nothing left to watch. */
  check(now = Date.now()): boolean {
    for (const item of this.items.values()) this.update(item);
    return now - this.started > WATCH_MS || [...this.items.values()].every((i) => i.done);
  }

  /** Stops without reporting (the user undid the fill). */
  discard() {
    this.sent = true;
  }

  /** Reports the verdicts once. */
  flush() {
    if (this.sent || this.items.size === 0) return;
    this.sent = true;
    this.send(
      [...this.items].map(([id, i]) => ({
        id,
        verdict: i.verdict,
        ...(this.share && i.anchor.type === 'choice' ? { picked: i.picked } : {}),
      })),
    );
  }
}
