import { z } from 'zod';

export const ErrorCode = z.enum([
  /** No configured provider can answer this kind of question. */
  'unsupported',
  /** The question needs a figure read and no image-capable model is configured. */
  'needs_vision',
  'auth',
  'bad_request',
  'rate_limit',
  'overloaded',
  'timeout',
  'aborted',
  'upstream',
  /** Model replied, but not with a usable answer. */
  'invalid_response',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Per-question failure; other questions in the same call can still succeed. */
export const AnswerError = z.object({
  id: z.string(),
  code: ErrorCode,
  message: z.string(),
});
export type AnswerError = z.infer<typeof AnswerError>;

/** One-line summary of a zod error, e.g. "questions.0.stem: Too small; pageUrl: Invalid URL". */
export function formatIssues(error: z.ZodError, separator = '; '): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join(separator);
}
