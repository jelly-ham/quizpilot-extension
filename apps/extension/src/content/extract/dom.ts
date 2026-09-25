/** Host element of our own UI; everything inside it is ignored by the extractor. */
export const UI_HOST_ID = 'quizpilot-root';

/** querySelectorAll that also descends into open shadow roots. */
export function deepQueryAll<T extends Element = Element>(root: ParentNode, selector: string): T[] {
  const out: T[] = [];
  const visit = (node: ParentNode) => {
    out.push(...(node.querySelectorAll(selector) as NodeListOf<T>));
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(root);
  return out;
}

/** Parent across shadow boundaries. */
export function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

export function containsDeep(ancestor: Element, node: Element): boolean {
  for (let cur: Element | null = node; cur; cur = parentOf(cur)) {
    if (cur === ancestor) return true;
  }
  return false;
}

export function ancestors(el: Element): Element[] {
  const out: Element[] = [];
  for (let cur = parentOf(el); cur; cur = parentOf(cur)) out.push(cur);
  return out;
}

export function lowestCommonAncestor(els: Element[]): Element | null {
  if (els.length === 0) return null;
  const first = [els[0]!, ...ancestors(els[0]!)];
  return first.find((a) => els.every((e) => containsDeep(a, e))) ?? null;
}

/** Document order comparison usable with Array.sort. */
export function byDocumentOrder(a: Element, b: Element): number {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/** Our panel, region selector and set-of-marks overlay all use ids starting with UI_HOST_ID. */
export function isInsideOwnUi(el: Element): boolean {
  return [el, ...ancestors(el)].some((a) => a.id.startsWith(UI_HOST_ID));
}
