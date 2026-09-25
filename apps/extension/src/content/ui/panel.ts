import type { PanelItem, PanelState } from '../../lib/protocol';
import { UI_HOST_ID } from '../extract/dom';
import { t } from '../../lib/i18n';

const CSS = `
:host { all: initial; }
.panel {
  /* Shown as a popover so it sits in the top layer, above the page's own modals. */
  position: fixed; inset: auto 16px 16px auto; margin: 0; padding: 0; overflow: hidden; z-index: 2147483647;
  width: min(380px, calc(100vw - 32px)); max-height: min(70vh, 640px);
  display: flex; flex-direction: column;
  background: #fff; color: #152238; border: 1px solid #e4ded0; border-radius: 16px;
  box-shadow: 0 16px 40px -8px rgba(27, 42, 74, .28);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .panel { background: #182236; color: #eef0f4; border-color: #2a3650; }
  .item { border-color: #232e45 !important; }
  .stem, .meta { color: #9ba2b5 !important; }
  .ghost { color: #eef0f4 !important; border-color: #3a4763 !important; }
  .stop { background: #eef0f4 !important; color: #152238 !important; }
  .tag { background: rgba(240,138,85,.16) !important; color: #f08a55 !important; }
}
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(127,127,127,.2); }
.title { font-weight: 700; letter-spacing: -.01em; }
.title b { color: #c4501a; }
.status { flex: 1; font-size: 12px; color: #6b675d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status.error { color: #b42318; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #2f7a4b; flex: none; }
.dot.busy { background: #c4501a; }
@media (prefers-reduced-motion: no-preference) {
  .dot.busy { animation: pulse 1s infinite alternate; }
}
.dot.error { background: #b42318; }
@keyframes pulse { to { opacity: .3; } }
.close { border: none; background: none; font-size: 18px; line-height: 1; cursor: pointer; color: inherit; opacity: .6; }
.list { overflow-y: auto; padding: 4px 12px; }
.item {
  display: block; width: 100%; padding: 8px 0; margin: 0; border: none; border-bottom: 1px solid #efeae0;
  background: none; color: inherit; font: inherit; text-align: start; cursor: pointer;
}
.item > span { display: block; }
.item:focus-visible, button:focus-visible { outline: 2px solid #c4501a; outline-offset: 2px; }
.item:last-child { border-bottom: none; }
.item > .stem { color: #6b675d; font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.answer { font-weight: 600; margin-top: 2px; white-space: pre-wrap; word-break: break-word; }
.err { color: #b42318; margin-top: 2px; }
.item > .meta { font-size: 11px; color: #6b675d; margin-top: 2px; display: flex; gap: 6px; flex-wrap: wrap; }
.tag { padding: 0 6px; border-radius: 999px; background: #fbe9df; color: #a8430f; }
.actions { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid rgba(127,127,127,.2); }
button.primary, button.ghost, button.stop { flex: 1; height: 32px; border-radius: 10px; font: inherit; font-weight: 600; cursor: pointer; }
.primary { background: #c4501a; color: #fff; border: none; }
.stop { background: #152238; color: #f5f2ea; border: none; }
.ghost { background: transparent; border: 1px solid #d9d2c2; color: #152238; }
button:disabled { opacity: .4; cursor: not-allowed; }
.footer { padding: 0 12px 10px; font-size: 11px; color: #6b675d; }
`;

let host: HTMLElement | null = null;

function root(): ShadowRoot {
  if (host?.isConnected) return host.shadowRoot!;
  // A panel left by the previous version of the extension (updated without reloading the page).
  document.getElementById(UI_HOST_ID)?.remove();
  host = document.createElement('div');
  host.id = UI_HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.append(style);
  document.documentElement.append(host);
  return shadow;
}

export interface PanelHandlers {
  onFill(): void;
  onUndo(): void;
  onStop(): void;
  onClose(): void;
  onFocus(item: PanelItem): void;
}

export function renderPanel(state: PanelState, handlers: PanelHandlers) {
  const shadow = root();
  shadow.querySelector('.panel')?.remove();
  const panel = el('section', 'panel');
  panel.setAttribute('aria-label', 'QuizPilot');

  const head = el('div', 'head');
  const title = el('span', 'title', 'Quiz');
  title.append(el('b', '', 'Pilot'));
  head.append(el('span', `dot ${state.tone === 'done' ? '' : state.tone}`), title);
  const status = el('span', `status ${state.tone === 'error' ? 'error' : ''}`, state.status);
  status.setAttribute('role', state.tone === 'error' ? 'alert' : 'status');
  head.append(status);
  const close = el('button', 'close', '×');
  close.title = t('ui_close');
  close.setAttribute('aria-label', t('ui_close'));
  close.onclick = handlers.onClose;
  head.append(close);
  panel.append(head);

  if (state.items.length) {
    const list = el('div', 'list');
    for (const item of state.items) list.append(renderItem(item, handlers));
    panel.append(list);
  }

  if (state.canStop) {
    const actions = el('div', 'actions');
    const stop = el('button', 'stop', t('ui_stop')) as HTMLButtonElement;
    stop.onclick = () => {
      stop.disabled = true;
      stop.textContent = t('ui_stopping');
      handlers.onStop();
    };
    actions.append(stop);
    panel.append(actions);
  } else if (state.canFill || state.canUndo) {
    const actions = el('div', 'actions');
    const fill = el('button', 'primary', t('ui_fill')) as HTMLButtonElement;
    fill.disabled = !state.canFill;
    fill.onclick = handlers.onFill;
    const undo = el('button', 'ghost', t('ui_undo')) as HTMLButtonElement;
    undo.disabled = !state.canUndo;
    undo.onclick = handlers.onUndo;
    actions.append(fill, undo);
    panel.append(actions);
  }
  if (state.footer) panel.append(el('div', 'footer', state.footer));
  shadow.append(panel);
  // Top layer where supported, so page overlays and modal dialogs can't cover the panel.
  if ('showPopover' in panel) {
    panel.popover = 'manual';
    panel.showPopover();
  }
}

function renderItem(item: PanelItem, handlers: PanelHandlers): HTMLElement {
  // A button (with phrasing content only) so the list works from the keyboard.
  const row = el('button', 'item') as HTMLButtonElement;
  row.type = 'button';
  row.onclick = () => handlers.onFocus(item);
  // Most pages number their own questions; don't print "1. 1. …".
  const numbered = /^\s*[(（]?(\d+|[一二三四五六七八九十百]+)\s*[.、．)）:：]/.test(item.stem);
  row.append(el('span', 'stem', numbered ? item.stem : `${item.index}. ${item.stem}`));
  if (item.answer) row.append(el('span', 'answer', item.answer));
  if (item.error) row.append(el('span', 'err', item.error));
  const meta = el('span', 'meta');
  if (item.confidence !== undefined)
    meta.append(el('span', '', t('ui_confidence', { p: Math.round(item.confidence * 100) })));
  for (const t of item.tags) meta.append(el('span', 'tag', t));
  if (meta.childElementCount) row.append(meta);
  return row;
}

export function closePanel() {
  host?.remove();
  host = null;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
