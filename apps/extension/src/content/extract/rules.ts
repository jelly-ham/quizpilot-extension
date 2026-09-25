import type { QuestionKind } from '@quizpilot/shared';
import { isInsideOwnUi, lowestCommonAncestor } from './dom';
import {
  assignKeys,
  CHOICE_SELECTOR,
  finish,
  isJudge,
  isLongText,
  MULTI_HINT,
  type Extracted,
} from './generic';
import { domLayout, type Layout } from './layout';
import { meaningfulLength, readableText } from './text';

/**
 * A learned description of one site's quiz layout: where question containers are, and where the
 * stem, options and text blanks sit inside each. Plain CSS selectors so it survives reloads, other
 * pages of the same quiz, and questions that were off-screen when it was learned.
 */
export interface SiteRule {
  version: 1;
  /** Matches every question container on the page. */
  question: string;
  /** Inside a container. */
  stem: string;
  option?: string;
  blank?: string;
}

/** One labelled question, used to learn a rule. */
export interface RuleExample {
  stem: Element;
  options: Element[];
  blanks: Element[];
}

/** Storage key: host plus path with number-bearing segments generalised (/v/newbie/basic-1 → /v/newbie/*). */
export function ruleKey(url: URL | Location): string {
  const path = url.pathname
    .split('/')
    .map((seg) => (/\d/.test(seg) ? '*' : seg))
    .join('/');
  return `${url.host}${path}`;
}

// ---------------------------------------------------------------- applying

const MIN_VALID_SHARE = 0.6;

/** Extract questions with a rule, or null if the page no longer fits it (site changed). */
export function applyRule(
  rule: SiteRule,
  root: ParentNode = document,
  layout: Layout = domLayout,
): Extracted[] | null {
  let containers: Element[];
  try {
    containers = [...root.querySelectorAll(rule.question)].filter(
      (c) => layout.visible(c) && !isInsideOwnUi(c),
    );
  } catch {
    return null; // invalid selector
  }
  // Nested matches mean the selector is too loose for this page.
  if (containers.some((c) => containers.some((o) => o !== c && o.contains(c)))) return null;

  const out: Extracted[] = [];
  for (const container of containers) {
    const e = extractWithRule(rule, container, layout, `q${out.length + 1}`);
    if (e) out.push(e);
  }
  if (out.length === 0 || out.length < containers.length * MIN_VALID_SHARE) return null;
  return out;
}

function extractWithRule(
  rule: SiteRule,
  container: Element,
  layout: Layout,
  id: string,
): Extracted | null {
  const stemEl = container.querySelector(rule.stem);
  // Hidden copies (inactive carousel panels) are not part of the question on screen.
  const options = rule.option
    ? [...container.querySelectorAll(rule.option)].filter((o) => layout.visible(o))
    : [];
  const blanks = rule.blank
    ? [...container.querySelectorAll(rule.blank)].filter((b) => layout.visible(b))
    : [];
  if (!stemEl) return null;
  const stem = readableText(stemEl, {
    layout,
    exclude: (el) => options.includes(el) || blanks.includes(el),
  });
  if (meaningfulLength(stem) < 2) return null;

  if (options.length) {
    if (options.length < 2 || options.length > 12) return null;
    // Click the real input when an option row wraps one.
    const controls = options.map((o) =>
      o.matches(CHOICE_SELECTOR) ? o : (o.querySelector(CHOICE_SELECTOR) ?? o),
    );
    const checkbox = controls.some(
      (c) => c.getAttribute('type') === 'checkbox' || c.getAttribute('role') === 'checkbox',
    );
    const choice = assignKeys(
      controls.map((control, i) => ({ control, text: readableText(options[i]!, { layout }) })),
    );
    const kind: QuestionKind =
      checkbox || MULTI_HINT.test(stem) ? 'multi' : isJudge(choice) ? 'judge' : 'single';
    return finish(
      id,
      kind,
      stem,
      {
        type: 'choice',
        control: kind === 'multi' ? 'checkbox' : 'radio',
        block: container,
        stemEls: [],
        options: choice,
      },
      layout,
      { optionRows: options },
    );
  }
  if (blanks.length) {
    const first = blanks[0]!;
    const kind: QuestionKind = blanks.length === 1 && isLongText(first, layout) ? 'essay' : 'fill';
    const control =
      first.tagName === 'TEXTAREA'
        ? 'textarea'
        : first.tagName === 'INPUT'
          ? 'text'
          : 'contenteditable';
    return finish(
      id,
      kind,
      stem,
      { type: 'text', control, block: container, stemEls: [], blanks },
      layout,
      {
        ...(kind === 'fill' ? { blanks: blanks.length } : {}),
      },
    );
  }
  return null;
}

// ---------------------------------------------------------------- learning

/** Classes that change between loads or states and must not appear in a rule. */
const UNSTABLE_CLASS =
  /^(css|sc|jsx|emotion|styled|svelte)-|^_|--|(^|[-_])(active|selected|checked|current|hover|focus|disabled|on|is-[\w-]+)$/i;
const looksHashed = (c: string) =>
  c.length >= 5 && /\d/.test(c) && /[a-z]/i.test(c) && !/^[a-z]+-?\d{1,2}$/i.test(c);

export function stableClasses(el: Element): string[] {
  return [...el.classList].filter((c) => !UNSTABLE_CLASS.test(c) && !looksHashed(c));
}

const esc = (s: string) =>
  typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1');

/** Selector variants for one element, most specific first. */
function variants(el: Element): string[] {
  const tag = el.tagName.toLowerCase();
  const cls = stableClasses(el).map((c) => `.${esc(c)}`);
  const out = new Set<string>();
  if (cls.length) {
    out.add(`${tag}${cls.join('')}`);
    for (const c of cls) out.add(`${tag}${c}`);
    for (const c of cls) out.add(c);
  }
  out.add(tag);
  return [...out];
}

/** A selector matching all `els` within `scope` and as little else as possible. */
function commonSelector(els: Element[], scope: ParentNode, inner?: Element[]): string | null {
  const first = els[0]!;
  const parent = first.parentElement;
  // A class-less container is known by the classed child it holds (B 站: a bare div around
  // div.qa-header): `div:has(> div.qa-header)`. The child combinator keeps ancestors out.
  const child = inner?.[0] && [...first.children].find((c) => c.contains(inner[0]!));
  const byChild = child
    ? variants(child)
        .filter((v) => v.includes('.'))
        .slice(0, 3)
        .map((c) => `${first.tagName.toLowerCase()}:has(> ${c})`)
    : [];
  const candidates = [
    ...variants(first),
    ...byChild,
    // Disambiguate generic tags by their parent's shape: `div.answers > div`.
    ...(parent
      ? variants(parent)
          .slice(0, 2)
          .flatMap((p) => variants(first).map((v) => `${p} > ${v}`))
      : []),
  ];
  let best: { sel: string; count: number } | null = null;
  for (const sel of candidates) {
    let matches: Element[];
    try {
      matches = [...scope.querySelectorAll(sel)];
    } catch {
      continue;
    }
    if (!els.every((e) => matches.includes(e))) continue;
    if (
      !best ||
      matches.length < best.count ||
      (matches.length === best.count && sel.length < best.sel.length)
    ) {
      best = { sel, count: matches.length };
    }
  }
  return best?.sel ?? null;
}

/** Relative selector that picks exactly `targets` (in order) inside every container. */
function relativeSelector(pairs: { container: Element; targets: Element[] }[]): string | null {
  const { container, targets } = pairs[0]!;
  const candidates = new Set<string>();
  for (const v of variants(targets[0]!)) candidates.add(`:scope ${v}`);
  // Child-path fallbacks: :scope > div > span.label, then by position for class-less markup
  // (:scope > div:nth-of-type(2) > div:nth-of-type(1)).
  const path: string[] = [];
  const positional: string[] = [];
  for (let el: Element | null = targets[0]!; el && el !== container; el = el.parentElement) {
    path.unshift(variants(el)[0]!);
    const tag = el.tagName.toLowerCase();
    const index = el.parentElement
      ? [...el.parentElement.children].filter((c) => c.tagName === el!.tagName).indexOf(el) + 1
      : 1;
    positional.unshift(`${tag}:nth-of-type(${index})`);
  }
  candidates.add(`:scope > ${path.join(' > ')}`);
  // Option lists: every option shares the path except the last step's position.
  if (targets.length > 1)
    candidates.add(`:scope > ${[...positional.slice(0, -1), path.at(-1)!].join(' > ')}`);
  else candidates.add(`:scope > ${positional.join(' > ')}`);

  const same = (a: Element[], b: Element[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  for (const sel of candidates) {
    try {
      if (pairs.every((p) => same([...p.container.querySelectorAll(sel)], p.targets))) return sel;
      // A stem selector only needs its first match to be right.
      if (
        targets.length === 1 &&
        pairs.every((p) => p.container.querySelector(sel) === p.targets[0])
      )
        return sel;
    } catch {
      // skip invalid
    }
  }
  return null;
}

/**
 * The clickable root of each option: climb from the labelled element while the parent holds no other
 * option (so a label span becomes its whole option row).
 */
export function optionRoots(options: Element[]): Element[] {
  return options.map((o) => {
    let row = o;
    let p = row.parentElement;
    while (p && !options.some((x) => x !== o && p!.contains(x))) {
      row = p;
      p = p.parentElement;
    }
    return row;
  });
}

/** Question container: the smallest ancestor holding the stem and all options/blanks. */
function containerOf(ex: RuleExample): Element | null {
  const parts = [ex.stem, ...ex.options, ...ex.blanks];
  return parts.length === 1 ? ex.stem.parentElement : lowestCommonAncestor(parts);
}

/**
 * Generalise labelled examples into a rule, and check that applying it reproduces them.
 * Returns null when no consistent rule exists (e.g. examples with different layouts).
 */
export function deriveRule(
  examples: RuleExample[],
  root: ParentNode = document,
  layout: Layout = domLayout,
  /** Told why no rule was found, for the debug log. */
  why: (reason: string) => void = () => {},
): SiteRule | null {
  const fail = (reason: string) => (why(reason), null);
  if (examples.length === 0) return fail('模型没有标出可用的题目');
  const rows = examples.map((ex) => ({
    ...ex,
    options: optionRoots(ex.options),
    container: containerOf(ex),
  }));
  if (rows.some((r) => !r.container)) return fail('找不到包含题干和选项的容器');
  let containers = rows.map((r) => r.container!);
  // A lone example's container may be just the option list; widen it to include the stem.
  containers = containers.map((c, i) => (rows[i]!.stem === c ? (c.parentElement ?? c) : c));

  const question = commonSelector(
    containers,
    root,
    rows.map((r) => r.stem),
  );
  if (!question) return fail('找不到能选中所有题目容器的选择器');
  const stem = relativeSelector(
    rows.map((r, i) => ({ container: containers[i]!, targets: [r.stem] })),
  );
  if (!stem) return fail(`找不到题干的选择器（容器 ${question}）`);

  const withOptions = rows
    .map((r, i) => ({ container: containers[i]!, targets: r.options }))
    .filter((p) => p.targets.length);
  const withBlanks = rows
    .map((r, i) => ({ container: containers[i]!, targets: r.blanks }))
    .filter((p) => p.targets.length);
  const option = withOptions.length ? relativeSelector(withOptions) : undefined;
  const blank = withBlanks.length ? relativeSelector(withBlanks) : undefined;
  if (option === null) return fail(`找不到选项的选择器（容器 ${question}，题干 ${stem}）`);
  if (blank === null) return fail(`找不到填空框的选择器（容器 ${question}，题干 ${stem}）`);

  const rule: SiteRule = {
    version: 1,
    question,
    stem,
    ...(option ? { option } : {}),
    ...(blank ? { blank } : {}),
  };
  // Must reproduce every example: same stem element, same option rows.
  const applied = applyRule(rule, root, layout);
  if (!applied)
    return fail(
      `规则套用失败（选择器匹配到嵌套元素，或多数匹配读不出题）：${JSON.stringify(rule)}`,
    );
  const ok = rows.every((r, i) =>
    applied.some(
      (e) =>
        e.anchor.block === containers[i] &&
        (r.options.length === 0 ||
          (e.anchor.type === 'choice' && e.anchor.options.length === r.options.length)),
    ),
  );
  return ok ? rule : fail(`规则读出的题目和模型标注的不一致：${JSON.stringify(rule)}`);
}

/**
 * The markup around a question, tags and classes only with short text, so a debug log shows
 * why a rule did or didn't fit without dumping the page.
 */
export function skeleton(el: Element, depth = 0): string {
  const pad = '  '.repeat(depth);
  const cls = el.getAttribute('class');
  const tag = `${el.tagName.toLowerCase()}${cls ? `.${cls.trim().split(/\s+/).join('.')}` : ''}`;
  const own = [...el.childNodes]
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent!.trim())
    .join(' ')
    .slice(0, 30);
  const head = `${pad}${tag}${own ? ` "${own}"` : ''}`;
  if (depth >= 6) return el.childElementCount ? `${head} …` : head;
  const kids = [...el.children].slice(0, 12).map((c) => skeleton(c, depth + 1));
  if (el.childElementCount > 12) kids.push(`${pad}  …（还有 ${el.childElementCount - 12} 个）`);
  return [head, ...kids].join('\n');
}
