import type { Rect } from '../../lib/protocol';
import { UI_HOST_ID } from '../extract/dom';
import { t } from '../../lib/i18n';

/** Let the user drag a rectangle over the page. Resolves null on Esc or a tiny drag. */
export function selectRegion(): Promise<Rect | null> {
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.id = `${UI_HOST_ID}-region`;
    Object.assign(layer.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      cursor: 'crosshair',
      background: 'rgba(15, 20, 40, 0.25)',
    });
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed',
      border: '2px solid #3b5bdb',
      background: 'rgba(59, 91, 219, 0.12)',
      display: 'none',
    });
    const tip = document.createElement('div');
    tip.textContent = t('ui_regionTip');
    Object.assign(tip.style, {
      position: 'fixed',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '6px 12px',
      borderRadius: '8px',
      background: '#1c1d21',
      color: '#fff',
      font: "13px system-ui, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif",
    });
    layer.append(box, tip);
    document.documentElement.append(layer);

    let start: { x: number; y: number } | null = null;
    let rect: Rect | null = null;
    const done = (result: Rect | null) => {
      layer.remove();
      window.removeEventListener('keydown', onKey, true);
      // Let the overlay disappear from the next paint before the screenshot.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    layer.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY };
      layer.setPointerCapture(e.pointerId);
    });
    layer.addEventListener('pointermove', (e) => {
      if (!start) return;
      rect = {
        x: Math.min(start.x, e.clientX),
        y: Math.min(start.y, e.clientY),
        width: Math.abs(e.clientX - start.x),
        height: Math.abs(e.clientY - start.y),
      };
      Object.assign(box.style, {
        display: 'block',
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    });
    layer.addEventListener('pointerup', () =>
      done(rect && rect.width > 20 && rect.height > 20 ? rect : null),
    );
  });
}
