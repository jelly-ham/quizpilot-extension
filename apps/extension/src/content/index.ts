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
  WatchSpec,
} from '../lib/protocol';
import { extractGeneric, withAnswerKeys, type Anchor, type Extracted } from './extract/generic';
import { applyRule, deriveRule, ruleKey, skeleton, type SiteRule } from './extract/rules';
import { lowestCommonAncestor } from './extract/dom';
import { fillAnswers, press, type FillOutcome, type Undo } from './fill/fill';
import { findNext } from './fill/next';
import { findCaptcha } from './fill/captcha';
import { clearHighlights, highlightAnswers } from './fill/highlight';
import { AnswerWatch, suggested } from './fill/watch';
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
  highlight(answers: Answer[], watch?: WatchSpec): number;
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

  // ------------------------------------------------------------ answer watch (paid mode)
  // One run's questions at a time: a new run in this frame reports the previous one first.
  let watch: AnswerWatch | null = null;
  let watchTimer: ReturnType<typeof setInterval> | undefined;

  const endWatch = () => {
    if (!watch) return;
    watch.check();
    watch.flush();
    watch = null;
    clearInterval(watchTimer);
  };
  const tickWatch = () => {
    if (watch?.check()) endWatch();
  };
  // After the page's own handlers have run, so the controls show the new state.
  const soon = () => setTimeout(tickWatch, 50);
  for (const type of ['change', 'input', 'click'])
    document.addEventListener(type, soon, { capture: true, passive: true });
  // Leaving the page: report what it showed last.
  window.addEventListener('pagehide', endWatch);

  const armWatch = (
    spec: WatchSpec,
    items: { id: string; anchor: Anchor; expected?: string }[],
  ) => {
    if (!items.length) return;
    if (watch && watch.runId !== spec.runId) endWatch();
    // Quietly: unlike a button press, a report after an extension update must not show a panel.
    watch ??= new AnswerWatch(spec.runId, spec.share, (verdicts) => {
      try {
        if (chrome.runtime?.id)
          chrome.runtime
            .sendMessage({ type: 'qp:verdicts', runId: spec.runId, verdicts } as RuntimeMessage)
            .catch(() => {});
      } catch {
        // Orphaned after an update: the verdicts are lost, nothing else.
      }
    });
    for (const i of items) watch.add(i.id, i.anchor, i.expected);
    clearInterval(watchTimer);
    watchTimer = setInterval(tickWatch, 5_000);
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
      // Wait for scrolling, sticky headers and lazy images to settle. A background tab gets no
      // animation frames, so the frame wait is capped instead of hanging the run.
      await new Promise((r) => setTimeout(r, 250));
      await Promise.race([
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        new Promise((r) => setTimeout(r, 200)),
      ]);
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

    async fill({ answers, humanize, watch: spec }) {
      const items = answers.flatMap((answer: Answer) => {
        const hit = anchors.get(answer.id);
        return hit ? [{ answer, anchor: hit.anchor }] : [];
      });
      // The previous run's verdicts reflect the page before this fill changes it.
      if (spec && watch && watch.runId !== spec.runId) endWatch();
      const { outcomes, undo } = await fillAnswers(items, { humanize });
      lastUndo = undo;
      if (spec) {
        const ok = new Set(outcomes.filter((o) => o.ok).map((o) => o.id));
        armWatch(
          spec,
          items
            .filter((i) => ok.has(i.answer.id))
            .map((i) => ({
              id: i.answer.id,
              anchor: i.anchor,
              // Choice questions: compare with the answer, not with what the page shows at
              // this instant (some sites settle a tick later).
              expected: suggested(i.answer, i.anchor) ?? undefined,
            })),
        );
      }
      return outcomes;
    },

    undo() {
      if (!lastUndo) return false;
      // Undoing is not the user rejecting the answers: report nothing for them.
      if (watch) {
        watch.discard();
        watch = null;
        clearInterval(watchTimer);
      }
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

    highlight(answers, spec) {
      const items = answers.flatMap((answer) => {
        const hit = anchors.get(answer.id);
        return hit ? [{ answer, anchor: hit.anchor }] : [];
      });
      if (spec && watch && watch.runId !== spec.runId) endWatch();
      const count = highlightAnswers(items);
      if (spec)
        armWatch(
          spec,
          items.flatMap(({ answer, anchor }) => {
            const expected = suggested(answer, anchor);
            return expected === null ? [] : [{ id: answer.id, anchor, expected }];
          }),
        );
      return count;
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
