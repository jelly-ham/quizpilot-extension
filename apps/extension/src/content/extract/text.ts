import type { Layout } from './layout';

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'BUTTON',
  'OPTION',
  'SELECT',
]);
const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'TR',
  'TD',
  'TH',
  'TABLE',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BR',
  'FIELDSET',
  'LEGEND',
  'LABEL',
  'DT',
  'DD',
  'PRE',
  'BLOCKQUOTE',
]);

export interface TextOptions {
  layout: Layout;
  /** Elements to leave out entirely (option rows when reading a stem, other groups, ...). */
  exclude?: (el: Element) => boolean;
  /** Replacement text for an element, e.g. "___" for a blank input. null = default handling. */
  replace?: (el: Element) => string | null;
}

/** Readable text of a subtree: visible text, image alts, and math as $TeX$. */
export function readableText(root: Node, opts: TextOptions): string {
  const parts: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    // Skipped inside what we read (a "submit" button in a question card), but not when it is what
    // we read: options are often buttons (<button class="option">bite the bullet</button>).
    if ((node !== root && SKIP_TAGS.has(el.tagName)) || opts.exclude?.(el)) return;

    const replaced = opts.replace?.(el);
    if (replaced != null) {
      parts.push(replaced);
      return;
    }
    const math = mathText(el);
    if (math != null) {
      parts.push(math);
      return;
    }
    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt')?.trim();
      if (alt) parts.push(`[图片: ${alt}]`);
      return;
    }
    if (el.getAttribute('aria-hidden') === 'true' || !opts.layout.visible(el)) return;

    const block = BLOCK_TAGS.has(el.tagName);
    if (block) parts.push('\n');
    const children = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
    children.forEach(visit);
    if (block) parts.push('\n');
  };
  visit(root);
  return normalizeSpace(parts.join(''));
}

/** TeX source for KaTeX / MathJax / MathML, when the element is a math container. */
function mathText(el: Element): string | null {
  if (el.classList.contains('katex') || el.classList.contains('katex-display')) {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex) return ` $${tex.trim()}$ `;
  }
  if (el.tagName === 'SCRIPT' && el.getAttribute('type')?.startsWith('math/tex')) {
    return ` $${el.textContent?.trim() ?? ''}$ `;
  }
  if (el.tagName.toLowerCase() === 'mjx-container') {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    const label = tex ?? el.getAttribute('aria-label');
    if (label) return ` $${label.trim()}$ `;
  }
  if (el.tagName.toLowerCase() === 'math') {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    return ` $${(tex ?? el.getAttribute('alttext') ?? el.textContent ?? '').trim()}$ `;
  }
  return null;
}

export function normalizeSpace(s: string): string {
  return s
    .replace(/[ \t\f\v 　]+/g, ' ')
    .replace(/ *\n[\n ]*/g, '\n')
    .trim();
}

/** Characters from the Private Use Area or replacement chars: a sign of font-based obfuscation. */
export function looksGarbled(s: string): boolean {
  return /[-�]/.test(s);
}

/** Letters, digits or CJK characters, ignoring blanks and punctuation. */
export function meaningfulLength(s: string): number {
  return s.replace(/_{2,}|[\s\p{P}\p{S}]/gu, '').length;
}
