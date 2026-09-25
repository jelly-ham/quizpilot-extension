import {
  createProviders,
  isVisionCapable,
  routeMark,
  routeRead,
  routeSolve,
} from '@quizpilot/providers';
import type {
  Answer,
  AnswerError,
  MarkedQuestion,
  MarkRequest,
  Question,
  ReadRequest,
  SolveRequest,
} from '@quizpilot/shared';
import type { Settings } from '../lib/settings';
import { t } from '../lib/i18n';

export interface SolveResult {
  answers: Answer[];
  errors: AnswerError[];
  /** Paid mode only. */
  creditsCharged?: number;
  balance?: number;
}

export interface Solver {
  /** Can transcribe screenshots (has a vision model). */
  canRead: boolean;
  read(
    req: ReadRequest,
    signal?: AbortSignal,
  ): Promise<{ questions: Question[]; creditsCharged?: number; balance?: number }>;
  solve(req: SolveRequest, signal?: AbortSignal): Promise<SolveResult>;
  /** Label a set-of-marks screenshot (learning a site's layout). Needs canRead. */
  mark(
    req: MarkRequest,
    signal?: AbortSignal,
  ): Promise<{ questions: MarkedQuestion[]; creditsCharged?: number; balance?: number }>;
}

/** The user pressed stop while a model call was running. */
export class StoppedError extends Error {}

/** Problem the user has to fix (missing key, not logged in, ...), shown as-is in the panel. */
export class UserError extends Error {}

export function byokSolver(settings: Settings): Solver {
  const { providers: configs, routing } = settings.byok;
  if (configs.length === 0) throw new UserError(t('err_byokNoKey'));
  const providers = createProviders(configs);
  return {
    canRead: [...providers.values()].some(isVisionCapable),
    async read(req, signal) {
      const out = await routeRead(req, providers, routing, { signal });
      return { questions: out.questions };
    },
    async solve(req, signal) {
      const out = await routeSolve(req.questions, providers, routing, req.prefs, { signal });
      return { answers: out.answers, errors: out.errors };
    },
    async mark(req, signal) {
      const out = await routeMark(req, providers, routing, { signal });
      return { questions: out.questions };
    },
  };
}
