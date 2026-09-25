import { z } from 'zod';
import { Answer } from './answer';
import { AnswerError } from './errors';
import { Question } from './question';

/** Max questions accepted in one solve call. */
export const MAX_QUESTIONS_PER_SOLVE = 100;

export const ProviderId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase slug');
export type ProviderId = z.infer<typeof ProviderId>;

export const SolvePrefs = z.object({
  provider: z.union([z.literal('auto'), ProviderId]).default('auto'),
  /** Re-check low-confidence choice answers with a text LLM. */
  allowEscalation: z.boolean().default(false),
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
