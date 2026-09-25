import type { Answer } from '@quizpilot/shared';
import { optionForBool, type Anchor } from '../extract/generic';

export interface FillOptions {
  /** Pause between questions and type text one character at a time. */
  humanize: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export type FillOutcome = { id: string; ok: true } | { id: string; ok: false; reason: string };

/** Restores what fill() changed. */
export type Undo = () => void;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

export async function fillAnswers(
  items: { answer: Answer; anchor: Anchor }[],
  opts: FillOptions,
): Promise<{ outcomes: FillOutcome[]; undo: Undo }> {
  const sleep = opts.sleep ?? defaultSleep;
  const undos: Undo[] = [];
  const outcomes: FillOutcome[] = [];
  for (const [i, { answer, anchor }] of items.entries()) {
    if (opts.humanize && i > 0) await sleep(jitter(400, 1200));
    try {
      undos.push(snapshot(anchor));
      await fillOne(answer, anchor, opts, sleep);
      outcomes.push({ id: answer.id, ok: true });
    } catch (err) {
      outcomes.push({ id: answer.id, ok: false, reason: (err as Error).message });
    }
  }
  return { outcomes, undo: () => undos.reverse().forEach((u) => u()) };
}

async function fillOne(
  answer: Answer,
  anchor: Anchor,
  opts: FillOptions,
  sleep: (ms: number) => Promise<void>,
) {
  if (anchor.type === 'choice') {
    const wanted = wantedKeys(answer, anchor);
    if (anchor.select) {
      const opt = anchor.options.find((o) => o.key === wanted[0]);
      if (!opt) throw new Error('answer is not one of the options');
      setSelectValue(anchor.select, (opt.control as HTMLOptionElement).value);
      return;
    }
    for (const o of anchor.options) {
      const want = wanted.includes(o.key);
      if (isChecked(o.control) !== want && (want || anchor.control === 'checkbox')) {
        await toggle(o.control, want);
        if (opts.humanize) await sleep(jitter(80, 250));
      }
    }
    return;
  }

  const texts = Array.isArray(answer.text) ? answer.text : answer.text != null ? [answer.text] : [];
  if (texts.length === 0) throw new Error('answer has no text');
  for (const [i, el] of anchor.blanks.entries()) {
    const value = texts[i] ?? '';
    await setText(el, value, opts.humanize ? sleep : undefined);
  }
}

export function wantedKeys(answer: Answer, anchor: Extract<Anchor, { type: 'choice' }>): string[] {
  if (answer.choices) return answer.choices;
  if (answer.choice) return [answer.choice];
  if (answer.bool !== undefined) {
    const opt = optionForBool(anchor.options, answer.bool);
    if (!opt) throw new Error('cannot map true/false to an option');
    return [opt.key];
  }
  throw new Error('answer has no choice');
}

// ---------------------------------------------------------------- DOM writes

const SELECTED_CLASS =
  /(^|[\s_-])(active|selected|sel|checked|is-checked|is-active|is-selected|chosen|on)(\s|$)/i;

export function isChecked(el: Element): boolean {
  if (el instanceof HTMLInputElement) return el.checked;
  if (el.hasAttribute('aria-checked')) return el.getAttribute('aria-checked') === 'true';
  if (el.hasAttribute('aria-selected')) return el.getAttribute('aria-selected') === 'true';
  // Custom div options usually mark the chosen one with a class.
  return SELECTED_CLASS.test(el.getAttribute('class') ?? '');
}

async function toggle(el: Element, want: boolean) {
  if (el instanceof HTMLInputElement) {
    // A real click runs label handlers and framework listeners.
    el.click();
    if (el.checked !== want) {
      nativeSet(el, 'checked', want);
      dispatch(el, 'input');
      dispatch(el, 'change');
    }
    return;
  }
  // role=radio / role=checkbox custom widgets.
  press(el);
}

/** The event sequence of a mouse click, for widgets that listen to pointer/mouse events. */
export function press(el: Element) {
  const opts = { bubbles: true, cancelable: true, composed: true };
  const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  el.dispatchEvent(new Pointer('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new Pointer('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  (el as HTMLElement).click();
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  nativeSet(select, 'value', value);
  dispatch(select, 'input');
  dispatch(select, 'change');
}

async function setText(el: Element, value: string, typing?: (ms: number) => Promise<void>) {
  (el as HTMLElement).focus?.();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (typing) {
      nativeSet(el, 'value', '');
      for (const ch of value) {
        nativeSet(el, 'value', el.value + ch);
        dispatch(el, 'input');
        await typing(jitter(30, 90));
      }
    } else {
      nativeSet(el, 'value', value);
      dispatch(el, 'input');
    }
    dispatch(el, 'change');
    (el as HTMLElement).blur?.();
    return;
  }
  // contenteditable: go through the editing pipeline so rich editors notice.
  const doc = el.ownerDocument;
  const sel = doc.getSelection();
  const range = doc.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  const inserted =
    typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, value);
  if (!inserted || el.textContent !== value) {
    el.textContent = value;
    dispatch(el, 'input');
  }
}

/**
 * React / Vue track input values through the prototype setter; assigning `el.value` directly
 * is swallowed. Calling the native setter makes the framework see the change.
 */
function nativeSet(el: Element, prop: 'value' | 'checked', value: unknown) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, prop)?.set;
  if (setter) setter.call(el, value);
  else (el as unknown as Record<string, unknown>)[prop] = value;
}

function dispatch(el: Element, type: string) {
  el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
}

// ---------------------------------------------------------------- undo

function snapshot(anchor: Anchor): Undo {
  if (anchor.type === 'choice') {
    if (anchor.select) {
      const value = anchor.select.value;
      return () => setSelectValue(anchor.select!, value);
    }
    const states = anchor.options.map((o) => [o.control, isChecked(o.control)] as const);
    return () => {
      for (const [el, was] of states) {
        if (isChecked(el) === was) continue;
        if (el instanceof HTMLInputElement) {
          nativeSet(el, 'checked', was);
          dispatch(el, 'input');
          dispatch(el, 'change');
        } else {
          (el as HTMLElement).click();
        }
      }
    };
  }
  const values = anchor.blanks.map((el) =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : (el.textContent ?? ''),
  );
  return () => {
    anchor.blanks.forEach((el, i) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        nativeSet(el, 'value', values[i]);
        dispatch(el, 'input');
        dispatch(el, 'change');
      } else {
        el.textContent = values[i] ?? '';
        dispatch(el, 'input');
      }
    });
  };
}
