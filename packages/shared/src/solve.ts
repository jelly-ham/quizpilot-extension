import { z } from 'zod';
import { Answer } from './answer';
import { AnswerError } from './errors';
import { Question } from './question';

/** Max questions accepted in one solve call. */
export const MAX_QUESTIONS_PER_SOLVE = 100;

export const ProviderId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase slug');
export type ProviderId = z.infer<typeof ProviderId>;

/**
 * Paid mode only. `fast`: the cheap model mix (Jev for choices, a small LLM for text). `accurate`:
 * one frontier reasoning model for every question. Both are priced per answered question.
 */
export const SolveTier = z.enum(['fast', 'accurate']);
export type SolveTier = z.infer<typeof SolveTier>;

/**
 * Prices are in questions ("题"): what users buy and see. The ledger keeps credits, 10 to a
 * question, so balances from before per-question pricing carry over unchanged.
 */
export const CREDITS_PER_QUESTION = 10;
/** Questions charged per answered question, by tier. */
export const TIER_QUESTIONS: Record<SolveTier, number> = { fast: 1, accurate: 10 };
/** Screenshot reads and layout learning: one question each. */
export const READ_QUESTIONS = 1;

/** Credits for one answered question in `tier`, however long the question. */
export const questionCredits = (tier: SolveTier) => TIER_QUESTIONS[tier] * CREDITS_PER_QUESTION;

/**
 * A credit amount as questions in `tier`, for display: 1,996 credits → "199.6" fast or "19.9"
 * accurate questions. Truncated to one decimal, so a balance never shows more than it buys.
 */
/** Whole questions a balance can still answer in `tier`: 1,996 credits → "19" accurate. */
export const formatQuestionsLeft = (credits: number, tier: SolveTier = 'fast', locale?: string) =>
  Math.max(0, Math.floor(credits / questionCredits(tier))).toLocaleString(locale);

export const formatQuestions = (credits: number, tier: SolveTier = 'fast', locale?: string) =>
  (Math.trunc((credits * 10) / questionCredits(tier)) / 10).toLocaleString(locale, {
    maximumFractionDigits: 1,
  });

export const SolvePrefs = z.object({
  provider: z.union([z.literal('auto'), ProviderId]).default('auto'),
  /** Re-check low-confidence choice answers with a text LLM. */
  allowEscalation: z.boolean().default(false),
  tier: SolveTier.default('fast'),
});
export type SolvePrefs = z.infer<typeof SolvePrefs>;

export const SolveRequest = z
  .object({
    pageUrl: z.url(),
    questions: z.array(Question).min(1).max(MAX_QUESTIONS_PER_SOLVE),
    prefs: SolvePrefs.prefault({}),
  })
  .superRefine((req, ctx) => {
    const ids = new Set<string>();
    req.questions.forEach((q, i) => {
      if (ids.has(q.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'id'],
          message: 'duplicate question id',
        });
      }
      ids.add(q.id);
      if (q.needsVision && !q.images?.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'images'],
          message: 'needsVision question must include images',
        });
      }
    });
  });
export type SolveRequest = z.infer<typeof SolveRequest>;

export const SolveResponse = z.object({
  answers: z.array(Answer),
  errors: z.array(AnswerError),
  creditsCharged: z.number().int().nonnegative(),
  balance: z.number().int(),
});
export type SolveResponse = z.infer<typeof SolveResponse>;
