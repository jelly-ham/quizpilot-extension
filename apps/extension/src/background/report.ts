import {
  MAX_REPORT_QUESTIONS,
  type Answer,
  type ReportContent,
  type ReportMode,
  type ReportSource,
  type ReportVia,
  type RunReport,
  type SolveTier,
  type Verdict,
} from '@quizpilot/shared';
import { ApiError, postRunReport, postVerdicts } from '../lib/api';
import { entryId, type Entry } from './merge';

/**
 * Paid mode's answer records (Worker: src/reports). After a run, report how each question was
 * read, answered and filled; when the user moves on, the content script reports whether they kept
 * the answers (content/fill/watch.ts). No question text unless Settings.shareSamples is on.
 * Reporting never gets in the way of a run: failures are dropped.
 */

export interface ReportInput {
  runId: string;
  pageUrl: string;
  mode: ReportMode;
  tier: SolveTier;
  via: ReportVia;
  version: string;
  entries: Entry[];
  /** By entry id. */
  answers: Record<string, Answer>;
  /** Why an entry has no answer (AnswerError code or unreadable_options), by entry id. */
  errors: Record<string, string>;
  /** Fill results by entry id; absent when nothing was written. */
  fills: Record<string, { ok: boolean; reason?: string }>;
  share: boolean;
}

/** How a question was read, from what the run did with it. */
export function sourceOf(e: Entry, via: ReportVia): ReportSource {
  if (!e.fillable && e.id.startsWith('shot-')) return via === 'region' ? 'region' : 'fullshot';
  if (e.status === 'figure' && e.visionChecked) return 'figure';
  return e.visionChecked ? 'screenshot' : 'dom';
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function contentOf(e: Entry, a: Answer | undefined): ReportContent {
  const q = e.question;
  return {
    stem: cut(q.stem, 4000),
    ...(q.options
      ? {
          options: q.options
            .slice(0, 26)
            .map((o) => ({ key: cut(o.key, 8), text: cut(o.text, 500) })),
        }
      : {}),
    ...(a
      ? {
          answer: {
            ...(a.choice !== undefined ? { choice: cut(a.choice, 8) } : {}),
            ...(a.choices ? { choices: a.choices.slice(0, 26).map((k) => cut(k, 8)) } : {}),
            ...(a.bool !== undefined ? { bool: a.bool } : {}),
            ...(a.text !== undefined
              ? {
                  text: Array.isArray(a.text)
                    ? a.text.slice(0, 50).map((t) => cut(t, 1000))
                    : cut(a.text, 4000),
                }
              : {}),
          },
        }
      : {}),
  };
}

/** The page's origin: the server keeps only the host, so path and query never leave the browser. */
export function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** The report for one run, or null when it has no questions or the page has no origin. */
export function buildRunReport(input: ReportInput): RunReport | null {
  const entries = input.entries.slice(0, MAX_REPORT_QUESTIONS);
  const origin = originOf(input.pageUrl);
  if (entries.length === 0 || !origin) return null;
  return {
    runId: input.runId,
    pageUrl: origin,
    mode: input.mode,
    tier: input.tier,
    via: input.via,
    version: cut(input.version, 40),
    questions: entries.map((e) => {
      const a = input.answers[e.id];
      const fill = input.fills[e.id];
      const error = input.errors[e.id];
      return {
        qid: cut(e.id, 64),
        kind: e.question.kind,
        source: sourceOf(e, input.via),
        status: e.status,
        ...(a?.model ? { model: cut(a.model, 100) } : {}),
        ...(a?.confidence !== undefined ? { confidence: a.confidence } : {}),
        ...(a?.reviewed ? { reviewed: true } : {}),
        answered: !!a,
        ...(error && !a ? { error: cut(error, 40) } : {}),
        fill: fill ? (fill.ok ? 'ok' : 'failed') : 'none',
        ...(fill && !fill.ok && fill.reason ? { fillReason: cut(fill.reason, 200) } : {}),
        ...(input.share ? { content: contentOf(e, a) } : {}),
      };
    }),
  };
}

/** Reports in flight, so a run's verdicts never arrive before the run itself. */
const pending = new Map<string, Promise<unknown>>();

export function sendRunReport(input: ReportInput) {
  const report = buildRunReport(input);
  if (!report) return;
  const sent = postRunReport(report).catch(() => {});
  pending.set(report.runId, sent);
  void sent.finally(() => setTimeout(() => pending.delete(report.runId), 60_000));
}

/** Verdicts from one frame's content script; its question ids are local to the frame. */
export async function sendVerdicts(
  runId: string,
  frameId: number,
  verdicts: { id: string; verdict: Verdict; picked?: string[] }[],
) {
  if (verdicts.length === 0) return;
  await pending.get(runId);
  const body = {
    verdicts: verdicts.slice(0, MAX_REPORT_QUESTIONS).map((v) => ({
      qid: cut(entryId(frameId, v.id), 64),
      verdict: v.verdict,
      ...(v.picked ? { picked: v.picked.slice(0, 26).map((k) => cut(k, 8)) } : {}),
    })),
  };
  // The run's report may still be on its way (this worker restarted since sending it, so
  // `pending` doesn't know it): an unknown run is retried a couple of times.
  for (const wait of [0, 3_000, 10_000]) {
    if (wait) await sleep(wait);
    try {
      await postVerdicts(runId, body);
      return;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) return;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
