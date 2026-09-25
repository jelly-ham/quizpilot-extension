import { z } from 'zod';
import { ImageDataUrl } from './image';
import { Question } from './question';

export const ReadRequest = z.object({
  pageUrl: z.url(),
  image: ImageDataUrl,
  /** Optional user or DOM-derived hint, e.g. the page title or section heading. */
  hint: z.string().max(2000).optional(),
});
export type ReadRequest = z.infer<typeof ReadRequest>;

/**
 * Questions come back with `source: 'vision'` and without `images`; the caller attaches the
 * screenshot crop to any `needsVision` question before sending it to solve.
 */
export const ReadResponse = z.object({
  questions: z.array(Question),
  creditsCharged: z.number().int().nonnegative(),
  balance: z.number().int(),
});
export type ReadResponse = z.infer<typeof ReadResponse>;
