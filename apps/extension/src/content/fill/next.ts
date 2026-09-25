import { deepQueryAll, isInsideOwnUi } from '../extract/dom';
import type { Layout } from '../extract/layout';

/**
 * "Next question" controls, compared without spaces, punctuation and symbols ("Next ❯",
 * "下一题 >>"). Short labels only, so a sentence containing 下一题 doesn't count.
 */
const NEXT = /^(下一题|下一道|下一步|下一页|下一个|继续|继续答题|next|nextquestion|continue)$/i;
const squash = (t: string) => t.replace(/[\s\p{P}\p{S}]/gu, '');
/** Never pressed automatically: submitting stays the user's decision. */
const SUBMIT = /提交|交卷|完成|结束|submit|finish|done/i;
const DISABLED_CLASS = /(^|[\s_-])(disabled|is-disabled)(\s|$)/i;

const CANDIDATES = 'button, a, [role=button], input[type=button], input[type=submit], div, span';
/** Site navigation and list pagination (h5p.org's "next ›" pages through the site). */
const CHROME =
  'nav, header, footer, [role=navigation], [role=tablist], [role=menu], [role=menubar], .pager, .pagination, [class*="pagination"], [class*="pager"]';

/** Visible text, or for icon-only buttons their aria-label / title. */
function label(el: Element): string {
  const text = (el instanceof HTMLInputElement ? el.value : el.textContent) ?? '';
  const named = text.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '';
  return named.replace(/\s+/g, ' ').trim();
}

function disabled(el: Element): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute('aria-disabled') === 'true' ||
    DISABLED_CLASS.test(el.getAttribute('class') ?? '')
  );
}

export type NextControl =
  { kind: 'next'; el: Element; label: string } | { kind: 'submit'; label: string } | null;

/**
 * The page's "next question" control, if any. Reports a submit-only page separately so the
 * caller can stop there instead of guessing.
 */
export function findNext(root: ParentNode, layout: Layout): NextControl {
  let submit: string | null = null;
  const hits: { el: Element; label: string }[] = [];
  for (const el of deepQueryAll(root, CANDIDATES)) {
    if (isInsideOwnUi(el) || el.closest(CHROME) || !layout.visible(el)) continue;
    const text = label(el);
    if (!text || text.length > 12) continue;
    if (SUBMIT.test(text)) {
      if (!disabled(el)) submit ??= text;
      continue;
    }
    if (!NEXT.test(squash(text)) || disabled(el)) continue;
    // A div/span only counts when it looks clickable; buttons and links always do.
    const native = el.matches('button, a, [role=button], input');
    if (!native && !layout.clickable(el)) continue;
    hits.push({ el, label: text });
  }
  // Nested matches (button > span "下一题"): press the outermost.
  const outer = hits.filter((h) => !hits.some((o) => o !== h && o.el.contains(h.el)));
  const first = outer[0];
  if (first) return { kind: 'next', ...first };
  return submit ? { kind: 'submit', label: submit } : null;
}
