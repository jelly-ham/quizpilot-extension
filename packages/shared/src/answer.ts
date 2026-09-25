import { z } from 'zod';
import { QuestionKind } from './question';

export const Answer = z.object({
  id: z.string().min(1).max(64),
  kind: QuestionKind,
  /** `single`: the chosen option key. */
  choice: z.string().optional(),
  /** `multi`: the chosen option keys. */
  choices: z.array(z.string()).optional(),
  /** `judge`: true / false. */
  bool: z.boolean().optional(),
  /** `fill`: one string per blank; `essay`: a single string. */
  text: z.union([z.string(), z.array(z.string())]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** Re-answered by the reviewer model because the first answer's confidence was low. */
  reviewed: z.boolean().optional(),
  /** Model that produced the answer, e.g. `jev-latest`. */
  model: z.string(),
});
export type Answer = z.infer<typeof Answer>;
