import { z } from 'zod';
import { ImageDataUrl } from './image';
import { QuestionKind } from './question';

/** One numbered element drawn on the screenshot (set-of-marks). */
export const Mark = z.object({
  id: z.number().int().min(1).max(999),
  tag: z.string().max(20),
  /** The element's text (or placeholder for inputs), truncated. */
  text: z.string().max(200),
});
export type Mark = z.infer<typeof Mark>;

/** Screenshot with numbered elements; the model says which numbers form each question. */
export const MarkRequest = z.object({
  pageUrl: z.url(),
  image: ImageDataUrl,
  marks: z.array(Mark).min(1).max(300),
});
export type MarkRequest = z.infer<typeof MarkRequest>;

export const MarkedQuestion = z.object({
  kind: QuestionKind,
  /** Mark holding the question text. */
  stem: z.number().int(),
  /** Choice questions: one mark per option, in display order. */
  options: z.array(z.number().int()).max(12).default([]),
  /** Fill/essay: marks of the text boxes. */
  inputs: z.array(z.number().int()).max(50).default([]),
});
export type MarkedQuestion = z.infer<typeof MarkedQuestion>;

export const MarkResponse = z.object({
  questions: z.array(MarkedQuestion),
  creditsCharged: z.number().int().nonnegative(),
  balance: z.number().int(),
});
export type MarkResponse = z.infer<typeof MarkResponse>;
