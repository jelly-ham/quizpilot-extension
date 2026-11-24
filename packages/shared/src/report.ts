import { z } from 'zod';
import { QuestionKind } from './question';
import { SolveTier } from './solve';

/**
 * Answer records for improving the extension (paid mode only; the Worker's src/reports). Every
 * paid run reports how each question was read, answered and filled, without its text. Only with
 * the "help improve" setting on does a question carry its text, options and answer (`content`).
 */

/** How the question was read: page text, a screenshot of it, a figure attached to its text, the
 * user's selected region, or a screenshot of the whole page. */
export const ReportSource = z.enum(['dom', 'screenshot', 'figure', 'region', 'fullshot']);
export type ReportSource = z.infer<typeof ReportSource>;

/** How the page was read as a whole. */
export const ReportVia = z.enum(['generic', 'rule', 'learned', 'region', 'fullshot']);
export type ReportVia = z.infer<typeof ReportVia>;

export const ReportMode = z.enum(['page', 'region', 'learn', 'auto', 'assist']);
export type ReportMode = z.infer<typeof ReportMode>;

/** none: nothing was written (no answer, display only, or assist mode's outlines). */
export const FillResult = z.enum(['ok', 'failed', 'none']);
export type FillResult = z.infer<typeof FillResult>;

/**
 * What the page showed for a question when the user moved on, compared with what the extension
 * filled (assist mode: with the outlined suggestion). kept: the same answer; changed: another
 * answer; cleared: no answer (assist mode: the user didn't pick anything).
 */
export const Verdict = z.enum(['kept', 'changed', 'cleared']);
export type Verdict = z.infer<typeof Verdict>;

const Text = (max: number) => z.string().max(max);

/** The question as sent to the model, and the model's answer. Opt-in only. */
export const ReportContent = z.object({
  stem: Text(4000),
  options: z
    .array(z.object({ key: Text(8), text: Text(500) }))
    .max(26)
    .optional(),
  answer: z
    .object({
      choice: Text(8).optional(),
      choices: z.array(Text(8)).max(26).optional(),
      bool: z.boolean().optional(),
      text: z.union([Text(4000), z.array(Text(1000)).max(50)]).optional(),
    })
    .optional(),
});
export type ReportContent = z.infer<typeof ReportContent>;

export const ReportQuestion = z.object({
  /** The question's id within the run (unique across frames). */
  qid: Text(64).min(1),
  kind: QuestionKind,
  source: ReportSource,
  /** What the page text gave: ok, incomplete (needed a screenshot), figure. */
  status: z.enum(['ok', 'incomplete', 'figure']),
  model: Text(100).optional(),
  confidence: z.number().min(0).max(1).optional(),
  reviewed: z.boolean().optional(),
  answered: z.boolean(),
  /** Why there is no answer: an AnswerError code, or unreadable_options. */
  error: Text(40).optional(),
  fill: FillResult,
  fillReason: Text(200).optional(),
  content: ReportContent.optional(),
});
export type ReportQuestion = z.infer<typeof ReportQuestion>;

export const MAX_REPORT_QUESTIONS = 200;

export const RunReport = z.object({
  /** Made by the extension, so verdicts can follow later. */
  runId: z.uuid(),
  /** The page's origin (the extension sends no path or query); only the host is kept. */
  pageUrl: z.url(),
  mode: ReportMode,
  tier: SolveTier,
  via: ReportVia,
  version: Text(40),
  questions: z.array(ReportQuestion).min(1).max(MAX_REPORT_QUESTIONS),
});
export type RunReport = z.infer<typeof RunReport>;

export const VerdictReport = z.object({
  verdicts: z
    .array(
      z.object({
        qid: Text(64).min(1),
        verdict: Verdict,
        /** Choice questions in an opt-in run: the option keys the user ended up with. */
        picked: z.array(Text(8)).max(26).optional(),
      }),
    )
    .min(1)
    .max(MAX_REPORT_QUESTIONS),
});
export type VerdictReport = z.infer<typeof VerdictReport>;
