import type {
  Answer,
  AnswerError,
  MarkedQuestion,
  MarkRequest,
  Question,
  ReadRequest,
  SolvePrefs,
} from '@quizpilot/shared';
import {
  errorCode,
  isVisionCapable,
  ProviderError,
  toAnswerErrors,
  type CallCtx,
  type Provider,
  type ReadOutput,
  type Usage,
} from './types';

export interface RoutingConfig {
  /** single / multi / judge. Default: Jev. */
  choice?: string;
  /** fill / essay, and fallback for choice questions. */
  text?: string;
  /** Screenshot reading and needsVision questions. */
  vision?: string;
  /** Re-ask low-confidence answers. Provider defaults to `text`. */
  escalation?: { provider?: string; threshold: number };
}

export type ProviderSet = ReadonlyMap<string, Provider>;

export interface UsageRecord extends Usage {
  provider: string;
  model: string;
  purpose: 'solve' | 'escalate' | 'read' | 'mark';
  questionCount: number;
}

export interface RoutedSolve {
  /** In the same order as the input questions; failed questions are in `errors` instead. */
  answers: Answer[];
  errors: AnswerError[];
  usage: UsageRecord[];
}

export const DEFAULT_ESCALATION_THRESHOLD = 0.6;

export function canAnswer(p: Provider, q: Question): boolean {
  if (q.needsVision && !p.capabilities.vision) return false;
  switch (q.kind) {
    case 'single':
    case 'multi':
      return p.capabilities.choice;
    case 'judge':
      return p.capabilities.judge;
    case 'fill':
    case 'essay':
      return p.capabilities.freeText;
  }
}

/** Candidate providers for a question, best first. */
function candidates(
  q: Question,
  routing: RoutingConfig,
  prefs: SolvePrefs,
  providers: ProviderSet,
): Provider[] {
  const ids: (string | undefined)[] = [];
  if (prefs.provider !== 'auto') ids.push(prefs.provider);
  if (q.needsVision) ids.push(routing.vision);
  else if (q.kind === 'fill' || q.kind === 'essay') ids.push(routing.text);
  else ids.push(routing.choice, routing.text);
  // Last resort: anything configured that can do it, e.g. a BYOK user with a single model.
  ids.push(...providers.keys());

  const seen = new Set<string>();
  const out: Provider[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const p = providers.get(id);
    if (p && canAnswer(p, q)) out.push(p);
  }
  return out;
}

export async function routeSolve(
  questions: Question[],
  providers: ProviderSet,
  routing: RoutingConfig,
  prefs: SolvePrefs,
  ctx: CallCtx = {},
): Promise<RoutedSolve> {
  if (prefs.provider !== 'auto' && !providers.has(prefs.provider)) {
    throw new ProviderError('bad_request', `unknown provider "${prefs.provider}"`);
  }
  const errors: AnswerError[] = [];
  const groups = new Map<Provider, Question[]>();
  for (const q of questions) {
    const p = candidates(q, routing, prefs, providers)[0];
    if (!p) {
      errors.push(
        q.needsVision
          ? { id: q.id, code: 'needs_vision', message: 'no vision-capable model configured' }
          : {
              id: q.id,
              code: 'unsupported',
              message: `no model configured for ${q.kind} questions`,
            },
      );
      continue;
    }
    groups.set(p, [...(groups.get(p) ?? []), q]);
  }

  const answered = new Map<string, { answer: Answer; provider: Provider }>();
  const usage: UsageRecord[] = [];
  await runGroups(groups, 'solve', ctx, answered, errors, usage);

  // Turning review on is enough: without a configured reviewer or threshold, the text model
  // reviews anything below the default threshold.
  if (prefs.allowEscalation) {
    await escalate(questions, providers, routing, answered, usage, ctx);
  }

  const answers = questions.flatMap((q) => answered.get(q.id)?.answer ?? []);
  return { answers, errors: sortByQuestion(errors, questions), usage };
}

async function runGroups(
  groups: Map<Provider, Question[]>,
  purpose: UsageRecord['purpose'],
  ctx: CallCtx,
  answered: Map<string, { answer: Answer; provider: Provider }>,
  errors: AnswerError[] | null,
  usage: UsageRecord[],
): Promise<void> {
  await Promise.all(
    [...groups].map(async ([provider, qs]) => {
      try {
        const out = await provider.solve(qs, ctx);
        for (const a of out.answers) answered.set(a.id, { answer: a, provider });
        errors?.push(...out.errors);
        usage.push({
          ...out.usage,
          provider: provider.id,
          model: provider.model,
          purpose,
          questionCount: qs.length,
        });
      } catch (err) {
        // The caller gave up: stop, don't report it as N per-question failures.
        if (ctx.signal?.aborted || errorCode(err) === 'aborted') throw err;
        if (!errors) return; // Escalation failures keep the original answers.
        errors.push(...toAnswerErrors(err, qs));
      }
    }),
  );
}

async function escalate(
  questions: Question[],
  providers: ProviderSet,
  routing: RoutingConfig,
  answered: Map<string, { answer: Answer; provider: Provider }>,
  usage: UsageRecord[],
  ctx: CallCtx,
): Promise<void> {
  const { threshold, provider: id = routing.text } = routing.escalation ?? {
    threshold: DEFAULT_ESCALATION_THRESHOLD,
  };
  const reviewer = id ? providers.get(id) : undefined;
  if (!reviewer) return;

  const doubtful = questions.filter((q) => {
    const hit = answered.get(q.id);
    return (
      hit &&
      hit.provider !== reviewer &&
      (hit.answer.confidence ?? 1) < threshold &&
      canAnswer(reviewer, q)
    );
  });
  if (doubtful.length === 0) return;

  const second = new Map<string, { answer: Answer; provider: Provider }>();
  await runGroups(new Map([[reviewer, doubtful]]), 'escalate', ctx, second, null, usage);
  for (const [qid, hit] of second)
    answered.set(qid, { ...hit, answer: { ...hit.answer, reviewed: true } });
}

export async function routeRead(
  req: ReadRequest,
  providers: ProviderSet,
  routing: RoutingConfig,
  ctx: CallCtx = {},
): Promise<ReadOutput & { usage: UsageRecord }> {
  const preferred = routing.vision ? providers.get(routing.vision) : undefined;
  const reader = [preferred, ...providers.values()].find(
    (p): p is Provider & Required<Pick<Provider, 'read' | 'mark'>> => !!p && isVisionCapable(p),
  );
  if (!reader) throw new ProviderError('needs_vision', 'no vision-capable model configured');
  const out = await reader.read(req, ctx);
  return {
    questions: out.questions,
    usage: {
      ...out.usage,
      provider: reader.id,
      model: reader.model,
      purpose: 'read',
      questionCount: out.questions.length,
    },
  };
}

function sortByQuestion(errors: AnswerError[], questions: Question[]): AnswerError[] {
  const order = new Map(questions.map((q, i) => [q.id, i]));
  return errors.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function routeMark(
  req: MarkRequest,
  providers: ProviderSet,
  routing: RoutingConfig,
  ctx: CallCtx = {},
): Promise<{ questions: MarkedQuestion[]; usage: UsageRecord }> {
  const preferred = routing.vision ? providers.get(routing.vision) : undefined;
  const marker = [preferred, ...providers.values()].find(
    (p): p is Provider & Required<Pick<Provider, 'read' | 'mark'>> => !!p && isVisionCapable(p),
  );
  if (!marker) throw new ProviderError('needs_vision', 'no vision-capable model configured');
  const out = await marker.mark(req, ctx);
  return {
    questions: out.questions,
    usage: {
      ...out.usage,
      provider: marker.id,
      model: marker.model,
      purpose: 'mark',
      questionCount: out.questions.length,
    },
  };
}
