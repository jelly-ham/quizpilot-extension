import type { Answer } from '@quizpilot/shared';
import type { Anchor } from '../extract/generic';
import { wantedKeys } from './fill';
import { t } from '../../lib/i18n';

/** Below this, the outline is orange and says the suggestion is uncertain. */
const LOW_CONFIDENCE = 0.6;

type Marked = { el: HTMLElement; outline: string; offset: string; title: string | null };
/** Every outline on the page, across calls: a page with all its questions at once is marked
 * a few at a time as the user works through it. */
const marked: Marked[] = [];

/**
 * Assist mode: mark the suggested answers on the page and let the user click them. Nothing on
 * the page is clicked or typed into; only outlines are added (clearHighlights restores them).
 * Returns how many elements were outlined.
 */
export function highlightAnswers(items: { answer: Answer; anchor: Anchor }[]): number {
  let count = 0;
  const mark = (el: Element, title: string, unsure: boolean) => {
    const h = el as HTMLElement;
    if (!h.style) return;
    if (!marked.some((m) => m.el === h))
      marked.push({
        el: h,
        outline: h.style.outline,
        offset: h.style.outlineOffset,
        title: h.getAttribute('title'),
      });
    h.style.outline = `3px solid ${unsure ? '#f08c00' : '#2f9e44'}`;
    h.style.outlineOffset = '2px';
    h.setAttribute('title', unsure ? t('hl_unsure', { title }) : title);
    count++;
  };

  for (const { answer, anchor } of items) {
    const unsure = answer.confidence !== undefined && answer.confidence < LOW_CONFIDENCE;
    if (anchor.type === 'choice') {
      let keys: string[];
      try {
        keys = wantedKeys(answer, anchor);
      } catch {
        continue;
      }
      if (anchor.select) {
        const opt = anchor.options.find((o) => o.key === keys[0]);
        if (opt) mark(anchor.select, t('hl_suggest', { text: opt.text }), unsure);
        continue;
      }
      for (const o of anchor.options) {
        if (!keys.includes(o.key)) continue;
        // A native input is tiny or hidden; outline the row the user actually clicks.
        const target =
          o.control instanceof HTMLInputElement
            ? (o.control.closest('label') ?? o.control.parentElement ?? o.control)
            : o.control;
        mark(target, t('hl_pick'), unsure);
      }
    } else {
      const texts = Array.isArray(answer.text) ? answer.text : answer.text ? [answer.text] : [];
      anchor.blanks.forEach(
        (b, i) => texts[i] && mark(b, t('hl_suggest', { text: texts[i]! }), unsure),
      );
    }
  }
  return count;
}

export function clearHighlights() {
  for (const m of marked) {
    m.el.style.outline = m.outline;
    m.el.style.outlineOffset = m.offset;
    if (m.title === null) m.el.removeAttribute('title');
    else m.el.setAttribute('title', m.title);
  }
  marked.length = 0;
}
