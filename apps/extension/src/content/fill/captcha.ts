import { deepQueryAll, isInsideOwnUi } from '../extract/dom';
import type { Layout } from '../extract/layout';

/**
 * Verification challenges (GeeTest, which B 站 uses; reCAPTCHA; hCaptcha; Aliyun/Tencent sliders).
 * Only detected, never solved: continuous mode pauses and asks the user to complete it.
 */
const CAPTCHA_SELECTOR = [
  '[class*="geetest"]',
  '[id*="geetest"]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  'iframe[src*="captcha" i]',
  'iframe[src*="geetest"]',
  'iframe[title*="captcha" i]',
  '.nc_wrapper',
].join(', ');
const CAPTCHA_TEXT = /安全验证|人机验证|请完成验证|拖动滑块|按顺序点击|verify you are human/i;

export function findCaptcha(root: ParentNode, layout: Layout): string | null {
  for (const el of deepQueryAll(root, CAPTCHA_SELECTOR)) {
    if (isInsideOwnUi(el) || !layout.visible(el)) continue;
    const s = layout.size(el);
    if (s.width < 40 || s.height < 20) continue; // hidden stubs and tiny badges
    return el.tagName === 'IFRAME' ? 'iframe' : (el.getAttribute('class') ?? el.id);
  }
  for (const el of deepQueryAll(root, '[role=dialog], [class*="modal"], [class*="dialog"]')) {
    if (isInsideOwnUi(el) || !layout.visible(el)) continue;
    const text = el.textContent ?? '';
    if (text.length < 300 && CAPTCHA_TEXT.test(text)) return text.trim().slice(0, 40);
  }
  return null;
}
