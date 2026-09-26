import {
  MAX_QUESTIONS_PER_SOLVE,
  type Mark,
  type Answer,
  type AnswerError,
  type Question,
} from '@quizpilot/shared';
import contentScript from '../content/index.ts?iife';
import type { ContentApi } from '../content/index';
import { answerErrorMessage } from '../lib/messages';
import {
  MISSING_OPTION_TEXT,
  type FrameExtract,
  type Learned,
  type LearnOutcome,
  type NextFound,
  type PanelItem,
  type PanelState,
  type Rect,
  type Reveal,
  type RunMode,
  type Viewport,
} from '../lib/protocol';
import { logger, type Log } from '../lib/debug';
import { getRules, saveRule } from '../lib/site-rules';
import { getSettings, type Settings } from '../lib/settings';
import { captureVisible, cropToJpeg } from './capture';
import {
  entryId,
  formatAnswer,
  markUnverified,
  mergeVision,
  withFigure,
  type Entry,
} from './merge';
import { StoppedError, UserError, type Solver } from './solver';
import { t } from '../lib/i18n';

/** Screenshot reads per run; each is a paid vision call. */
const MAX_VISION_READS = 8;

type Method = keyof ContentApi;

/** Kept in chrome.storage.session: the service worker may be stopped between solving and filling. */
interface Run {
  entries: Entry[];
  /** By entry id. */
  answers: Record<string, Answer>;
  items: PanelItem[];
  filled: boolean;
  /** How the page was read, shown after the summary (e.g. learned layout). */
  note: string;
  footer?: string;
  /** Assist mode: answers are only outlined for the user; the panel offers no fill button. */
  assist?: boolean;
}

/** Page facts from the content script; tab.url is only visible with a host permission. */
interface Page {
  url: string;
  title: string;
}

const runKey = (tabId: number) => `run:${tabId}`;

async function loadRun(tabId: number): Promise<Run | undefined> {
  const key = runKey(tabId);
  return (await chrome.storage.session.get(key))[key] as Run | undefined;
}

const saveRun = (tabId: number, run: Run) => chrome.storage.session.set({ [runKey(tabId)]: run });

/**
 * Tabs with a run in progress. In memory on purpose: a run keeps the worker alive, and if the
 * worker dies anyway, a persisted flag would block the tab forever.
 */
const busy = new Set<number>();

const busyState = (status: string): PanelState => ({
  status,
  tone: 'busy',
  items: [],
  canFill: false,
  canUndo: false,
});
const errorState = (status: string): PanelState => ({ ...busyState(status), tone: 'error' });

/**
 * The one way panel state reaches the page; a closed tab or navigation is not an error.
 * False when the panel could not be shown.
 */
async function setPanel(tabId: number, state: PanelState | null): Promise<boolean> {
  try {
    await callFrames(tabId, [0], 'panel', [state]);
    return true;
  } catch {
    return false;
  }
}

/** Where errors go when the page can't show our panel (chrome:// pages, the Web Store). */
async function badge(tabId: number, error: string | null) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: error ? '!' : '' }),
    chrome.action.setTitle({
      tabId,
      title: error ? `QuizPilot：${error}` : chrome.i18n.getMessage('extShortName'),
    }),
    error ? chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' }) : undefined,
  ]).catch(() => {});
}

export type SolverFactory = (settings: Settings) => Promise<Solver>;

/** Longest a single model call may take before the run gives up on it. */
const CALL_DEADLINE_MS = 120_000;

/**
 * Wraps a solver for one run: adds up the credits spent on reads, marks and solves, gives each
 * call a deadline, and aborts calls in flight when the run is stopped (`stop`).
 */
function tracked(inner: Solver, stop: AbortSignal) {
  const bill: { charged?: number; balance?: number } = {};
  const note = <T extends { creditsCharged?: number; balance?: number }>(r: T): T => {
    if (r.creditsCharged !== undefined) bill.charged = (bill.charged ?? 0) + r.creditsCharged;
    if (r.balance !== undefined) bill.balance = r.balance;
    return r;
  };
  const guard = async <T extends { creditsCharged?: number; balance?: number }>(
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(CALL_DEADLINE_MS)]);
    try {
      return note(await call(signal));
    } catch (err) {
      if (stop.aborted) throw new StoppedError();
      if (signal.aborted) throw new UserError(t('err_timeout'));
      throw err;
    }
  };
  const solver: Solver = {
    canRead: inner.canRead,
    read: (req) => guard((signal) => inner.read(req, signal)),
    solve: (req) => guard((signal) => inner.solve(req, signal)),
    mark: (req) => guard((signal) => inner.mark(req, signal)),
  };
  return { solver, bill };
}

type PanelFn = (s: PanelState | null) => Promise<unknown>;

/** What one run needs, shared by single and continuous mode. */
interface RunCtx {
  tab: chrome.tabs.Tab;
  tabId: number;
  settings: Settings;
  solver: Solver;
  bill: { charged?: number; balance?: number };
  panel: PanelFn;
  log: Log;
}

export async function runPipeline(tab: chrome.tabs.Tab, mode: RunMode, makeSolver: SolverFactory) {
  const tabId = tab.id!;
  if (busy.has(tabId)) return;
  busy.add(tabId);
  stopping.delete(tabId);
  const stop = new AbortController();
  aborts.set(tabId, stop);
  const show = (state: PanelState | null) => setPanel(tabId, state);
  // In continuous mode every panel state carries the stop button.
  const panel: PanelFn =
    mode === 'auto' || mode === 'assist' ? (s) => show(s && { ...s, canStop: true }) : show;
  const started = Date.now();
  let log: Log = () => {};
  await badge(tabId, null);
  try {
    const settings = await getSettings();
    log = logger(settings.debug);
    await inject(tabId);
    const page = await pageInfo(tabId);
    await panel(busyState(t('st_reading')));
    const { solver, bill } = tracked(await makeSolver(settings), stop.signal);
    log('开始', {
      mode,
      url: page.url,
      付费模式: settings.mode === 'paid',
      可截图识别: solver.canRead,
    });
    const ctx: RunCtx = { tab, tabId, settings, solver, bill, panel, log };

    if (mode === 'auto' || mode === 'assist') {
      const { run, status } = await (mode === 'auto' ? autoLoop : assistLoop)(ctx, page);
      await show(run ? state(run, status, 'done') : { ...busyState(status), tone: 'done' });
      log('完成', { 用时ms: Date.now() - started, 结果: status, 扣点: bill.charged });
      return;
    }

    // Assist mode is the no-fill choice now, so solving a page always fills.
    const run = await answerOnce(ctx, page, mode, true);
    if (run === 'cancelled') {
      log('已取消框选');
      await panel(null);
      return;
    }
    if (run === 'empty') throw new UserError(noQuestions(solver));
    await panel(state(run, summary(run), 'done'));
    log('完成', { 用时ms: Date.now() - started, 结果: summary(run), 扣点: bill.charged });
  } catch (err) {
    if (err instanceof StoppedError) {
      // Stopped while a model call was running: the call was aborted, not failed.
      log('已停止（中断了进行中的请求）');
      await callFrames(tabId, 'all', 'clearHighlights', []).catch(() => {});
      const status = mode === 'assist' ? t('assist_stopped') : t('auto_stopped');
      await show({ ...busyState(status), tone: 'done' });
      return;
    }
    const message =
      err instanceof UserError ? err.message : t('err_generic', { msg: (err as Error).message });
    if (!(err instanceof UserError)) console.error('[QuizPilot]', err);
    log('出错', { message, stack: err instanceof UserError ? undefined : (err as Error).stack });
    if (!(await show(errorState(message)))) await badge(tabId, message);
  } finally {
    busy.delete(tabId);
    stopping.delete(tabId);
    aborts.delete(tabId);
  }
}

const noQuestions = (solver: Solver) =>
  solver.canRead ? t('err_noQuestions') : t('err_noQuestionsNoVision');

async function pageInfo(tabId: number): Promise<Page> {
  const [info] = await callFrames<Page>(tabId, [0], 'page', []);
  return info?.result ?? { url: 'about:blank', title: '' };
}

/** Read, solve and (optionally) fill the questions currently on the page. */
async function answerOnce(
  ctx: RunCtx,
  page: Page,
  mode: Exclude<RunMode, 'auto'>,
  autoFill: boolean,
  /** Continuous modes: questions handled in an earlier round (by domKey), or page parts that
   * didn't change when the page moved on. */
  skip?: (domKey: string) => boolean,
): Promise<Run | 'cancelled' | 'empty'> {
  const { tab, tabId, settings, solver, bill, panel, log } = ctx;
  const read =
    mode === 'region'
      ? { entries: await readRegion(tab, page, solver, panel, log), note: '' }
      : await readPage(tab, page, solver, panel, mode === 'learn', log, skip);
  const entries = read.entries;
  if (!entries) return 'cancelled';
  log('最终题目', entries.map(describeEntry));
  if (entries.length === 0) return 'empty';

  // Options still unread after any screenshot: the model would only be guessing between blanks.
  const unreadable = entries.filter((e) =>
    e.question.options?.some((o) => o.text === MISSING_OPTION_TEXT),
  );
  const notes = Object.fromEntries(unreadable.map((e) => [e.id, t('note_unreadableOptions')]));
  const solvable = entries.filter((e) => !unreadable.includes(e));
  if (unreadable.length)
    log(
      '选项未读出，不作答',
      unreadable.map((e) => e.id),
    );

  await panel(busyState(t('st_solving', { n: solvable.length })));
  const { answers, errors } = await solveAll(solvable, settings, solver, page.url);
  log('答案', {
    answers: answers.map((a) => ({
      id: a.id,
      model: a.model,
      confidence: a.confidence,
      ...(a.reviewed ? { 已复核: true } : {}),
      answer: a.choice ?? a.choices ?? a.bool ?? a.text,
    })),
    errors,
  });

  const run: Run = {
    // Screenshots were only needed for solving; don't keep megabytes of base64 per tab.
    entries: entries.map((e) => ({ ...e, question: { ...e.question, images: undefined } })),
    answers: Object.fromEntries(answers.map((a) => [a.id, a])),
    items: [],
    filled: false,
    note: read.note,
    ...(bill.charged !== undefined
      ? {
          footer: t('footer_credits', {
            used: bill.charged.toLocaleString('en-US'),
            balance: (bill.balance ?? 0).toLocaleString('en-US'),
          }),
        }
      : {}),
  };
  run.items = buildItems(entries, run.answers, errors, notes);
  await saveRun(tabId, run);

  if (autoFill && canFill(run)) {
    await panel(state(run, t('st_filling'), 'busy'));
    await fill(tabId, run, settings.humanize, log);
    await saveRun(tabId, run);
  }
  return run;
}

const canFill = (run: Run) => run.entries.some((e) => e.fillable && e.id in run.answers);

// ---------------------------------------------------------------- continuous mode

/** Safety net for pages that never run out of questions. */
const MAX_AUTO_ROUNDS = 200;
/** How long continuous mode waits for the user to complete a verification challenge. */
const CAPTCHA_WAIT_MS = 10 * 60_000;

/** Tabs whose continuous run the user asked to stop. */
const stopping = new Set<number>();
/** Per running tab: aborts its model calls in flight when the user stops. */
const aborts = new Map<number, AbortController>();

/** True while a run (single or continuous) is active in the tab. */
export const isRunning = (tabId: number) => busy.has(tabId);

export function stopRun(tabId: number) {
  if (!busy.has(tabId)) return;
  stopping.add(tabId);
  aborts.get(tabId)?.abort();
}

const jitter = (min: number, max: number) => min + Math.random() * (max - min);

/** Waits `ms`, waking early when the user stops. False if stopped. */
async function pause(tabId: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (stopping.has(tabId)) return false;
    await new Promise((r) => setTimeout(r, Math.min(250, end - Date.now())));
  }
  return !stopping.has(tabId);
}

/**
 * About as long as a person takes to read the question and pick an answer: a few seconds,
 * longer for long questions, never the same twice. Solving time counts towards it.
 */
function readingTime(entries: Entry[]): number {
  const chars = entries.reduce(
    (n, e) =>
      n +
      e.question.stem.length +
      (e.question.options ?? []).reduce((m, o) => m + o.text.length, 0),
    0,
  );
  return Math.min(15_000, Math.max(3_000, 2_000 + chars * 45)) * jitter(0.8, 1.3);
}

/** Identifies the questions on screen, to notice when the page moves to the next one. */
/**
 * Identity of a question across re-reads: its text without spaces, punctuation and symbols, so
 * feedback marks a site adds after an answer ("100 度 ✓") don't make it a new question.
 */
const normalize = (t: string) => t.replace(/[\s\p{P}\p{S}]/gu, '');
const questionKey = (q: Question) =>
  `${normalize(q.stem)}|${(q.options ?? []).map((o) => normalize(o.text)).join('/')}`;
const signature = (questions: Question[]) => questions.map(questionKey).join('\n');

/** The top frame's current questions, or null while the page is loading. */
async function currentQuestions(tabId: number): Promise<Question[] | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new UserError(t('err_tabClosed'));
  if (tab.status !== 'complete') return null;
  const rules = await getRules();
  const read = async () =>
    (await callFrames<FrameExtract>(tabId, [0], 'extract', [rules]).catch(() => []))[0]?.result;
  let top = await read();
  if (!top) {
    // A full page load dropped our script.
    await inject(tabId).catch(() => {});
    top = await read();
  }
  return top ? top.questions.map((q) => q.question) : null;
}

/** One text extends the other ("…是什么？" → "…是什么？回答正确。"), compared normalized. */
const extendsText = (a: string, b: string) => {
  const [x, y] = [normalize(a), normalize(b)];
  return x.startsWith(y) || y.startsWith(x);
};

/**
 * Still the same question, possibly with feedback the site added after it was answered
 * (runoob appends "回答正确。"). Consecutive questions with identical options (正确 / 错误)
 * still differ by stem.
 */
function sameQuestion(a: Question, b: Question): boolean {
  const oa = a.options ?? [];
  const ob = b.options ?? [];
  return (
    oa.length === ob.length &&
    oa.every((o, i) => extendsText(o.text, ob[i]!.text)) &&
    extendsText(a.stem, b.stem)
  );
}

const sameQuestions = (a: Question[], b: Question[]) =>
  a.length === b.length && a.every((q, i) => sameQuestion(q, b[i]!));

/**
 * Press the "next question" control, looking first in the frames this round's questions came
 * from (a quiz inside an iframe has its own next button; the page around it may have unrelated
 * pagination), then the top frame. Reports a submit-only page without pressing anything.
 */
async function pressNext(tabId: number, run: Run): Promise<NextFound> {
  const own = [...new Set(run.entries.map((e) => e.frameId))].filter((f) => f !== 0);
  let submit: NextFound = null;
  for (const frameId of [...own, 0]) {
    const [peek] = await callFrames<NextFound>(tabId, [frameId], 'next', [false]).catch(() => []);
    const found = peek?.result ?? null;
    if (found?.kind === 'next') {
      await callFrames(tabId, [frameId], 'next', [true]);
      return found;
    }
    submit ??= found;
  }
  return submit;
}

/** Waits for different questions to appear and settle (seen twice in a row). */
async function waitForChange(
  tabId: number,
  before: Question[] | null,
  ms: number,
  /** Re-reading the page is not free; assist mode waits minutes and checks less often. */
  every = 400,
): Promise<'changed' | 'same' | 'stopped'> {
  const end = Date.now() + ms;
  let candidate: string | null = null;
  while (Date.now() < end) {
    if (!(await pause(tabId, every))) return 'stopped';
    const questions = await currentQuestions(tabId);
    if (questions === null || (before && sameQuestions(questions, before))) {
      candidate = null;
      continue;
    }
    const now = signature(questions);
    if (now === candidate) return 'changed';
    candidate = now;
  }
  return 'same';
}

/**
 * Answer, move on, repeat: until no questions are left, only a submit button remains, the page
 * stops changing, or the user presses stop. Never submits.
 */
async function autoLoop(ctx: RunCtx, first: Page): Promise<{ run: Run | null; status: string }> {
  const { tabId, panel, log } = ctx;
  let page = first;
  let last: Run | null = null;
  let rounds = 0;
  let answered = 0;
  // Questions answered in earlier rounds. One that is still there after the page moved on is
  // part of the page (a nav bar, a sidebar), not a question: skip it rather than click it again.
  const seen = new Set<string>();
  const finish = (why: string) => ({
    run: last,
    status: rounds ? t('auto_summary', { why, rounds, answered }) : why,
  });
  const stopped = () => finish(t('auto_stopped'));

  /**
   * A verification challenge is on screen: pause until the user completes it. We never solve
   * or bypass it: it is the site asking whether a person is there.
   */
  const captchaGate = async (): Promise<'none' | 'cleared' | 'stopped' | 'timeout'> => {
    const found = async () =>
      (await callFrames<string | null>(tabId, [0], 'captcha', []).catch(() => []))[0]?.result ??
      null;
    const first = await found();
    if (!first) return 'none';
    log('连续答题：检测到验证', first);
    const status = t('auto_captcha');
    await panel(last ? state(last, status, 'busy') : busyState(status));
    const end = Date.now() + CAPTCHA_WAIT_MS;
    while (Date.now() < end) {
      if (!(await pause(tabId, 1_000))) return 'stopped';
      if (!(await found())) {
        log('连续答题：验证已完成');
        return 'cleared';
      }
    }
    return 'timeout';
  };
  const captchaTimeout = () => finish(t('auto_captchaTimeout'));

  while (rounds < MAX_AUTO_ROUNDS) {
    if (stopping.has(tabId)) return stopped();
    await inject(tabId);
    const gate = await captchaGate();
    if (gate === 'stopped') return stopped();
    if (gate === 'timeout') return captchaTimeout();
    const roundStart = Date.now();
    const before = await currentQuestions(tabId);
    const run = await answerOnce(ctx, page, 'page', false, (k) => seen.has(k));
    if (run === 'cancelled') return stopped();
    if (run === 'empty') {
      if (!rounds) throw new UserError(noQuestions(ctx.solver));
      return finish(t('auto_noMore'));
    }
    rounds++;
    last = run;
    for (const e of run.entries) seen.add(e.domKey ?? questionKey(e.question));
    await panel(state(run, t('auto_answering', { n: rounds }), 'busy'));
    // Human pacing (Settings.humanize): reading time before answering, typed answers, a beat
    // before moving on. Off, it answers as soon as the answer is in.
    const humanize = ctx.settings.humanize;
    const think = humanize ? readingTime(run.entries) - (Date.now() - roundStart) : 0;
    log('连续答题：作答前停顿', { round: rounds, ms: Math.round(Math.max(0, think)) });
    if (!(await pause(tabId, think))) return stopped();
    if (!canFill(run)) return finish(t('auto_notFillable'));
    await fill(tabId, run, humanize, log);
    await saveRun(tabId, run);
    answered += run.items.filter((i) => i.answer).length;
    await panel(state(run, t('auto_answered', { n: rounds }), 'busy'));
    // Even without pacing, give the page a moment to react to the answer.
    if (!(await pause(tabId, humanize ? jitter(800, 2_000) : 400))) return stopped();

    // Many quizzes move on by themselves once an answer is picked.
    let moved = await waitForChange(tabId, before, 2_500);
    if (moved === 'same') {
      // The site may have asked for verification instead of moving on.
      const gate = await captchaGate();
      if (gate === 'stopped') return stopped();
      if (gate === 'timeout') return captchaTimeout();
      if (gate === 'cleared') {
        moved = await waitForChange(tabId, before, 3_000);
        if (moved === 'same') {
          // Still the same question: the answer may not have counted. Answer it again.
          for (const e of run.entries) seen.delete(e.domKey ?? questionKey(e.question));
          continue;
        }
      }
    }
    if (moved === 'same') {
      const next = await pressNext(tabId, run);
      log('连续答题：下一题按钮', next ?? '没有找到');
      if (!next) return finish(t('auto_noNext'));
      if (next.kind === 'submit') return finish(t('auto_lastQuestion', { label: next.label }));
      moved = await waitForChange(tabId, before, 8_000);
      if (moved === 'same') return finish(t('auto_nextNoChange'));
    }
    if (moved === 'stopped') return stopped();
    log('连续答题：已进入下一题', { round: rounds });
    await inject(tabId);
    page = await pageInfo(tabId);
  }
  return finish(t('auto_maxRounds', { n: MAX_AUTO_ROUNDS }));
}

export async function fillLastRun(tabId: number) {
  if (busy.has(tabId)) return;
  busy.add(tabId);
  try {
    const run = await loadRun(tabId);
    if (!run) return;
    const settings = await getSettings();
    await setPanel(tabId, state(run, t('st_filling'), 'busy'));
    await fill(tabId, run, settings.humanize, logger(settings.debug));
    await saveRun(tabId, run);
    await setPanel(tabId, state(run, summary(run), 'done'));
  } finally {
    busy.delete(tabId);
  }
}

export async function undoLastRun(tabId: number) {
  const run = await loadRun(tabId);
  await callFrames(tabId, 'all', 'undo', []);
  if (!run) return;
  run.filled = false;
  await saveRun(tabId, run);
  await setPanel(tabId, state(run, t('st_undone'), 'done'));
}

export async function forgetRun(tabId: number) {
  stopRun(tabId);
  await chrome.storage.session.remove(runKey(tabId));
}

/** How long assist mode waits for the user to answer before giving up. */
const ASSIST_WAIT_MS = 15 * 60_000;

/**
 * Assist mode: read and solve like continuous mode, but only outline the suggested answers.
 * The user clicks; when the page moves on, the next question is read and marked. Nothing on
 * the page is clicked or typed by the extension.
 */
async function assistLoop(ctx: RunCtx, first: Page): Promise<{ run: Run | null; status: string }> {
  const { tabId, panel, log } = ctx;
  let page = first;
  let last: Run | null = null;
  let rounds = 0;
  const seen = new Set<string>();
  const finish = async (why: string) => {
    await callFrames(tabId, 'all', 'clearHighlights', []).catch(() => {});
    return { run: last, status: rounds ? t('assist_summary', { why, rounds }) : why };
  };

  while (rounds < MAX_AUTO_ROUNDS) {
    if (stopping.has(tabId)) return finish(t('assist_stopped'));
    await inject(tabId);
    const before = await currentQuestions(tabId);
    const run = await answerOnce(ctx, page, 'page', false, (k) => seen.has(k));
    if (run === 'cancelled') return finish(t('assist_stopped'));
    if (run === 'empty' && !rounds) throw new UserError(noQuestions(ctx.solver));
    // Empty later on: everything on screen was handled already (a page showing all its
    // questions, changed by the user's answer). Keep the outlines and wait for new ones.
    if (run !== 'empty') {
      rounds++;
      run.assist = true;
      last = run;
      for (const e of run.entries) seen.add(e.domKey ?? questionKey(e.question));
      await saveRun(tabId, run);
      const marked = await highlight(tabId, run);
      log('辅助答题：已标出答案', { round: rounds, marked });
      await panel(state(run, marked ? t('assist_marked') : t('assist_shown'), 'busy'));
    }

    const moved = await waitForChange(tabId, before, ASSIST_WAIT_MS, 1_000);
    if (moved === 'stopped') return finish(t('assist_stopped'));
    if (moved === 'same') return finish(t('assist_idle'));
    log('辅助答题：页面有变化', { round: rounds });
    await inject(tabId);
    page = await pageInfo(tabId);
  }
  return finish(t('assist_maxRounds', { n: MAX_AUTO_ROUNDS }));
}

// ---------------------------------------------------------------- reading

/**
 * No usable questions from the generic reader: nothing found, or no question's text could be
 * read. A question with a figure was read fine; it only needs a screenshot to answer.
 */
const poor = (f: FrameExtract) =>
  f.questions.length === 0 || f.questions.every((q) => q.status === 'incomplete');

async function readPage(
  tab: chrome.tabs.Tab,
  page: Page,
  solver: Solver,
  panel: (s: PanelState | null) => Promise<unknown>,
  forceLearn: boolean,
  log: Log,
  /** Continuous modes: questions handled in an earlier round, by domKey. Dropped before any
   * screenshot, so they cost nothing. */
  skip?: (domKey: string) => boolean,
): Promise<{ entries: Entry[]; note: string }> {
  const tabId = tab.id!;
  const rules = await getRules();
  let frames = await callFrames<FrameExtract>(tabId, 'all', 'extract', [rules]);
  log('读题', frames.map(describeFrame));
  let note = frames.find((f) => f.frameId === 0)?.result?.via === 'rule' ? t('note_rule') : '';

  // Learn this site's layout when asked, or when the generic reader got nothing usable.
  const top = frames.find((f) => f.frameId === 0)?.result;
  if (forceLearn && !solver.canRead) throw new UserError(t('err_learnNeedsVision'));
  // Usable questions in any frame (a quiz embedded in an iframe) mean there is nothing to learn.
  const framesRead = frames.some((f) => f.frameId !== 0 && f.result && !poor(f.result));
  const shouldLearn =
    !!top && solver.canRead && (forceLearn || (top.via === 'generic' && poor(top) && !framesRead));
  log('是否学习结构', {
    学习: shouldLearn,
    原因: forceLearn
      ? '手动要求'
      : !top
        ? '没有顶层页面结果'
        : top.via === 'rule'
          ? '已有可用的站点规则'
          : framesRead
            ? '已在框架（iframe）里读到题目'
            : poor(top)
              ? '通用读题结果不可用'
              : '通用读题结果可用',
    有站点规则: !!top && top.ruleKey in rules,
    站点规则失效: top?.ruleFailed,
  });
  if (top && shouldLearn) {
    const learned = await learnLayout(tab, page, solver, panel, top, log);
    if (learned) {
      await saveRule(learned.ruleKey, learned.rule);
      const [again] = await callFrames<FrameExtract>(tabId, [0], 'extract', [
        { ...rules, [learned.ruleKey]: learned.rule },
      ]);
      if (again) log('按新规则重新读题', describeFrame(again));
      if (again?.result)
        frames = frames.map((f) => (f.frameId === 0 ? { ...f, result: again.result } : f));
      note = t('note_learned');
    } else if (forceLearn) {
      note = t('note_learnFailed');
    }
  }
  let entries: Entry[] = frames.flatMap(({ frameId, result }) =>
    (result?.questions ?? []).map((q) => ({
      id: entryId(frameId, q.question.id),
      frameId,
      localId: q.question.id,
      question: { ...q.question, id: entryId(frameId, q.question.id) },
      status: q.status,
      fillable: true,
      visionChecked: false,
      tags: [] as string[],
      domKey: questionKey(q.question),
    })),
  );
  if (skip) {
    const skipped = entries.filter((e) => skip(e.domKey!));
    if (skipped.length) {
      log('跳过已处理的题目', skipped.map(describeEntry));
      entries = entries.filter((e) => !skipped.includes(e));
    }
  }

  // Screenshots only work for the top frame's coordinates.
  const needShots = entries
    .filter((e) => e.frameId === 0 && e.status !== 'ok')
    .slice(0, MAX_VISION_READS);
  if (needShots.length && solver.canRead) {
    // Capturing needs the tab and is rate limited, so it runs one question at a time; the
    // transcription calls it feeds run concurrently.
    const pending: Promise<Entry>[] = [];
    for (const [i, e] of needShots.entries()) {
      await panel(busyState(t('st_shooting', { i: i + 1, n: needShots.length })));
      const [hit] = await callFrames<Reveal | null>(tabId, [0], 'reveal', [e.localId]);
      if (!hit?.result) continue;
      await panel(null); // keep our panel out of the shot
      const crop = await cropToJpeg(
        await captureVisible(tab.windowId),
        hit.result.rect,
        hit.result.viewport,
      );
      log('截图', { id: e.id, status: e.status, rect: hit.result.rect });
      pending.push(
        e.status === 'figure'
          ? Promise.resolve(withFigure(e, crop.dataUrl))
          : solver
              .read({ pageUrl: page.url, image: crop.dataUrl, hint: e.question.stem.slice(0, 500) })
              .then((out) => {
                log('截图识别结果', { id: e.id, questions: out.questions.map(describeQuestion) });
                return mergeVision(e, out.questions[0], crop.dataUrl);
              }),
      );
    }
    await panel(busyState(t('st_readingShots')));
    const read = new Map((await Promise.all(pending)).map((e) => [e.id, e]));
    entries = entries.map((e) => read.get(e.id) ?? e);
  }
  // Whatever still needed a screenshot (no vision model, iframe, over the limit) is answered
  // from DOM text alone; say so in the panel.
  entries = entries.map(markUnverified);

  // Nothing readable in the DOM at all (canvas, PDF viewer, images): read the whole viewport.
  if (entries.length === 0 && solver.canRead) {
    const shot = frames.find((f) => f.frameId === 0)?.result;
    if (!shot) return { entries, note };
    await panel(null);
    const crop = await cropToJpeg(await captureVisible(tab.windowId), null, shot.viewport);
    await panel(busyState(t('st_shotWholePage')));
    const out = await solver.read({ pageUrl: page.url, image: crop.dataUrl, hint: shot.title });
    log('整页截图识别结果', out.questions.map(describeQuestion));
    return { entries: fromScreenshot(out, crop.dataUrl), note };
  }
  return { entries, note };
}

/**
 * Set-of-marks learning: number the on-screen elements, have the vision model say which numbers
 * form each question, and turn that into a site rule. Null when no rule fits.
 */
async function learnLayout(
  tab: chrome.tabs.Tab,
  page: Page,
  solver: Solver,
  panel: (s: PanelState | null) => Promise<unknown>,
  top: FrameExtract,
  log: Log,
): Promise<Learned | null> {
  const tabId = tab.id!;
  await panel(busyState(t('st_learning')));
  await panel(null);
  const [drawn] = await callFrames<Mark[]>(tabId, [0], 'marks', []);
  const marks = drawn?.result ?? [];
  log('学习：标记元素', {
    count: marks.length,
    marks: marks.map((m) => `${m.id} <${m.tag}> ${m.text.slice(0, 40)}`),
  });
  if (marks.length === 0) return null;
  let image: string;
  try {
    image = (await cropToJpeg(await captureVisible(tab.windowId), null, top.viewport)).dataUrl;
  } finally {
    await callFrames(tabId, [0], 'clearMarks', []);
  }
  await panel(busyState(t('st_learning')));
  const labelled = await solver.mark({ pageUrl: page.url, image, marks });
  log('学习：模型标注', labelled.questions);
  if (labelled.questions.length === 0) return null;
  const [outcome] = await callFrames<LearnOutcome>(tabId, [0], 'learn', [labelled.questions]);
  const result = outcome?.result;
  if (result && 'learned' in result) {
    log('学习：得到的规则', result.learned);
    return result.learned;
  }
  log('学习：没有找到适用的规则', result ?? '页面没有返回结果');
  return null;
}

async function readRegion(
  tab: chrome.tabs.Tab,
  page: Page,
  solver: Solver,
  panel: (s: PanelState | null) => Promise<unknown>,
  log: Log,
) {
  if (!solver.canRead) throw new UserError(t('err_regionNeedsVision'));
  await panel(null);
  const [sel] = await callFrames<Rect | null>(tab.id!, [0], 'selectRegion', []);
  if (!sel?.result) return null;
  const [vp] = await callFrames<Viewport>(tab.id!, [0], 'viewport', []);
  const crop = await cropToJpeg(await captureVisible(tab.windowId), sel.result, vp!.result!);
  await panel(busyState(t('st_readingRegion')));
  const out = await solver.read({ pageUrl: page.url, image: crop.dataUrl, hint: page.title });
  log('框选识别结果', { rect: sel.result, questions: out.questions.map(describeQuestion) });
  return fromScreenshot(out, crop.dataUrl);
}

function fromScreenshot(out: { questions: Question[] }, crop: string): Entry[] {
  return out.questions.map((q, i) => {
    const id = `shot-${i + 1}`;
    const question: Question = {
      ...q,
      id,
      ...(q.needsVision ? { images: [{ id: 'shot', dataUrl: crop }] } : {}),
    };
    return {
      id,
      frameId: 0,
      localId: id,
      question,
      status: 'incomplete',
      fillable: false,
      visionChecked: true,
      tags: [
        t('tag_screenshot'),
        t('tag_displayOnly'),
        ...(q.needsVision ? [t('tag_vision')] : []),
      ],
    };
  });
}

// ---------------------------------------------------------------- solving & filling

async function solveAll(entries: Entry[], settings: Settings, solver: Solver, pageUrl: string) {
  const answers: Answer[] = [];
  const errors: AnswerError[] = [];
  for (let i = 0; i < entries.length; i += MAX_QUESTIONS_PER_SOLVE) {
    const batch = entries.slice(i, i + MAX_QUESTIONS_PER_SOLVE);
    const out = await solver.solve({
      pageUrl,
      questions: batch.map((e) => e.question),
      prefs: { provider: 'auto', allowEscalation: settings.allowEscalation },
    });
    answers.push(...out.answers);
    errors.push(...out.errors);
  }
  return { answers, errors };
}

/** Answers grouped by frame, with ids local to that frame. */
function answersByFrame(run: Run): Map<number, Answer[]> {
  const byFrame = new Map<number, Answer[]>();
  for (const e of run.entries) {
    const a = run.answers[e.id];
    if (!a || !e.fillable) continue;
    byFrame.set(e.frameId, [...(byFrame.get(e.frameId) ?? []), { ...a, id: e.localId }]);
  }
  return byFrame;
}

/** Assist mode: outline the suggested answers in every frame. Returns how many were marked. */
async function highlight(tabId: number, run: Run): Promise<number> {
  const counts = await Promise.all(
    [...answersByFrame(run)].map(async ([frameId, answers]) => {
      const [res] = await callFrames<number>(tabId, [frameId], 'highlight', [answers]);
      return res?.result ?? 0;
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

async function fill(tabId: number, run: Run, humanize: boolean, log: Log) {
  const byFrame = answersByFrame(run);
  // Frames are independent; fill them concurrently.
  await Promise.all(
    [...byFrame].map(async ([frameId, answers]) => {
      const [res] = await callFrames<{ id: string; ok: boolean; reason?: string }[]>(
        tabId,
        [frameId],
        'fill',
        [{ answers, humanize }],
      );
      log('填写', { frameId, outcomes: res?.result });
      for (const o of res?.result ?? []) {
        if (o.ok) continue;
        const item = run.items.find((i) => i.frameId === frameId && i.localId === o.id);
        if (item) item.error = t('item_fillFailed', { reason: o.reason ?? '' });
      }
    }),
  );
  run.filled = true;
}

function buildItems(
  entries: Entry[],
  answers: Record<string, Answer>,
  errors: AnswerError[],
  /** Why a question was not sent to the model. */
  notes: Record<string, string> = {},
): PanelItem[] {
  const errorById = new Map(errors.map((e) => [e.id, e]));
  return entries.map((e, i) => {
    const a = answers[e.id];
    const err = errorById.get(e.id);
    return {
      id: e.id,
      index: i + 1,
      kind: e.question.kind,
      stem: e.question.stem.slice(0, 200),
      ...(a ? { answer: formatAnswer(e.question, a) } : {}),
      ...(a?.confidence !== undefined ? { confidence: a.confidence } : {}),
      ...(err
        ? { error: answerErrorMessage(err) }
        : !a
          ? { error: notes[e.id] ?? t('item_noAnswer') }
          : {}),
      tags: a?.reviewed ? [...e.tags, t('tag_reviewed')] : e.tags,
      frameId: e.frameId,
      localId: e.localId,
    };
  });
}

function state(run: Run, status: string, tone: PanelState['tone']): PanelState {
  const fillable = canFill(run);
  return {
    status,
    tone,
    items: run.items,
    canFill: fillable && !run.filled && !run.assist,
    canUndo: run.filled,
    ...(run.footer ? { footer: run.footer } : {}),
  };
}

function summary(run: Run): string {
  return `${baseSummary(run)}${run.note ? t('summary_note', { note: run.note }) : ''}`;
}

function baseSummary(run: Run): string {
  const answered = run.items.filter((i) => i.answer).length;
  const text = t('summary', { answered, total: run.items.length });
  return run.filled ? text + t('summary_filled') : text;
}

// ---------------------------------------------------------------- debug summaries

function describeQuestion(q: Question) {
  return {
    id: q.id,
    kind: q.kind,
    stem: q.stem.slice(0, 80),
    ...(q.options ? { options: q.options.map((o) => `${o.key}. ${o.text.slice(0, 30)}`) } : {}),
    ...(q.needsVision ? { needsVision: true } : {}),
  };
}

function describeFrame({ frameId, result }: { frameId: number; result: FrameExtract | undefined }) {
  if (!result) return { frameId, result: '无结果（脚本未注入或无权限）' };
  return {
    frameId,
    via: result.via,
    ruleKey: result.ruleKey,
    ruleFailed: result.ruleFailed,
    count: result.questions.length,
    questions: result.questions.map((q) => ({
      ...describeQuestion(q.question),
      status: q.status,
      ...(q.reason ? { reason: q.reason } : {}),
    })),
  };
}

const describeEntry = (e: Entry) => ({
  ...describeQuestion(e.question),
  frameId: e.frameId,
  status: e.status,
  fillable: e.fillable,
  tags: e.tags,
});

// ---------------------------------------------------------------- scripting

async function inject(tabId: number) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [contentScript],
    });
  } catch {
    // Some frame refused (no host permission); the top frame is what matters.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [contentScript] });
    } catch {
      throw new UserError(t('err_cantRun'));
    }
  }
}

async function callFrames<T>(
  tabId: number,
  frames: number[] | 'all',
  method: Method,
  args: unknown[],
): Promise<{ frameId: number; result: T | undefined }[]> {
  const results = await chrome.scripting.executeScript({
    target: frames === 'all' ? { tabId, allFrames: true } : { tabId, frameIds: frames },
    func: (m: string, a: unknown[]) => {
      const api = (
        globalThis as unknown as { __quizpilot?: Record<string, (...x: unknown[]) => unknown> }
      ).__quizpilot;
      return api?.[m]?.(...a) ?? null;
    },
    args: [method, args],
  });
  return results.map((r) => ({
    frameId: r.frameId,
    result: (r.result ?? undefined) as T | undefined,
  }));
}
