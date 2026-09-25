import {
  MarkedQuestion,
  Question,
  type Answer,
  type AnswerError,
  type MarkRequest,
  type ReadRequest,
} from '@quizpilot/shared';
import { z } from 'zod';
import { postJson, trimSlash, type RetryOptions } from './http';
import { InvalidAnswer, normalizeAnswer, type RawAnswer } from './normalize';
import { usageFrom, type ModelPricing } from './pricing';
import {
  MARK_SYSTEM_PROMPT,
  markUserText,
  READ_SYSTEM_PROMPT,
  readUserText,
  SOLVE_SYSTEM_PROMPT,
  solveUserText,
} from './prompts';
import {
  addUsage,
  capabilitiesFor,
  ZERO_USAGE,
  ProviderError,
  type CallCtx,
  type FetchFn,
  type Provider,
  type ReadOutput,
  type SolveOutput,
  type Usage,
} from './types';

export interface OpenAICompatibleConfig {
  id: string;
  /** e.g. https://api.openai.com/v1, https://api.deepseek.com/v1, https://openrouter.ai/api/v1 */
  baseURL: string;
  model: string;
  /** Optional for local servers (Ollama, vLLM) that need no auth. */
  apiKey?: string;
  /** The model accepts image input. Enables read() and needsVision questions. */
  vision?: boolean;
  /** Send response_format: json_object. Turn off for servers that reject it. */
  jsonMode?: boolean;
  temperature?: number;
  /**
   * Let the model think before answering. Off by default: quiz answers are short, and a hybrid
   * model's hidden reasoning is billed as output (DeepSeek V4.1 Flash on OpenRouter wrote ~400–1,000
   * reasoning tokens for a true/false answer, ~40× the cost). Only sent to OpenRouter, whose
   * `reasoning` parameter other OpenAI-compatible servers don't know.
   */
  reasoning?: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  pricing?: ModelPricing;
  fetch?: FetchFn;
  retry?: Partial<RetryOptions>;
}

type ContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface ChatMessage {
  role: 'system' | 'user';
  content: string | ContentPart[];
}

const ChatResponse = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      /** OpenRouter reports the billed cost in USD. */
      cost: z.number().optional(),
    })
    .optional(),
});

const SolveReply = z.object({
  answers: z.array(z.looseObject({ id: z.union([z.string(), z.number()]) })),
});

const ReadReply = z.object({ questions: z.array(z.unknown()) });
const MarkReply = ReadReply;

/** OpenRouter's refusal when a model can't run with reasoning off. */
const REASONING_MANDATORY = /reasoning is mandatory|cannot be disabled/i;

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): Provider {
  const url = `${trimSlash(config.baseURL)}/chat/completions`;
  const vision = config.vision ?? false;
  const openRouter = new URL(config.baseURL).hostname.endsWith('openrouter.ai');
  // Some models refuse `reasoning: { enabled: false }` ("Reasoning is mandatory for this
  // endpoint"); after the first refusal this provider stops sending it.
  let reasoningRequired = false;

  async function chat(
    messages: ChatMessage[],
    ctx: CallCtx,
  ): Promise<{ content: string; model: string; usage: Usage }> {
    const send = () =>
      postJson(
        url,
        {
          model: config.model,
          messages,
          temperature: config.temperature ?? 0,
          ...(config.maxOutputTokens ? { max_tokens: config.maxOutputTokens } : {}),
          ...((config.jsonMode ?? true) ? { response_format: { type: 'json_object' } } : {}),
          ...(openRouter && !config.reasoning && !reasoningRequired
            ? { reasoning: { enabled: false } }
            : {}),
        },
        {
          fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
          headers: {
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            ...config.headers,
          },
          timeoutMs: config.timeoutMs ?? 60_000,
          signal: ctx.signal,
          retry: config.retry,
        },
      );
    let raw: unknown;
    try {
      raw = await send();
    } catch (err) {
      if (
        !(err instanceof ProviderError) ||
        err.code !== 'bad_request' ||
        !REASONING_MANDATORY.test(err.message) ||
        reasoningRequired
      )
        throw err;
      reasoningRequired = true;
      raw = await send();
    }
    const parsed = ChatResponse.safeParse(raw);
    if (!parsed.success)
      throw new ProviderError('invalid_response', 'unexpected chat completion shape');
    const res = parsed.data;
    return {
      content: res.choices[0]!.message.content ?? '',
      model: res.model ?? config.model,
      usage: usageFrom(
        res.usage?.prompt_tokens ?? 0,
        res.usage?.completion_tokens ?? 0,
        res.usage?.cost,
        config.pricing,
      ),
    };
  }

  /**
   * Chat and parse the reply against `schema`. Models occasionally emit broken JSON (e.g. a
   * full-width colon inside a key), so a reply that doesn't parse is retried once; usage of both
   * attempts is billed.
   */
  async function chatJson<T extends z.ZodType>(
    messages: ChatMessage[],
    schema: T,
    expected: string,
    ctx: CallCtx,
  ): Promise<{ data: z.infer<T>; model: string; usage: Usage }> {
    let total: Usage = ZERO_USAGE;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { content, model, usage } = await chat(messages, ctx);
      total = addUsage(total, usage);
      const parsed = schema.safeParse(extractJson(content));
      if (parsed.success) return { data: parsed.data, model, usage: total };
    }
    throw new ProviderError('invalid_response', `model did not return ${expected}`);
  }

  const provider: Provider = {
    id: config.id,
    model: config.model,
    capabilities: capabilitiesFor('openai-compatible', vision),

    async solve(questions, ctx = {}): Promise<SolveOutput> {
      const errors: AnswerError[] = [];
      const askable = questions.filter((q) => {
        if (q.needsVision && !vision) {
          errors.push({
            id: q.id,
            code: 'needs_vision',
            message: `${config.model} cannot read images`,
          });
          return false;
        }
        return true;
      });
      if (askable.length === 0) return { answers: [], errors, usage: ZERO_USAGE };

      const { data, model, usage } = await chatJson(
        [
          { role: 'system', content: SOLVE_SYSTEM_PROMPT },
          { role: 'user', content: solveContent(askable) },
        ],
        SolveReply,
        '{"answers": [...]}',
        ctx,
      );
      const byId = new Map(data.answers.map((a) => [String(a.id), a as RawAnswer]));

      const answers: Answer[] = [];
      for (const q of askable) {
        const raw = byId.get(q.id);
        if (!raw) {
          errors.push({
            id: q.id,
            code: 'invalid_response',
            message: 'model skipped this question',
          });
          continue;
        }
        try {
          answers.push(normalizeAnswer(q, raw, model));
        } catch (err) {
          if (!(err instanceof InvalidAnswer)) throw err;
          errors.push({ id: q.id, code: 'invalid_response', message: err.message });
        }
      }
      return { answers, errors, usage };
    },
  };

  if (vision) {
    provider.read = async (req: ReadRequest, ctx: CallCtx = {}): Promise<ReadOutput> => {
      const { data, usage } = await chatJson(
        [
          { role: 'system', content: READ_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: readUserText(req.hint) },
              { type: 'image_url', image_url: { url: req.image } },
            ],
          },
        ],
        ReadReply,
        '{"questions": [...]}',
        ctx,
      );

      const questions: Question[] = [];
      data.questions.forEach((raw, i) => {
        if (typeof raw !== 'object' || raw === null) return;
        const parsed = Question.safeParse({ ...raw, id: `v${i + 1}`, source: 'vision' });
        if (parsed.success) questions.push(parsed.data);
      });
      if (questions.length === 0 && data.questions.length > 0) {
        throw new ProviderError(
          'invalid_response',
          'model returned questions in an unusable shape',
        );
      }
      return { questions, usage };
    };
  }

  if (vision) {
    provider.mark = async (req: MarkRequest, ctx: CallCtx = {}) => {
      const { data, usage } = await chatJson(
        [
          { role: 'system', content: MARK_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: markUserText(req.marks) },
              { type: 'image_url', image_url: { url: req.image } },
            ],
          },
        ],
        MarkReply,
        '{"questions": [...]}',
        ctx,
      );
      // Keep only numbers we actually drew; models occasionally invent or repeat them.
      const known = new Set(req.marks.map((m) => m.id));
      const questions = data.questions.flatMap((raw) => {
        const q = MarkedQuestion.safeParse(raw);
        if (!q.success || !known.has(q.data.stem)) return [];
        const options = [
          ...new Set(q.data.options.filter((n) => known.has(n) && n !== q.data.stem)),
        ];
        const inputs = [...new Set(q.data.inputs.filter((n) => known.has(n)))];
        if (options.length < 2 && inputs.length === 0) return [];
        return [{ ...q.data, options, inputs }];
      });
      return { questions, usage };
    };
  }

  return provider;
}

function solveContent(questions: Question[]): string | ContentPart[] {
  const text = solveUserText(questions);
  const withImages = questions.filter((q) => q.needsVision && q.images?.length);
  if (withImages.length === 0) return text;
  // One screenshot often backs several questions; send each distinct image once.
  const byImage = new Map<string, { label: string; questions: string[] }>();
  for (const q of withImages) {
    for (const img of q.images!) {
      const entry = byImage.get(img.dataUrl) ?? { label: img.id, questions: [] };
      entry.questions.push(q.id);
      byImage.set(img.dataUrl, entry);
    }
  }
  const parts: ContentPart[] = [{ type: 'text', text }];
  for (const [dataUrl, { label, questions: ids }] of byImage) {
    parts.push({
      type: 'text',
      text: `Image "${label}" for question${ids.length > 1 ? 's' : ''} ${ids.map((id) => `"${id}"`).join(', ')}:`,
    });
    parts.push({ type: 'image_url', image_url: { url: dataUrl } });
  }
  return parts;
}

/** Parse a JSON object from model output, tolerating ```json fences or surrounding prose. */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!);
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  return undefined;
}

/**
 * Model ids a server offers (GET {baseURL}/models), for picking one when adding a provider.
 * Most OpenAI-compatible servers support it; Anthropic's needs its own auth headers.
 */
export async function listModels(
  baseURL: string,
  apiKey: string | undefined,
  opts: { fetch?: FetchFn; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<string[]> {
  const url = `${trimSlash(baseURL)}/models`;
  const anthropic = new URL(baseURL).hostname === 'api.anthropic.com';
  const res = await (opts.fetch ?? globalThis.fetch.bind(globalThis))(url, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(apiKey && anthropic ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : {}),
      ...opts.headers,
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) throw new ProviderError(codeForHttp(res.status), `HTTP ${res.status}`, res.status);
  const body = (await res.json().catch(() => ({}))) as {
    data?: { id?: string }[];
    models?: { id?: string; name?: string }[];
  };
  const ids = [
    ...(body.data ?? []).map((m) => m.id),
    ...(body.models ?? []).map((m) => m.id ?? m.name),
  ].filter((id): id is string => !!id);
  return [...new Set(ids)].sort();
}

const codeForHttp = (status: number) =>
  status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : 'upstream';
