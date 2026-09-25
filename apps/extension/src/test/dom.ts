import type { Layout } from '../content/extract/layout';

/** jsdom has no layout: treat everything as visible, use width/height attributes as size. */
export const testLayout: Layout = {
  visible: (el) => !el.closest('[hidden], [style*="display:none"], [style*="display: none"]'),
  // Inline styles don't inherit in jsdom; treat `cursor: pointer` on the element or a close ancestor as clickable.
  clickable: (el) =>
    !!el.closest('[style*="cursor:pointer"], [style*="cursor: pointer"], [data-pointer]'),
  size: (el) => ({
    width: Number(el.getAttribute('width')) || 0,
    height: Number(el.getAttribute('height')) || 0,
  }),
};

export function mount(html: string): HTMLElement {
  document.body.innerHTML = `<main>${html}</main>`;
  return document.body.firstElementChild as HTMLElement;
}
