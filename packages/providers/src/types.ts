import type {
  Answer,
  AnswerError,
  MarkedQuestion,
  MarkRequest,
  ErrorCode,
  ProviderId,
  Question,
  ReadRequest,
} from '@quizpilot/shared';

export interface Capabilities {
  /** single / multi */
  choice: boolean;
  judge: boolean;
  /** fill / essay */
  freeText: boolean;
  /** Can read screenshots and answer needsVision questions. */
  vision: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Upstream cost in integer micro-USD. */
  costMicroUsd: number;
}

export interface CallCtx {
  signal?: AbortSignal;
}

export interface SolveOutput {
  answers: Answer[];
  errors: AnswerError[];
  usage: Usage;
}

export interface ReadOutput {
  questions: Question[];
  usage: Usage;
}

export interface Provider {
  id: ProviderId;
  /** Human-readable model name for logs, e.g. `jev-latest`. */
  model: string;
  capabilities: Capabilities;
  /**
   * Answers what it can; per-question problems go in `errors`. Throws ProviderError only when
   * the whole call fails (auth, network, ...).
   */
  solve(questions: Question[], ctx?: CallCtx): Promise<SolveOutput>;
  /** Vision providers only: transcribe a screenshot into questions. */
  read?(req: ReadRequest, ctx?: CallCtx): Promise<ReadOutput>;
  /** Vision providers only: say which numbered elements on a screenshot form each question. */
  mark?(req: MarkRequest, ctx?: CallCtx): Promise<{ questions: MarkedQuestion[]; usage: Usage }>;
}

export class ProviderError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type FetchFn = typeof fetch;

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costMicroUsd: a.costMicroUsd + b.costMicroUsd,
  };
}

export function isVisionCapable(
  p: Provider,
): p is Provider & Required<Pick<Provider, 'read' | 'mark'>> {
  return p.capabilities.vision && typeof p.read === 'function' && typeof p.mark === 'function';
}

/** Error code for anything thrown by a provider call. */
export function errorCode(err: unknown): ErrorCode {
  return err instanceof ProviderError ? err.code : 'upstream';
}

/** A failed call becomes one error per question it carried. */
export function toAnswerErrors(err: unknown, questions: readonly Question[]): AnswerError[] {
  const code = errorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  return questions.map((q) => ({ id: q.id, code, message }));
}

/** Capability table per provider type; the one place that knows what Jev vs an LLM can do. */
export function capabilitiesFor(type: 'jev' | 'openai-compatible', vision = false): Capabilities {
  return type === 'jev'
    ? { choice: true, judge: true, freeText: false, vision: false }
    : { choice: true, judge: true, freeText: true, vision };
}
