import type { Answer, AnswerError, Question } from '@quizpilot/shared';
import { z } from 'zod';
import { postJson, trimSlash, type RetryOptions } from './http';
import { JEV_PRICING, usageFrom, type ModelPricing } from './pricing';
import {
  addUsage,
  capabilitiesFor,
  ProviderError,
  toAnswerErrors,
  ZERO_USAGE,
  type CallCtx,
  type FetchFn,
  type Provider,
  type SolveOutput,
  type Usage,
} from './types';

export interface JevConfig {
  id: string;
  apiKey: string;
  /** Call TypeSafe directly, or through OpenRouter's Decisions API (same request/response shape). */
  via?: 'typesafe' | 'openrouter';
  model?: string;
  baseURL?: string;
  timeoutMs?: number;
  pricing?: ModelPricing;
  fetch?: FetchFn;
  retry?: Partial<RetryOptions>;
}

export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1';
export const JEV_DEFAULT_MODEL = 'jev-latest';
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api';
export const OPENROUTER_JEV_MODEL = 'typesafe/jev-1.13';

/** Endpoint and default model for each way of reaching Jev. */
export function jevEndpoint(config: Pick<JevConfig, 'via' | 'baseURL' | 'model'>) {
  return config.via === 'openrouter'
    ? {
        url: `${trimSlash(config.baseURL ?? OPENROUTER_DEFAULT_BASE_URL)}/alpha/decisions`,
        model: config.model ?? OPENROUTER_JEV_MODEL,
      }
    : {
        url: `${trimSlash(config.baseURL ?? JEV_DEFAULT_BASE_URL)}/systemone`,
        model: config.model ?? JEV_DEFAULT_MODEL,
      };
}

/**
 * Jev's limit is 64k tokens per request, 32k for state + the longest question. We budget in
 * characters and assume ~1 token per char, which is conservative for CJK and generous for English.
 */
const REQUEST_CHAR_BUDGET = 40_000;

const SUPPORTED = new Set<Question['kind']>(['single', 'multi', 'judge']);

const STATE =
  'Questions from a quiz or exercise on a web page. Each question is independent. ' +
  'Judge by factual correctness, not by wording or position of the options.';

const JevAnswer = z.union([
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().optional(),
    probabilities: z.record(z.string(), z.number()).optional(),
  }),
  z.object({ type: z.literal('noul'), noul: z.number() }),
]);

const JevResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      /** OpenRouter reports the billed cost in USD. */
      cost: z.number().optional(),
    })
    .optional(),
});

type JevQuestion =
  | { type: 'choice'; instructions: unknown; criteria: Record<string, string> }
  | { type: 'noul'; instructions: unknown; criteria: { true: string; false: string } };

/** One quiz question expands into one or more Jev questions (multi → one noul per option). */
interface Plan {
  question: Question;
  keys: string[];
}

export function createJevProvider(config: JevConfig): Provider {
  const { url, model } = jevEndpoint(config);
  const pricing = config.pricing ?? JEV_PRICING;

  async function call(chunk: Question[], ctx: CallCtx) {
    const questions: Record<string, JevQuestion> = {};
    // Keys only need to be unique within one request.
    const plans: Plan[] = chunk.map((q, i) => {
      const expanded = toJevQuestions(q, `q${i}`);
      Object.assign(questions, expanded);
      return { question: q, keys: Object.keys(expanded) };
    });

    const raw = await postJson(
      url,
      { state: STATE, model, questions },
      {
        fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          // OpenRouter app attribution; ignored by TypeSafe.
          ...(config.via === 'openrouter' ? { 'X-Title': 'QuizPilot' } : {}),
        },
        timeoutMs: config.timeoutMs ?? 30_000,
        signal: ctx.signal,
        retry: config.retry,
      },
    );
    const parsed = JevResponse.safeParse(raw);
    if (!parsed.success)
      throw new ProviderError('invalid_response', 'unexpected Jev response shape');
    const res = parsed.data;

    const answers: Answer[] = [];
    const errors: AnswerError[] = [];
    for (const plan of plans) {
      try {
        answers.push(fromJevAnswers(plan, res.answers, res.model));
      } catch (err) {
        errors.push({
          id: plan.question.id,
          code: 'invalid_response',
          message: (err as Error).message,
        });
      }
    }
    const usage: Usage = usageFrom(
      res.usage?.input_tokens ?? 0,
      res.usage?.output_tokens ?? 0,
      res.usage?.cost,
      pricing,
    );
    return { answers, errors, usage };
  }

  return {
    id: config.id,
    model,
    capabilities: capabilitiesFor('jev'),

    async solve(questions, ctx = {}): Promise<SolveOutput> {
      const out: SolveOutput = { answers: [], errors: [], usage: ZERO_USAGE };
      const supported: Question[] = [];
      for (const q of questions) {
        if (q.needsVision) {
          out.errors.push({ id: q.id, code: 'needs_vision', message: 'Jev cannot read images' });
        } else if (SUPPORTED.has(q.kind)) {
          supported.push(q);
        } else {
          out.errors.push({
            id: q.id,
            code: 'unsupported',
            message: `Jev cannot answer ${q.kind}`,
          });
        }
      }

      const chunks = chunkByChars(supported, REQUEST_CHAR_BUDGET);
      const results = await Promise.allSettled(chunks.map((chunk) => call(chunk, ctx)));

      // If every request failed the same way, surface it as a call-level failure.
      if (results.length > 0 && results.every((r) => r.status === 'rejected')) {
        throw (results[0] as PromiseRejectedResult).reason;
      }
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          out.answers.push(...r.value.answers);
          out.errors.push(...r.value.errors);
          out.usage = addUsage(out.usage, r.value.usage);
        } else {
          out.errors.push(...toAnswerErrors(r.reason, chunks[i]!));
        }
      });
      return out;
    },
  };
}

function toJevQuestions(q: Question, key: string): Record<string, JevQuestion> {
  const base = { question: q.stem, ...(q.context ? { context: q.context } : {}) };
  switch (q.kind) {
    case 'single':
      return {
        [key]: {
          type: 'choice',
          instructions: { ...base, task: 'Select the option that correctly answers the question.' },
          criteria: Object.fromEntries(q.options!.map((o) => [o.key, o.text || o.key])),
        },
      };
    case 'multi': {
      const allOptions = Object.fromEntries(q.options!.map((o) => [o.key, o.text]));
      return Object.fromEntries(
        q.options!.map((o, j) => [
          `${key}_o${j}`,
          {
            type: 'noul',
            instructions: {
              ...base,
              options: allOptions,
              task: `This question may have several correct options. Is option ${o.key} ("${o.text}") one of the correct answers?`,
            },
            criteria: {
              true: 'The option is a correct answer',
              false: 'The option is not a correct answer',
            },
          },
        ]),
      );
    }
    case 'judge':
      return {
        [key]: {
          type: 'noul',
          instructions: {
            statement: q.stem,
            ...(q.context ? { context: q.context } : {}),
            task: 'Is this statement true?',
          },
          criteria: { true: 'The statement is correct', false: 'The statement is incorrect' },
        },
      };
    default:
      throw new ProviderError('unsupported', `Jev cannot answer ${q.kind}`);
  }
}

function fromJevAnswers(plan: Plan, answers: Record<string, unknown>, model: string): Answer {
  const q = plan.question;
  const get = (key: string) => {
    const r = JevAnswer.safeParse(answers[key]);
    if (!r.success) throw new Error(`missing or malformed Jev answer for ${key}`);
    return r.data;
  };

  switch (q.kind) {
    case 'single': {
      const a = get(plan.keys[0]!);
      if (a.type !== 'choice' || !q.options!.some((o) => o.key === a.choice)) {
        throw new Error('Jev returned an unknown option');
      }
      return {
        id: q.id,
        kind: q.kind,
        model,
        choice: a.choice,
        ...(a.confidence === undefined ? {} : { confidence: a.confidence }),
      };
    }
    case 'multi': {
      const probs = plan.keys.map((k) => {
        const a = get(k);
        if (a.type !== 'noul') throw new Error('expected noul answer');
        return a.noul;
      });
      let chosen = q.options!.filter((_, j) => probs[j]! >= 0.5).map((o) => o.key);
      // A multi-select question has at least one correct option; take the likeliest.
      if (chosen.length === 0) chosen = [q.options![probs.indexOf(Math.max(...probs))]!.key];
      return {
        id: q.id,
        kind: q.kind,
        model,
        choices: chosen,
        confidence: Math.min(...probs.map(noulConfidence)),
      };
    }
    case 'judge': {
      const a = get(plan.keys[0]!);
      if (a.type !== 'noul') throw new Error('expected noul answer');
      return {
        id: q.id,
        kind: q.kind,
        model,
        bool: a.noul >= 0.5,
        confidence: noulConfidence(a.noul),
      };
    }
    default:
      throw new Error(`unsupported kind ${q.kind}`);
  }
}

/** Noul has no separate confidence; distance from 0.5, scaled to 0..1. */
function noulConfidence(p: number): number {
  return Math.abs(2 * p - 1);
}

/** Characters one quiz question adds to a Jev request (multi repeats the question per option). */
export function jevQuestionChars(q: Question): number {
  const optionChars = (q.options ?? []).reduce((n, o) => n + o.text.length + 16, 0);
  const base = q.stem.length + (q.context?.length ?? 0) + 120;
  // Multi repeats the question once per option.
  return q.kind === 'multi' ? (base + optionChars) * (q.options?.length ?? 1) : base + optionChars;
}

function chunkByChars(questions: Question[], budget: number): Question[][] {
  const chunks: Question[][] = [];
  let current: Question[] = [];
  let size = STATE.length;
  for (const q of questions) {
    const n = jevQuestionChars(q);
    if (current.length > 0 && size + n > budget) {
      chunks.push(current);
      current = [];
      size = STATE.length;
    }
    current.push(q);
    size += n;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
