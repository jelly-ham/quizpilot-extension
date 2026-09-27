import type { Answer } from '@quizpilot/shared';
import { optionForBool, type Anchor, type ChoiceOption } from '../extract/generic';

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
        toggle(o, want);
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
  // An option row around a hidden input: the input knows, the row's class may not.
  const inputs = el.querySelectorAll<HTMLInputElement>('input[type=radio], input[type=checkbox]');
  if (inputs.length === 1 && inputs[0]!.checked) return true;
  // Custom div options usually mark the chosen one with a class.
  return SELECTED_CLASS.test(el.getAttribute('class') ?? '');
}

/**
 * Selects or clears one option the way a person would: by clicking its text. Many exam sites
 * hide the input and handle clicks on the option row (toggling the input and counting answered
 * questions themselves), so clicking the input directly can be undone by the row's handler and
 * leaves the site's own state behind. The input is only clicked or set directly when clicking
 * the text didn't take.
 */
function toggle(option: ChoiceOption, want: boolean) {
  const el = option.control;
  if (el instanceof HTMLInputElement) {
    const target = clickTarget(el, option.text);
    if (target !== el) {
      press(target);
      if (el.checked === want) return;
    }
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

const CHOICE_INPUT = 'input[type=radio], input[type=checkbox], [role=radio], [role=checkbox]';
const squashSpace = (t: string) => t.replace(/\s+/g, '');

/**
 * What a person would click to choose this input: the deepest element in its option row that
 * shows the option text, so the click bubbles through every wrapper a site may listen on. The
 * row is the largest ancestor holding no other choice. The input itself when there is no row.
 */
export function clickTarget(input: HTMLInputElement, text: string): Element {
  let row: Element = input;
  for (let up = input.parentElement; up && up !== document.body; up = up.parentElement) {
    if (up.querySelectorAll(CHOICE_INPUT).length > 1) break;
    row = up;
  }
  if (row === input) return input;
  const snippet = squashSpace(text).slice(0, 12);
  let target = row;
  if (snippet)
    for (const el of row.querySelectorAll('*'))
      if (el !== input && squashSpace(el.textContent ?? '').includes(snippet)) target = el;
  return target;
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
    const states = anchor.options.map((o) => [o, isChecked(o.control)] as const);
    return () => {
      // Reselect first: in a radio group that clears the filled answer the way the site expects.
      const order = [...states].sort(([, a], [, b]) => Number(b) - Number(a));
      for (const [o, was] of order) if (isChecked(o.control) !== was) toggle(o, was);
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
