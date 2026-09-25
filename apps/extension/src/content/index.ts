import type { Answer, Mark, MarkedQuestion } from '@quizpilot/shared';
import type {
  FillRequest,
  FrameExtract,
  LearnOutcome,
  NextFound,
  PanelItem,
  PanelState,
  Rect,
  Reveal,
  RuntimeMessage,
  Viewport,
} from '../lib/protocol';
import { extractGeneric, withAnswerKeys, type Anchor, type Extracted } from './extract/generic';
import { applyRule, deriveRule, ruleKey, skeleton, type SiteRule } from './extract/rules';
import { lowestCommonAncestor } from './extract/dom';
import { fillAnswers, press, type FillOutcome, type Undo } from './fill/fill';
import { findNext } from './fill/next';
import { findCaptcha } from './fill/captcha';
import { clearHighlights, highlightAnswers } from './fill/highlight';
import { domLayout } from './extract/layout';
import { closePanel, renderPanel } from './ui/panel';
import { clearMarks, collectMarks, drawMarks, type MarkedElement } from './ui/marks';
import { selectRegion } from './ui/region';

/** API the background calls through chrome.scripting.executeScript({ func }). */
export interface ContentApi {
  /** Read with this page's learned rule if one fits, else the generic reader. */
  extract(rules?: Record<string, SiteRule>): FrameExtract;
  /** Number the on-screen elements for a set-of-marks screenshot. */
  marks(): Mark[];
  clearMarks(): void;
  /** Learn and apply a rule from the model's labels on the last marks(). Null if none fits. */
  learn(labels: MarkedQuestion[]): LearnOutcome;
  viewport(): Viewport;
  /** The page's URL and title; the background can't see tab.url without a host permission. */
  page(): { url: string; title: string };
  reveal(localId: string): Promise<Reveal | null>;
  fill(req: FillRequest): Promise<FillOutcome[]>;
  undo(): boolean;
  panel(state: PanelState | null): void;
  focus(localId: string): void;
  selectRegion(): Promise<Rect | null>;
  /** Find the "next question" control and, if `click`, press it. Submit buttons are never pressed. */
  next(click: boolean): Promise<NextFound>;
  /** A visible verification challenge (what was found), or null. Detected only, never solved. */
  captcha(): string | null;
  /** Assist mode: outline the suggested options for the user to click. Returns how many. */
  highlight(answers: Answer[]): number;
  clearHighlights(): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __quizpilot: ContentApi | undefined;
}

if (!globalThis.__quizpilot) {
  let anchors = new Map<string, Extracted>();
  let lastUndo: Undo | null = null;
  let marked: MarkedElement[] = [];

  const viewport = (): Viewport => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  });

  const regionOf = (anchor: Anchor): Rect => {
    const rects = [anchor.block, ...anchor.stemEls].map((e) => e.getBoundingClientRect());
    const x = Math.min(...rects.map((r) => r.left));
    const y = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return { x, y, width: right - x, height: bottom - y };
  };

  /**
   * After the extension is updated or reloaded, this copy of the script is orphaned: its panel is
   * still on the page but chrome.runtime is gone (or throws "Extension context invalidated").
   */
  const orphaned = () =>
    renderPanel(
      {
        // chrome.i18n is gone with chrome.runtime here: pick the language ourselves.
        status: navigator.language.toLowerCase().startsWith('zh')
          ? 'QuizPilot 已更新，请刷新页面后再试'
          : 'QuizPilot was updated. Reload the page and try again.',
        tone: 'error',
        items: [],
        canFill: false,
        canUndo: false,
      },
      { onFill() {}, onUndo() {}, onStop() {}, onFocus() {}, onClose: closePanel },
    );
  const send = (msg: RuntimeMessage) => {
    if (!chrome.runtime?.id) return orphaned();
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      orphaned();
    }
  };

  const api: ContentApi = {
    extract(rules) {
      const key = ruleKey(location);
      const rule = rules?.[key];
      const applied = rule ? applyRule(rule) : null;
      const byRule = applied && withAnswerKeys(applied);
      const found = byRule ?? extractGeneric(document);
      anchors = new Map(found.map((e) => [e.question.id, e]));
      return {
        title: document.title,
        viewport: viewport(),
        questions: found.map(({ question, status, reason }) => ({
          question,
          status,
          ...(reason ? { reason } : {}),
        })),
        via: byRule ? 'rule' : 'generic',
        ruleKey: key,
        ruleFailed: !!rule && !byRule,
      };
    },

    marks() {
      marked = collectMarks();
      drawMarks(marked);
      return marked.map(({ id, tag, text }) => ({ id, tag, text }));
    },

    clearMarks,

    learn(labels) {
      const byId = new Map(marked.map((m) => [m.id, m.el]));
      const examples = labels.flatMap((l) => {
        const stem = byId.get(l.stem);
        const options = l.options.map((n) => byId.get(n)).filter((e): e is Element => !!e);
        const blanks = l.inputs.map((n) => byId.get(n)).filter((e): e is Element => !!e);
        return stem && (options.length >= 2 || blanks.length) ? [{ stem, options, blanks }] : [];
      });
      marked = [];
      let failed = '';
      const rule = deriveRule(examples, document, domLayout, (why) => (failed = why));
      const applied = rule ? applyRule(rule) : null;
      const found = applied && withAnswerKeys(applied);
      if (!rule || !found) {
        // The markup around the first labelled question, to see in the log why no rule fit.
        const first = examples[0];
        const around =
          first && lowestCommonAncestor([first.stem, ...first.options, ...first.blanks]);
        return {
          failed: failed || '规则套用失败',
          ...(around ? { skeleton: skeleton(around.parentElement ?? around) } : {}),
        };
      }
      anchors = new Map(found.map((e) => [e.question.id, e]));
      return { learned: { ruleKey: ruleKey(location), rule, questions: found.length } };
    },

    viewport,

    page: () => ({ url: location.href, title: document.title }),

    async reveal(localId) {
      const hit = anchors.get(localId);
      if (!hit) return null;
      hit.anchor.block.scrollIntoView({ block: 'center', inline: 'nearest' });
      // Wait for scrolling, sticky headers and lazy images to settle.
      await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const vp = viewport();
      const r = regionOf(hit.anchor);
      const pad = 8;
      const x = Math.max(0, r.x - pad);
      const y = Math.max(0, r.y - pad);
      const rect = {
        x,
        y,
        width: Math.min(vp.width, r.x + r.width + pad) - x,
        height: Math.min(vp.height, r.y + r.height + pad) - y,
      };
      return rect.width > 0 && rect.height > 0 ? { rect, viewport: vp } : null;
    },

    async fill({ answers, humanize }) {
      const items = answers.flatMap((answer: Answer) => {
        const hit = anchors.get(answer.id);
        return hit ? [{ answer, anchor: hit.anchor }] : [];
      });
      const { outcomes, undo } = await fillAnswers(items, { humanize });
      lastUndo = undo;
      return outcomes;
    },

    undo() {
      if (!lastUndo) return false;
      lastUndo();
      lastUndo = null;
      return true;
    },

    panel(state) {
      if (!state) return closePanel();
      renderPanel(state, {
        onFill: () => send({ type: 'qp:fill' }),
        onUndo: () => send({ type: 'qp:undo' }),
        onStop: () => send({ type: 'qp:stop' }),
        onClose: () => {
          closePanel();
          send({ type: 'qp:close' });
        },
        onFocus: (item: PanelItem) => {
          if (item.frameId === 0) api.focus(item.localId);
        },
      });
    },

    focus(localId) {
      const hit = anchors.get(localId);
      if (!hit) return;
      const block = hit.anchor.block as HTMLElement;
      block.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const prev = block.style.outline;
      block.style.outline = '2px solid #3b5bdb';
      setTimeout(() => (block.style.outline = prev), 1500);
    },

    selectRegion,

    captcha: () => findCaptcha(document, domLayout),

    highlight(answers) {
      const items = answers.flatMap((answer) => {
        const hit = anchors.get(answer.id);
        return hit ? [{ answer, anchor: hit.anchor }] : [];
      });
      return highlightAnswers(items);
    },

    clearHighlights,

    async next(click) {
      const found = findNext(document, domLayout);
      if (!found) return null;
      if (found.kind === 'submit' || !click) return { kind: found.kind, label: found.label };
      found.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await new Promise((r) => setTimeout(r, 150));
      press(found.el);
      return { kind: 'next', label: found.label };
    },
  };

  globalThis.__quizpilot = api;
}
