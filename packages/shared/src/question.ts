import { z } from 'zod';
import { QuestionImage } from './image';

export const QuestionKind = z.enum(['single', 'multi', 'judge', 'fill', 'essay']);
export type QuestionKind = z.infer<typeof QuestionKind>;

/** Kinds answered by picking from `options`. */
export const CHOICE_KINDS: readonly QuestionKind[] = ['single', 'multi'];

/** Where the question text came from: page DOM, or a vision model reading a screenshot. */
export const QuestionSource = z.enum(['dom', 'vision']);
export type QuestionSource = z.infer<typeof QuestionSource>;

export const QuestionOption = z.object({
  key: z.string().min(1).max(8),
  text: z.string().max(2000),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const Question = z
  .object({
    id: z.string().min(1).max(64),
    kind: QuestionKind,
    stem: z.string().min(1).max(8000),
    options: z.array(QuestionOption).max(255).optional(),
    /** Surrounding page text that may help answer (instructions, passage, etc.). */
    context: z.string().max(20000).optional(),
    /** Number of blanks for `fill` questions. */
    blanks: z.number().int().min(1).max(50).optional(),
    source: QuestionSource.default('dom'),
    /** Figures the question depends on (cropped screenshots or page images). */
    images: z.array(QuestionImage).max(4).optional(),
    /** Answering requires looking at `images`; routes to a vision model instead of Jev. */
    needsVision: z.boolean().optional(),
  })
  .superRefine((q, ctx) => {
    if (CHOICE_KINDS.includes(q.kind) && (q.options?.length ?? 0) < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: `${q.kind} question needs at least 2 options`,
      });
    }
    if (q.options) {
      const keys = new Set(q.options.map((o) => o.key));
      if (keys.size !== q.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'option keys must be unique' });
      }
    }
  });
export type Question = z.infer<typeof Question>;
export type QuestionInput = z.input<typeof Question>;
