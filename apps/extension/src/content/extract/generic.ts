import {
  FALSE_WORDS,
  Question,
  splitOptionKey,
  TRUE_WORDS,
  type QuestionKind,
} from '@quizpilot/shared';
import {
  ancestors,
  byDocumentOrder,
  containsDeep,
  deepQueryAll,
  isInsideOwnUi,
  lowestCommonAncestor,
  parentOf,
} from './dom';
import { MISSING_OPTION_TEXT } from '../../lib/protocol';
import { domLayout, type Layout } from './layout';
import { looksGarbled, meaningfulLength, readableText, type TextOptions } from './text';

export interface ChoiceOption {
  key: string;
  text: string;
  /** Element to click (input / role=radio) or the <option> of a select. */
  control: Element;
}

export type Anchor =
  | {
      type: 'choice';
      control: 'radio' | 'checkbox' | 'select';
      block: Element;
      stemEls: Element[];
      options: ChoiceOption[];
      select?: HTMLSelectElement;
    }
  | {
      type: 'text';
      control: 'text' | 'textarea' | 'contenteditable';
      block: Element;
      stemEls: Element[];
      blanks: Element[];
    };

export type ExtractStatus = 'ok' | 'figure' | 'incomplete';

export interface Extracted {
  question: Question;
  anchor: Anchor;
  /** ok: DOM text is enough. figure: text ok but a picture matters. incomplete: needs a screenshot read. */
  status: ExtractStatus;
  reason?: string;
}

export const CHOICE_SELECTOR =
  'input[type=radio], input[type=checkbox], [role=radio], [role=checkbox]';
export const TEXT_SELECTOR =
  'input:not([type]), input[type=text], input[type=number], textarea, [contenteditable=""], [contenteditable=true]';
const MAX_CLIMB = 6;
const MIN_FIGURE_PX = 60;
export const MISSING_STEM = '（题干未识别）';

/**
 * Per-extract context. Every "does this element contain control c?" check goes through
 * `contains`, which uses each control's cached ancestor set instead of walking to the root.
 */
interface Ctx {
  layout: Layout;
  controls: Element[];
  contains(ancestor: Element, control: Element): boolean;
  /** Any control (other than those in `except`) inside `el`. */
  hasControl(el: Element, except?: ReadonlySet<Element>): boolean;
}

function createCtx(layout: Layout, controls: Element[]): Ctx {
  const ancestorSets = new Map<Element, Set<Element>>();
  const contains = (a: Element, c: Element) => {
    if (a === c) return true;
    let set = ancestorSets.get(c);
    if (!set) ancestorSets.set(c, (set = new Set(ancestors(c))));
    return set.has(a);
  };
  return {
    layout,
    controls,
    contains,
    hasControl: (el, except) => controls.some((c) => !except?.has(c) && contains(el, c)),
  };
}

/** Class names that mark a custom option widget. */
const OPTION_CLASS = /option|answer|choice|radio|checkbox|\bopts?\b/i;
/** Stem looks like a quiz question: "?", a leading number, a blank, or 单选/多选/判断. */
const QUESTION_LIKE = /[?？]|^\s*[(（]?\d+\s*[.、．)）]|_{2,}|[（(]\s*[)）]|单选|多选|判断|选择/;
export const MULTI_HINT = /多选|多项|不定项|select all|all that apply|multiple answers/i;
/** Text boxes that are site chrome, not quiz blanks. */
/** Inputs that ask about the user, not the question: matched against placeholder, aria-label, name, title. */
const NOT_A_BLANK =
  /搜索|search|评论|comment|弹幕|留言|登录|用户名|密码|验证码|邮箱|email|手机|电话|phone|姓名|昵称|学号|工号|身份证|nick ?name|first ?name|last ?name|full ?name|your name|user_?name/i;
const CHROME_CONTAINERS =
  'nav, header, footer, [role=search], [role=navigation], [role=tablist], [role=menu], [role=menubar]';
/** Site headers built from plain divs: class="bili-header", "navbar", "top-bar". */
const CHROME_CLASS = /(^|\s)([\w]+-)?(header|navbar|nav-bar|topbar|top-bar)(\s|$)/i;
const SEARCH_HINT = /search|搜索/i;
/** Decorations that make no question a picture question: avatars, icons, logos. */
const DECOR = /avatar|头像|\bface\b|icon|logo|emoji|badge/i;
/** Progress lines that are not part of the question: "第 5/100 题", "3 / 10". */
const PROGRESS = /^(第\s*\d+\s*(\/\s*\d+\s*)?题|\d+\s*\/\s*\d+|question\s+\d+\s+(of|\/)\s+\d+)$/i;

/** Inside the site's header or navigation rather than the page content. */
export function inSiteChrome(el: Element): boolean {
  if (el.closest(CHROME_CONTAINERS)) return true;
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement)
    if (CHROME_CLASS.test(a.getAttribute('class') ?? '')) return true;
  return false;
}

/**
 * Site search boxes. The placeholder often isn't "搜索" (B 站 shows a trending term), so look at
 * the markup: input type, the form, and the classes and ids of the box and its wrappers.
 */
/** "共 2038 题 转到 [9] 题": a box that jumps to a question number, not a blank. */
function isJumpBox(el: Element): boolean {
  const around = el.parentElement?.textContent ?? '';
  return around.length < 80 && /转到|跳转|跳到|跳至|跳题|go ?to|jump ?to/i.test(around);
}

export function isSearchBox(el: Element): boolean {
  if (
    el.getAttribute('type') === 'search' ||
    el.getAttribute('role') === 'searchbox' ||
    el.getAttribute('enterkeyhint') === 'search' ||
    el.getAttribute('inputmode') === 'search'
  )
    return true;
  const form = el.closest('form');
  if (
    form &&
    (form.getAttribute('role') === 'search' || SEARCH_HINT.test(form.getAttribute('action') ?? ''))
  )
    return true;
  for (let a: Element | null = el, i = 0; a && i < 4; a = a.parentElement, i++)
    if (SEARCH_HINT.test(`${a.id} ${a.getAttribute('class') ?? ''}`)) return true;
  return false;
}

export function extractGeneric(
  root: ParentNode = document,
  layout: Layout = domLayout,
): Extracted[] {
  return mergeAnswerKeys(extractUnmerged(root, layout));
}

/** Every question found, before answer-key rows are folded into the question they answer. */
function extractUnmerged(root: ParentNode, layout: Layout): Extracted[] {
  // One walk over the document (and open shadow roots) for all control types.
  const found = deepQueryAll(root, `${CHOICE_SELECTOR}, select, ${TEXT_SELECTOR}`);
  const hasPassword = new WeakMap<Element, boolean>();
  const ok = (el: Element) => usable(el, layout, hasPassword);
  const choiceEls = found.filter((el) => el.matches(CHOICE_SELECTOR) && ok(el));
  const selectEls = found.filter(
    (el): el is HTMLSelectElement =>
      el.tagName === 'SELECT' && ok(el) && realOptions(el as HTMLSelectElement).length >= 2,
  );
  const textEls = found.filter(
    (el) =>
      el.matches(TEXT_SELECTOR) &&
      ok(el) &&
      !el.parentElement?.closest('[contenteditable=""], [contenteditable=true]') &&
      !isSearchBox(el) &&
      !isJumpBox(el) &&
      !NOT_A_BLANK.test(
        ['placeholder', 'aria-label', 'name', 'title']
          .map((a) => el.getAttribute(a) ?? '')
          .join(' '),
      ),
  );
  const native = [...choiceEls, ...selectEls, ...textEls];
  // Option groups built from plain divs; their items count as controls too, so the stem found for
  // one question never swallows another question's options.
  const customGroups = findCustomGroups(root, createCtx(layout, native));
  const ctx = createCtx(layout, [...native, ...customGroups.flat()]);

  const results: { block: Element; build: (id: string) => Extracted }[] = [];
  for (const group of groupChoices(choiceEls, ctx)) {
    if (group.length >= 2) results.push(buildChoice(group, ctx));
  }
  for (const select of selectEls) results.push(buildSelect(select, ctx));
  for (const items of customGroups) {
    const built = buildCustom(items, ctx);
    if (built) results.push(built);
  }

  // Text blanks not inside a choice/select question, grouped by the block they share.
  const textSet = new Set(textEls);
  const byBlock = new Map<Element, { blanks: Element[]; stemEls: Element[] }>();
  for (const el of textEls) {
    if (results.some((r) => ctx.contains(r.block, el))) continue;
    const { block, stemEls } = textBlock(el, textSet, ctx);
    const entry = byBlock.get(block) ?? { blanks: [], stemEls };
    entry.blanks.push(el);
    byBlock.set(block, entry);
  }
  for (const [block, { blanks, stemEls }] of byBlock)
    results.push(buildText(block, stemEls, blanks, ctx));

  results.sort((a, b) => byDocumentOrder(a.block, b.block));
  return results.map((r, i) => r.build(`q${i + 1}`));
}

/** Letter keys ("A", "B") when every option of a choice question is a bare letter. */
function bareKeys(e: Extracted): (string | undefined)[] {
  const a = e.anchor;
  return a.type === 'choice' && !a.select
    ? a.options.map((o) => BARE_KEY.exec(o.text)?.[1]?.toUpperCase())
    : [];
}
const isKeyRow = (e: Extracted) => {
  const keys = bareKeys(e);
  return keys.length >= 2 && keys.every(Boolean);
};

/**
 * Questions read with a learned site rule, with any separate row of letter answer buttons folded
 * in as extractGeneric does. A rule often picks the option texts ("A：正确"), which on sites like
 * 驾校一点通 are not what records the answer.
 */
export function withAnswerKeys(
  questions: Extracted[],
  root: ParentNode = document,
  layout: Layout = domLayout,
): Extracted[] {
  const rows = extractUnmerged(root, layout).filter(isKeyRow);
  if (!rows.length) return questions;
  const all = [...questions, ...rows].sort((a, b) =>
    byDocumentOrder(a.anchor.block, b.anchor.block),
  );
  // Rows that answer none of the rule's questions are not questions themselves.
  return mergeAnswerKeys(all).filter((e) => !rows.includes(e));
}

/** An option that is only a letter: an answer key button ("A", "(B)", "C."). */
const BARE_KEY = /^\s*[(（]?\s*([A-Ha-h])\s*[)）.．、]?\s*$/;

/**
 * Sites like 驾校一点通 list the options as text ("A、正确 B、错误") and answer through a separate
 * row of letter buttons. That row reads as its own question with options "A", "B". Fold it into
 * the question before it: keep that question's option texts, click the letter buttons.
 */
export function mergeAnswerKeys(list: Extracted[]): Extracted[] {
  const out: Extracted[] = [];
  for (const e of list) {
    const a = e.anchor;
    const keys = bareKeys(e);
    const target =
      keys.length >= 2 && keys.every(Boolean)
        ? [...out]
            .reverse()
            .find(
              (p) =>
                p.anchor.type === 'choice' &&
                !p.anchor.select &&
                p.anchor.options.length === keys.length &&
                p.anchor.options.every((o) => keys.includes(o.key)),
            )
        : undefined;
    if (!target || target.anchor.type !== 'choice' || a.type !== 'choice') {
      out.push(e);
      continue;
    }
    const byKey = new Map(a.options.map((o, i) => [keys[i]!, o.control]));
    target.anchor.options = target.anchor.options.map((o) => ({
      ...o,
      control: byKey.get(o.key)!,
    }));
    if (a.control === 'checkbox') target.anchor.control = 'checkbox';
  }
  return out;
}

function usable(el: Element, layout: Layout, hasPassword: WeakMap<Element, boolean>): boolean {
  if (isInsideOwnUi(el)) return false;
  if ((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true')
    return false;
  if (inSiteChrome(el)) return false;
  const form = (el as HTMLInputElement).form ?? el.closest('form');
  if (form) {
    // Login forms: checked once per form, not once per control.
    let pw = hasPassword.get(form);
    if (pw === undefined)
      hasPassword.set(form, (pw = !!form.querySelector('input[type=password]')));
    if (pw) return false;
  }
  if (layout.visible(el)) return true;
  // Custom-styled radios hide the input and show the label.
  const labels = (el as HTMLInputElement).labels;
  return !!labels && [...labels].some((l) => layout.visible(l));
}

function isCheckboxLike(el: Element): boolean {
  return el.getAttribute('type') === 'checkbox' || el.getAttribute('role') === 'checkbox';
}

// ---------------------------------------------------------------- choice groups

function groupChoices(els: Element[], ctx: Ctx): Element[][] {
  const scopeIds = new WeakMap<object, number>();
  let nextScope = 0;
  const scopeId = (o: object) => {
    if (!scopeIds.has(o)) scopeIds.set(o, nextScope++);
    return scopeIds.get(o)!;
  };
  const byKind = { c: els.filter(isCheckboxLike), r: els.filter((e) => !isCheckboxLike(e)) };
  const groups = new Map<string, Element[]>();
  for (const el of els) {
    const kind = isCheckboxLike(el) ? 'c' : 'r';
    const name = el instanceof HTMLInputElement ? el.name.replace(/\[\]$/, '') : '';
    let key: string;
    if (name) {
      const scope = (el as HTMLInputElement).form ?? el.getRootNode();
      key = `${kind}:${scopeId(scope)}:${name}`;
    } else {
      const container =
        el.closest('[role=radiogroup], [role=group], fieldset') ??
        nearestMultiContainer(el, byKind[kind], ctx);
      key = `${kind}:anon:${scopeId(container)}`;
    }
    groups.set(key, [...(groups.get(key) ?? []), el]);
  }
  return [...groups.values()];
}

/** Closest ancestor (up to 5 levels) that also holds another control of the same kind. */
function nearestMultiContainer(el: Element, sameKind: Element[], ctx: Ctx): Element {
  let cur: Element = el;
  for (let i = 0; i < 5; i++) {
    const p = parentOf(cur);
    if (!p) break;
    cur = p;
    if (sameKind.some((o) => o !== el && ctx.contains(cur, o))) return cur;
  }
  return parentOf(el) ?? el;
}

/** Largest ancestor of `control` (up to a few levels) holding no other control of the group. */
function optionRow(control: Element, group: Element[], ctx: Ctx): Element {
  let row = control;
  for (let i = 0; i < 4; i++) {
    const p = parentOf(row);
    if (!p || group.some((o) => o !== control && ctx.contains(p, o))) break;
    if (readableText(p, { layout: ctx.layout }).length > 300) break;
    row = p;
  }
  return row;
}

function optionText(control: Element, row: Element, layout: Layout): string {
  const labels = control instanceof HTMLInputElement ? [...(control.labels ?? [])] : [];
  const fromLabels = labels
    .map((l) => readableText(l, { layout, exclude: (e) => e === control }))
    .join(' ')
    .trim();
  if (fromLabels) return fromLabels;
  const aria = control.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const labelledBy = control.getAttribute('aria-labelledby');
  if (labelledBy) {
    const doc = control.ownerDocument;
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter((e): e is HTMLElement => !!e)
      .map((e) => readableText(e, { layout }))
      .join(' ')
      .trim();
    if (text) return text;
  }
  if (control.getAttribute('role')) {
    const own = readableText(control, { layout });
    if (own) return own;
  }
  return readableText(row, { layout });
}

function buildChoice(group: Element[], ctx: Ctx) {
  const rows = group.map((c) => optionRow(c, group, ctx));
  const labelEls = group.flatMap((c) =>
    c instanceof HTMLInputElement ? [...(c.labels ?? [])] : [],
  );
  const excluded = new Set([...rows, ...labelEls]);
  const exclude = (el: Element) => excluded.has(el);
  const { block, stemEls } = findStem(rows, new Set(group), ctx, exclude);
  const control = isCheckboxLike(group[0]!) ? ('checkbox' as const) : ('radio' as const);

  return {
    block,
    build: (id: string): Extracted => {
      const options = assignKeys(
        group.map((c, i) => ({ control: c, text: optionText(c, rows[i]!, ctx.layout) })),
      );
      const stem = stemText(block, stemEls, { layout: ctx.layout, exclude });
      const kind: QuestionKind =
        control === 'checkbox' ? 'multi' : isJudge(options) ? 'judge' : 'single';
      return finish(
        id,
        kind,
        stem,
        { type: 'choice', control, block, stemEls, options },
        ctx.layout,
        { optionRows: rows },
      );
    },
  };
}

function realOptions(select: HTMLSelectElement): HTMLOptionElement[] {
  return [...select.options].filter(
    (o, i) => !o.disabled && !(i === 0 && (o.value === '' || /请选择|select/i.test(o.text))),
  );
}

function buildSelect(select: HTMLSelectElement, ctx: Ctx) {
  const labelEls = [...(select.labels ?? [])];
  const excluded = new Set<Element>([select, ...labelEls]);
  const { block, stemEls } = findStem([select], new Set([select]), ctx, (el) => el === select);
  return {
    block,
    build: (id: string): Extracted => {
      const options = assignKeys(
        realOptions(select).map((o) => ({ control: o, text: o.text.trim() })),
      );
      const labelText = labelEls
        .map((l) => readableText(l, { layout: ctx.layout, exclude: (e) => e === select }))
        .join(' ');
      const stem = [
        labelText,
        stemText(block, stemEls, { layout: ctx.layout, exclude: (el) => excluded.has(el) }),
      ]
        .filter(Boolean)
        .join('\n');
      const kind: QuestionKind = isJudge(options) ? 'judge' : 'single';
      return finish(
        id,
        kind,
        stem,
        { type: 'choice', control: 'select', block, stemEls, options, select },
        ctx.layout,
      );
    },
  };
}

// ---------------------------------------------------------------- custom (div) option groups

/**
 * Classes a site toggles on one option once it is picked or marked right/wrong. They don't make
 * it a different kind of element: without this, the answered option splits off its group and
 * reads as the stem of a "new" question.
 */
const STATE_CLASS =
  /(^|[-_])(active|selected|sel|checked|current|chosen|picked|correct|wrong|right|error|success|danger|disabled|answered|on)$|^is-/i;

function signature(el: Element): string {
  const classes = [...el.classList].filter((c) => !STATE_CLASS.test(c));
  return `${el.tagName}.${classes.sort().join('.')}`;
}

/**
 * Sets of 2–12 sibling elements with the same tag and classes, short text, and an option-like hint
 * (hand cursor, option-ish class name, or an "A." label). Candidates only; buildCustom decides.
 */
function findCustomGroups(root: ParentNode, ctx: Ctx): Element[][] {
  const byParent = new Map<Element, Map<string, Element[]>>();
  // `b`: 驾驶员考试网 (jsyks.com) draws 正确 / 错误 as bare <b> elements.
  for (const el of deepQueryAll(root, 'div, li, span, label, p, dd, td, button, b')) {
    const text = el.textContent?.trim() ?? '';
    if (!text || text.length > 200 || el.childElementCount > 12) continue;
    const parent = parentOf(el);
    if (!parent) continue;
    const hinted =
      OPTION_CLASS.test(el.getAttribute('class') ?? '') ||
      splitOptionKey(text) !== null ||
      ctx.layout.clickable(el);
    if (!hinted) continue;
    const sigs = byParent.get(parent) ?? new Map<string, Element[]>();
    const sig = signature(el);
    sigs.set(sig, [...(sigs.get(sig) ?? []), el]);
    byParent.set(parent, sigs);
  }

  const groups: Element[][] = [];
  for (const sigs of byParent.values()) {
    for (const items of sigs.values()) {
      if (items.length < 2 || items.length > 12) continue;
      if (isInsideOwnUi(items[0]!) || inSiteChrome(items[0]!)) continue;
      if (!items.every((i) => ctx.layout.visible(i))) continue;
      // Link lists and wrappers around real inputs are not custom options.
      if (
        items.some((i) => i.closest('a[href]') || i.querySelector('a[href]') || ctx.hasControl(i))
      )
        continue;
      groups.push(items);
    }
  }
  // g is the same options as `other`, one level deeper (li.option > span.label, both clickable).
  const innerCopyOf = (g: Element[], other: Element[]) =>
    g.length === other.length && g.every((i, n) => other[n] !== i && other[n]!.contains(i));
  const items = new Set(groups.flat());
  return groups.filter((g) => {
    if (groups.some((other) => other !== g && innerCopyOf(g, other))) return false;
    for (const other of groups) {
      if (other === g || innerCopyOf(other, g)) continue;
      // Question cards containing option lists, and stems ("1、…") standing right before one.
      if (g.some((i) => other.some((o) => i.contains(o)))) return false;
    }
    return !g.some((i) => {
      const next = i.nextElementSibling;
      return !!next && [...items].some((o) => !g.includes(o) && (next === o || next.contains(o)));
    });
  });
}

function buildCustom(items: Element[], ctx: Ctx) {
  const own = new Set(items);
  const exclude = (el: Element) => own.has(el);
  const { block, stemEls } = findStem(items, own, ctx, exclude);
  const stem = stemText(block, stemEls, { layout: ctx.layout, exclude });
  const texts = items.map((i) => readableText(i, { layout: ctx.layout }));
  const options = assignKeys(items.map((control, i) => ({ control, text: texts[i]! })));
  const keyed = options.every((o, i) => o.text !== texts[i]);
  const optionClass = items.every((i) => OPTION_CLASS.test(i.getAttribute('class') ?? ''));
  const clickable = items.every((i) => ctx.layout.clickable(i));
  const numericOnly = texts.every((t) => /^\d+$/.test(t.trim()));

  // Tabs, pagination and menus share this shape: demand an option signal and a real stem.
  const accepted =
    meaningfulLength(stem) >= 2 &&
    !(numericOnly && !keyed) &&
    (keyed || optionClass || isJudge(options) || (clickable && QUESTION_LIKE.test(stem)));
  if (!accepted) return null;

  return {
    block,
    build: (id: string): Extracted => {
      const kind: QuestionKind = MULTI_HINT.test(stem)
        ? 'multi'
        : isJudge(options)
          ? 'judge'
          : 'single';
      const control = kind === 'multi' ? ('checkbox' as const) : ('radio' as const);
      return finish(
        id,
        kind,
        stem,
        { type: 'choice', control, block, stemEls, options },
        ctx.layout,
        {
          optionRows: items,
        },
      );
    },
  };
}

// ---------------------------------------------------------------- text blanks

function textBlock(el: Element, textSet: ReadonlySet<Element>, ctx: Ctx) {
  let block = parentOf(el) ?? el;
  for (let i = 0; i < MAX_CLIMB; i++) {
    const text = readableText(block, {
      layout: ctx.layout,
      replace: (e) => (textSet.has(e) ? ' ' : null),
    });
    if (meaningfulLength(text) >= 4) return { block, stemEls: [] as Element[] };
    const p = parentOf(block);
    // Stop before swallowing other questions' controls.
    const current = block;
    if (!p || ctx.controls.some((c) => ctx.contains(p, c) && !ctx.contains(current, c))) break;
    block = p;
  }
  return { block, stemEls: previousStemSiblings(block, ctx) };
}

function buildText(block: Element, stemEls: Element[], blanks: Element[], ctx: Ctx) {
  return {
    block,
    build: (id: string): Extracted => {
      const first = blanks[0]!;
      const control: 'text' | 'textarea' | 'contenteditable' =
        first.tagName === 'TEXTAREA'
          ? 'textarea'
          : first.tagName === 'INPUT'
            ? 'text'
            : 'contenteditable';
      const kind: QuestionKind =
        blanks.length === 1 && isLongText(first, ctx.layout) ? 'essay' : 'fill';
      const blankSet = new Set(blanks);
      const replace = (el: Element) =>
        blankSet.has(el) ? (kind === 'essay' ? ' ' : ' ___ ') : null;
      const stem = stemText(block, stemEls, { layout: ctx.layout, replace });
      return finish(id, kind, stem, { type: 'text', control, block, stemEls, blanks }, ctx.layout, {
        ...(kind === 'fill' ? { blanks: blanks.length } : {}),
      });
    },
  };
}

export function isLongText(el: Element, layout: Layout): boolean {
  if (el.tagName === 'INPUT') return false;
  if (el.tagName === 'TEXTAREA' && Number(el.getAttribute('rows') ?? 2) >= 3) return true;
  const h = layout.size(el).height;
  return h === 0 ? el.tagName !== 'TEXTAREA' : h >= 60;
}

// ---------------------------------------------------------------- stems

/** Climb from the option rows until there is question text, without taking in other questions. */
function findStem(
  rows: Element[],
  own: ReadonlySet<Element>,
  ctx: Ctx,
  exclude: (el: Element) => boolean,
): { block: Element; stemEls: Element[] } {
  let block = rows.length === 1 ? (parentOf(rows[0]!) ?? rows[0]!) : lowestCommonAncestor(rows)!;
  const notStem = (el: Element) => exclude(el) || isFeedback(el);
  for (let i = 0; i < MAX_CLIMB; i++) {
    if (meaningfulLength(readableText(block, { layout: ctx.layout, exclude: notStem })) >= 2)
      return { block, stemEls: [] };
    const p = parentOf(block);
    if (!p || ctx.hasControl(p, own)) break;
    block = p;
  }
  return { block, stemEls: previousStemSiblings(block, ctx) };
}

/**
 * What a site shows once a question is answered ("恭喜！回答正确", "标准答案：B 为什么是 B ?").
 * 元贝驾考 inserts it into the option list; read as the stem, the answered question looked like a
 * new one and continuous mode answered it twice.
 */
const FEEDBACK =
  /^\s*(恭喜|回答正确|回答错误|答对了|答错了|标准答案|正确答案|参考答案|答案解析|本题解析|试题解析|你的答案|您的答案|您选择|你选择|为什么是|correct!?\s|incorrect|wrong answer|the correct answer|right answer)/i;

function isFeedback(el: Element): boolean {
  const text = el.textContent ?? '';
  return (
    text.length < 300 &&
    FEEDBACK.test(text) &&
    !el.querySelector(`${CHOICE_SELECTOR}, ${TEXT_SELECTOR}, select`)
  );
}

/** Question text laid out as siblings before the controls: <p>1. stem</p><div>options</div>. */
function previousStemSiblings(block: Element, ctx: Ctx): Element[] {
  const out: Element[] = [];
  for (
    let sib = block.previousElementSibling, n = 0;
    sib && n < 3;
    sib = sib.previousElementSibling, n++
  ) {
    if (ctx.hasControl(sib)) break;
    out.unshift(sib);
    if (meaningfulLength(readableText(sib, { layout: ctx.layout })) >= 2) break;
  }
  return out;
}

/** Preceding stem siblings, then the block itself (with the given exclusions / replacements). */
function stemText(block: Element, stemEls: Element[], opts: TextOptions): string {
  const exclude = (el: Element) => !!opts.exclude?.(el) || isFeedback(el);
  return [
    ...stemEls.map((s) => readableText(s, { layout: opts.layout, exclude: isFeedback })),
    readableText(block, { ...opts, exclude }),
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------- helpers

/** A letter badge on its own line before the option text: "A\nHyper Text Markup Language". */
const LETTER_BADGE = /^\s*([A-Za-z])\s*\n\s*/;

export function assignKeys(raw: { control: Element; text: string }[]): ChoiceOption[] {
  let split = raw.map((r) => splitOptionKey(r.text));
  if (!split.every(Boolean)) {
    const badges = raw.map((r) => LETTER_BADGE.exec(r.text));
    if (badges.every(Boolean))
      split = raw.map((r, i) => ({
        key: badges[i]![1]!.toUpperCase(),
        text: r.text.slice(badges[i]![0].length).trim(),
      }));
  }
  const keys = split.map((s) => s?.key);
  const detected = keys.every(Boolean) && new Set(keys).size === keys.length;
  return raw.map((r, i) => ({
    control: r.control,
    key: detected ? keys[i]! : letterKey(i),
    text: detected ? split[i]!.text : r.text,
  }));
}

function letterKey(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

const wordIn = (words: ReadonlySet<string>, text: string) => words.has(text.trim().toLowerCase());

export function isJudge(options: ChoiceOption[]): boolean {
  if (options.length !== 2) return false;
  return (
    options.some((o) => wordIn(TRUE_WORDS, o.text)) &&
    options.some((o) => wordIn(FALSE_WORDS, o.text))
  );
}

export function optionForBool(options: ChoiceOption[], value: boolean): ChoiceOption | undefined {
  return options.find((o) => wordIn(value ? TRUE_WORDS : FALSE_WORDS, o.text));
}

/** The first real figure in the question, or null. Avatars, icons and logos don't count. */
/**
 * The stem talks about a picture ("如图所示", "这个标志", "红圈内", "这辆小型载客汽车"). Bare
 * "标志" is not enough: "不按规定设置警告标志" is a text question.
 */
const REFERS_TO_FIGURE =
  /如图|图中|图示|下图|上图|此图|该图|图片中|这个标志|这种标志|此标志|该标志|这个标线|这些标线|此标线|这个信号|这个手势|这个仪表|红圈|红框|这辆|这个路口|this (sign|picture|image|figure|diagram)|in the (picture|image|figure|diagram)|shown (below|above)/i;

/** A real figure anywhere on the page (not an avatar, icon or site chrome), usable as a question's picture. */
function candidateFigure(el: Element, layout: Layout): boolean {
  if (isInsideOwnUi(el) || inSiteChrome(el) || !layout.visible(el)) return false;
  if (el.parentElement?.closest('svg, picture')) return false;
  if (el.tagName === 'IMG' && !(el as HTMLImageElement).getAttribute('src')) return false;
  const s = layout.size(el);
  const w = Math.max(s.width, Number(el.getAttribute('width')) || 0);
  const h = Math.max(s.height, Number(el.getAttribute('height')) || 0);
  return w >= MIN_FIGURE_PX && h >= MIN_FIGURE_PX && !decorative(el);
}

/**
 * The figure a question refers to when the site shows it outside the question block
 * (驾校一点通 puts it in a separate "图片信息" panel): the candidate whose common ancestor with
 * the block is deepest, i.e. the closest one in the page structure.
 */
function nearbyFigure(block: Element, layout: Layout): Element | null {
  const doc = block.ownerDocument;
  let best: { el: Element; depth: number } | null = null;
  for (const el of doc.querySelectorAll('img, canvas, svg, picture')) {
    if (containsDeep(block, el) || !candidateFigure(el, layout)) continue;
    const common = lowestCommonAncestor([block, el]);
    const depth = common ? ancestors(common).length : 0;
    if (!best || depth > best.depth) best = { el, depth };
  }
  return best?.el ?? null;
}

/**
 * An image in the question that hasn't loaded yet: lazy loaders leave it without a `src` (or with
 * `data-src`/`data-original`) and zero size until it scrolls into view — 驾驶员考试网 (jsyks.com)
 * puts every sign in the stem this way. Screenshots scroll the question into view and wait for it.
 */
function lazyFigureOf(els: Element[], exclude: Element[]): Element | null {
  for (const root of els) {
    for (const img of root.querySelectorAll('img')) {
      if (exclude.some((x) => containsDeep(x, img)) || decorative(img)) continue;
      const src = img.getAttribute('src')?.trim() ?? '';
      const lazy =
        !src ||
        src.startsWith('data:') ||
        img.hasAttribute('data-src') ||
        img.hasAttribute('data-original') ||
        img.getAttribute('loading') === 'lazy';
      if (lazy && !(img as HTMLImageElement).naturalWidth) return img;
    }
  }
  return null;
}

function figureOf(els: Element[], exclude: Element[], layout: Layout): Element | null {
  for (const root of els) {
    for (const img of root.querySelectorAll('img, canvas, svg, picture')) {
      if (exclude.some((x) => containsDeep(x, img))) continue;
      if (img.parentElement?.closest('svg, picture')) continue; // counted with its outer element
      const s = layout.size(img);
      const w = Math.max(s.width, Number(img.getAttribute('width')) || 0);
      const h = Math.max(s.height, Number(img.getAttribute('height')) || 0);
      if (w < MIN_FIGURE_PX || h < MIN_FIGURE_PX) continue;
      if (decorative(img) || nameTag(img, root)) continue;
      return img;
    }
  }
  return null;
}

/**
 * Avatar with a name ("小电视校长"): no question text before the image, and the first text after
 * it is a short label that isn't question text. Compared in reading order, not by nesting — B 站
 * puts the avatar and the name in different wrappers. A figure follows or precedes question text.
 */
function nameTag(img: Element, root: Element): boolean {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let before = '';
  let after: string | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim() ?? '';
    if (!text || img.contains(n)) continue;
    if (img.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING) before += text;
    else {
      after = text;
      break;
    }
  }
  if (meaningfulLength(before) > 12 || QUESTION_LIKE.test(before)) return false;
  return after !== null && meaningfulLength(after) <= 12 && !QUESTION_LIKE.test(after);
}

/** For the debug log: which element made this a picture question. */
function describeFigure(el: Element, layout: Layout): string {
  const s = layout.size(el);
  const cls = el.getAttribute('class');
  const src = el.getAttribute('src');
  return `<${el.tagName.toLowerCase()}${cls ? ` class="${cls}"` : ''}${src ? ` src="…${src.slice(-40)}"` : ''}> ${Math.round(s.width)}×${Math.round(s.height)}`;
}

function decorative(img: Element): boolean {
  if (DECOR.test(img.getAttribute('src') ?? '') || /\/face\//.test(img.getAttribute('src') ?? ''))
    return true;
  for (let a: Element | null = img, i = 0; a && i < 3; a = a.parentElement, i++)
    if (DECOR.test(`${a.id} ${a.getAttribute('class') ?? ''} ${a.getAttribute('alt') ?? ''}`))
      return true;
  return false;
}

const withoutProgress = (stem: string) =>
  stem
    .split('\n')
    .filter((line) => !PROGRESS.test(line.trim()))
    .join('\n');

export function finish(
  id: string,
  kind: QuestionKind,
  rawStem: string,
  anchor: Anchor,
  layout: Layout,
  extra: { blanks?: number; optionRows?: Element[] } = {},
): Extracted {
  const stem = withoutProgress(rawStem);
  const options = anchor.type === 'choice' ? anchor.options : undefined;
  let status: ExtractStatus = 'ok';
  let reason: string | undefined;
  if (meaningfulLength(stem) < 2) [status, reason] = ['incomplete', 'stem text missing'];
  else if (options?.some((o) => meaningfulLength(o.text) === 0))
    [status, reason] = ['incomplete', 'option text missing'];
  else if (looksGarbled(stem) || options?.some((o) => looksGarbled(o.text)))
    [status, reason] = ['incomplete', 'text looks obfuscated'];
  else {
    const own = [anchor.block, ...anchor.stemEls];
    const figure = figureOf(own, extra.optionRows ?? [], layout);
    const lazy = figure ? null : lazyFigureOf(own, extra.optionRows ?? []);
    const referred =
      !figure && !lazy && REFERS_TO_FIGURE.test(stem) ? nearbyFigure(anchor.block, layout) : null;
    if (figure)
      [status, reason] = [
        'figure',
        `question contains a figure: ${describeFigure(figure, layout)}`,
      ];
    else if (lazy)
      [status, reason] = ['figure', 'question contains a figure that has not loaded yet'];
    else if (referred) {
      // Include it in the question's screenshot area.
      anchor.stemEls.push(referred);
      [status, reason] = [
        'figure',
        `stem refers to a figure outside the question: ${describeFigure(referred, layout)}`,
      ];
    }
  }

  const question = Question.parse({
    id,
    kind,
    stem: (stem || MISSING_STEM).slice(0, 8000),
    ...(options
      ? {
          options: options.map((o) => ({
            key: o.key,
            text: (o.text || MISSING_OPTION_TEXT).slice(0, 2000),
          })),
        }
      : {}),
    ...(extra.blanks ? { blanks: extra.blanks } : {}),
    source: 'dom',
  });
  return { question, anchor, status, ...(reason ? { reason } : {}) };
}
