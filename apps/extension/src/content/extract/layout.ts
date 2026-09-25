/** Layout queries, injectable so the extractor can run under jsdom (which has no layout). */
export interface Layout {
  visible(el: Element): boolean;
  size(el: Element): { width: number; height: number };
  /** Looks clickable (hand cursor): a hint for custom option widgets built from plain divs. */
  clickable(el: Element): boolean;
}

export const domLayout: Layout = {
  visible(el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({
        visibilityProperty: true,
        checkVisibilityCSS: true,
      } as CheckVisibilityOptions);
    }
    return true;
  },
  size(el) {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  },
  clickable(el) {
    return getComputedStyle(el).cursor === 'pointer';
  },
};
