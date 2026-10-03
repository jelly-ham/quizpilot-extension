import type { Rect, Viewport } from '../lib/protocol';

/** Chrome allows ~2 captureVisibleTab calls per second. */
const MIN_CAPTURE_INTERVAL_MS = 600;
let lastCapture = 0;

/** The run's tab is the one its window shows, and the window isn't minimized. */
export async function isFront(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.active) return false;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  return !!win && win.state !== 'minimized';
}

/**
 * Screenshot of `tab`. captureVisibleTab shoots whatever its window shows, so this refuses when
 * `tab` isn't in front: another page must never be captured (or sent to a model) in its place.
 */
export async function captureVisible(tab: { id?: number; windowId: number }): Promise<string> {
  if (tab.id === undefined || !(await isFront(tab.id)))
    throw new Error('the quiz tab is not in front; screenshots need it visible');
  const wait = lastCapture + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCapture = Date.now();
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
}

export interface Cropped {
  dataUrl: string;
  /** Multiply viewport CSS px (relative to the crop origin) by this to get output pixels. */
  scale: number;
  origin: { x: number; y: number };
}

/** Crop a screenshot to `rect` (viewport CSS px, or null for the whole viewport) as a JPEG. */
export async function cropToJpeg(
  screenshot: string,
  rect: Rect | null,
  viewport: Viewport,
  maxEdge = 1600,
): Promise<Cropped> {
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  // Screenshot pixels per CSS px; accounts for devicePixelRatio and page zoom.
  const px = bitmap.width / viewport.width;
  const r = rect ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const sx = clamp(Math.round(r.x * px), 0, bitmap.width - 1);
  const sy = clamp(Math.round(r.y * px), 0, bitmap.height - 1);
  const sw = clamp(Math.round(r.width * px), 1, bitmap.width - sx);
  const sh = clamp(Math.round(r.height * px), 1, bitmap.height - sy);
  const k = Math.min(1, maxEdge / Math.max(sw, sh));
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(sw * k)),
    Math.max(1, Math.round(sh * k)),
  );
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return { dataUrl: await blobToDataUrl(blob), scale: px * k, origin: { x: r.x, y: r.y } };
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}
