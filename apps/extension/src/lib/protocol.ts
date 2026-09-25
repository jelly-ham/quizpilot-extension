import type { Answer, QuestionKind } from '@quizpilot/shared';
import type { Extracted } from '../content/extract/generic';
import type { SiteRule } from '../content/extract/rules';

/** Serializable result of extracting one frame. */
export interface FrameExtract {
  title: string;
  viewport: Viewport;
  questions: Pick<Extracted, 'question' | 'status' | 'reason'>[];
  /** Read with a learned site rule, or the generic reader. */
  via: 'rule' | 'generic';
  /** Site-rule key for this frame's page (host + number-free path). */
  ruleKey: string;
  /** A stored rule existed but no longer fits the page. */
  ruleFailed: boolean;
}

/** Placeholder for an option whose text couldn't be read; such questions are not guessed at. */
export const MISSING_OPTION_TEXT = '（无文字）';

/** Result of learning a site rule from set-of-marks labels. */
export interface Learned {
  ruleKey: string;
  rule: SiteRule;
  questions: number;
}

/** learn(): a rule, or why none fit plus the markup around the labelled question. */
export type LearnOutcome = { learned: Learned } | { failed: string; skeleton?: string };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

export interface Reveal {
  rect: Rect;
  viewport: Viewport;
}

export interface PanelItem {
  id: string;
  index: number;
  kind: QuestionKind;
  stem: string;
  answer?: string;
  confidence?: number;
  error?: string;
  /** e.g. "截图识别" / "看图作答" / "仅显示答案" */
  tags: string[];
  frameId: number;
  localId: string;
}

export interface PanelState {
  status: string;
  tone: 'busy' | 'done' | 'error';
  items: PanelItem[];
  canFill: boolean;
  canUndo: boolean;
  /** Continuous mode is running: show a stop button. */
  canStop?: boolean;
  footer?: string;
}

/** What content's next() found: a "next question" control, or only a submit button. */
export type NextFound = { kind: 'next' | 'submit'; label: string } | null;

export interface FillRequest {
  answers: Answer[];
  humanize: boolean;
}

/** Messages from extension pages / content UI to the background. */
export type RuntimeMessage =
  | { type: 'qp:run'; mode: RunMode; tabId: number }
  | { type: 'qp:fill' }
  | { type: 'qp:undo' }
  | { type: 'qp:close' }
  | { type: 'qp:stop' }
  | { type: 'qp:google-login' };

/**
 * page: read and solve; region: user-selected area; learn: relearn this site's layout first;
 * auto: answer, go to the next question, repeat until the end or the user stops;
 * assist: like auto, but only outline the suggested answers: the user clicks, the page never is.
 */
export type RunMode = 'page' | 'region' | 'learn' | 'auto' | 'assist';
