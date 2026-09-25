import type { Mark } from '@quizpilot/shared';
import { deepQueryAll, isInsideOwnUi, UI_HOST_ID } from '../extract/dom';
import { TEXT_SELECTOR } from '../extract/generic';
import { domLayout, type Layout } from '../extract/layout';
import { readableText } from '../extract/text';

const MAX_MARKS = 200;
const OVERLAY_ID = `${UI_HOST_ID}-marks`;
const CONTROLS = `${TEXT_SELECTOR}, select, input[type=radio], input[type=checkbox]`;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HTML', 'BODY', 'HEAD']);

export interface MarkedElement extends Mark {
  el: Element;
}

/**
 * Elements on screen a question could be made of: anything with its own text, plus inputs.
 * Numbered in document order for the set-of-marks screenshot.
 */
export function collectMarks(layout: Layout = domLayout): MarkedElement[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out: MarkedElement[] = [];
  for (const el of deepQueryAll(document, '*')) {
    if (out.length >= MAX_MARKS) break;
    if (SKIP.has(el.tagName) || isInsideOwnUi(el)) continue;
    const isControl = el.matches(CONTROLS);
    const ownText = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
    );
    if (!isControl && !ownText) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw)
      continue;
    if (!layout.visible(el)) continue;
    const text = isControl
      ? (el.getAttribute('placeholder') ?? el.getAttribute('aria-label') ?? '').slice(0, 200)
      : readableText(el, { layout }).slice(0, 200);
    if (!isControl && !text) continue;
    out.push({ id: out.length + 1, el, tag: el.tagName.toLowerCase(), text });
  }
  return out;
}

/** Draw a numbered badge on each element; removed again right after the screenshot. */
export function drawMarks(marks: MarkedElement[]) {
  clearMarks();
  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    .box { position: fixed; border: 1px solid rgba(224, 49, 49, .75); pointer-events: none; z-index: 2147483646; }
    .tag { position: fixed; background: #e03131; color: #fff; font: 700 11px/14px system-ui, sans-serif;
      padding: 0 3px; border-radius: 3px; pointer-events: none; z-index: 2147483647; }`;
  shadow.append(style);
  for (const m of marks) {
    const r = m.el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'box';
    Object.assign(box.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = String(m.id);
    // Above the element when there is room, so the badge doesn't hide its text.
    Object.assign(tag.style, {
      left: `${Math.max(0, r.left)}px`,
      top: `${r.top >= 14 ? r.top - 14 : r.top}px`,
    });
    shadow.append(box, tag);
  }
  document.documentElement.append(host);
}

export function clearMarks() {
  document.getElementById(OVERLAY_ID)?.remove();
}
