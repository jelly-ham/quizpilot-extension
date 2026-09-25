import { ProviderId } from '@quizpilot/shared';
import { z } from 'zod';
import type { RetryOptions } from './http';
import { createJevProvider } from './jev';
import { createOpenAICompatibleProvider } from './openai-compatible';
import { ModelPricing } from './pricing';
import type { RoutingConfig } from './router';
import type { Question } from '@quizpilot/shared';
import {
  capabilitiesFor,
  errorCode,
  type Capabilities,
  type CallCtx,
  type FetchFn,
  type Provider,
} from './types';

const Common = {
  id: ProviderId,
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  pricing: ModelPricing.optional(),
};

export const ProviderConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('jev'),
    ...Common,
    apiKey: z.string().min(1),
    via: z.enum(['typesafe', 'openrouter']).optional(),
    model: z.string().min(1).optional(),
    baseURL: z.url().optional(),
  }),
  z.object({
    type: z.literal('openai-compatible'),
    ...Common,
    apiKey: z.string().min(1).optional(),
    baseURL: z.url(),
    model: z.string().min(1),
    vision: z.boolean().optional(),
    jsonMode: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const Routing = z.object({
  choice: ProviderId.optional(),
  text: ProviderId.optional(),
  vision: ProviderId.optional(),
  escalation: z
    .object({ provider: ProviderId.optional(), threshold: z.number().min(0).max(1) })
    .optional(),
}) satisfies z.ZodType<RoutingConfig>;

/** Everything needed to build a solver: stored by the extension (BYOK) or read from Worker env. */
export const ProviderSetup = z
  .object({
    providers: z.array(ProviderConfig).max(20),
    routing: Routing.prefault({}),
  })
  .superRefine((setup, ctx) => {
    const ids = new Set<string>();
    setup.providers.forEach((p, i) => {
      if (ids.has(p.id))
        ctx.addIssue({
          code: 'custom',
          path: ['providers', i, 'id'],
          message: 'duplicate provider id',
        });
      ids.add(p.id);
    });
    const refs: [string, string | undefined][] = [
      ['choice', setup.routing.choice],
      ['text', setup.routing.text],
      ['vision', setup.routing.vision],
      ['escalation', setup.routing.escalation?.provider],
    ];
    for (const [key, id] of refs) {
      if (id && !ids.has(id))
        ctx.addIssue({
          code: 'custom',
          path: ['routing', key],
          message: `unknown provider "${id}"`,
        });
    }
    const vision = setup.providers.find((p) => p.id === setup.routing.vision);
    if (vision && !capabilitiesOf(vision).vision) {
      ctx.addIssue({
        code: 'custom',
        path: ['routing', 'vision'],
        message: `provider "${vision.id}" has no image input`,
      });
    }
  });
export type ProviderSetup = z.infer<typeof ProviderSetup>;

/** What a configured provider can do, without constructing it. */
export function capabilitiesOf(config: ProviderConfig): Capabilities {
  return capabilitiesFor(config.type, config.type === 'openai-compatible' ? config.vision : false);
}

/**
 * Default division of labour: Jev for choice/judge when present, the first text model for text,
 * the first image-capable model for screenshots. `current` choices are kept when still valid.
 */
export function defaultRouting(
  configs: ProviderConfig[],
  current: RoutingConfig = {},
): RoutingConfig {
  const ids = new Set(configs.map((c) => c.id));
  const valid = (id?: string) => (id && ids.has(id) ? id : undefined);
  const first = (pred: (c: ProviderConfig) => boolean) => configs.find(pred)?.id;
  const text = first((c) => capabilitiesOf(c).freeText);
  const vision = valid(current.vision);
  const escalation = current.escalation;
  return {
    choice: valid(current.choice) ?? first((c) => c.type === 'jev') ?? text,
    text: valid(current.text) ?? text,
    vision:
      vision && capabilitiesOf(configs.find((c) => c.id === vision)!).vision
        ? vision
        : first((c) => capabilitiesOf(c).vision),
    ...(escalation
      ? {
          escalation: {
            threshold: escalation.threshold,
            ...(valid(escalation.provider) ? { provider: escalation.provider } : {}),
          },
        }
      : {}),
  };
}

export interface ProviderDeps {
  fetch?: FetchFn;
  retry?: Partial<RetryOptions>;
}

export function createProvider(config: ProviderConfig, deps: ProviderDeps = {}): Provider {
  switch (config.type) {
    case 'jev':
      return createJevProvider({ ...config, ...deps });
    case 'openai-compatible':
      return createOpenAICompatibleProvider({ ...config, ...deps });
  }
}

export function createProviders(
  configs: ProviderConfig[],
  deps: ProviderDeps = {},
): Map<string, Provider> {
  const map = new Map<string, Provider>();
  for (const c of configs) {
    if (map.has(c.id)) throw new Error(`duplicate provider id "${c.id}"`);
    map.set(c.id, createProvider(c, deps));
  }
  return map;
}

export type ProviderTestResult =
  | { ok: true; model: string; latencyMs: number }
  | { ok: false; error: { code: string; message: string } };

/** Cheap round trip for the "test connection" button: one trivial question. */
export async function testProvider(
  provider: Provider,
  ctx: CallCtx = {},
): Promise<ProviderTestResult> {
  const probe: Question = provider.capabilities.judge
    ? { id: 'probe', kind: 'judge', stem: '1 + 1 = 2', source: 'dom' }
    : { id: 'probe', kind: 'fill', stem: '1 + 1 = ___', blanks: 1, source: 'dom' };
  const started = Date.now();
  try {
    const out = await provider.solve([probe], ctx);
    const answer = out.answers[0];
    if (!answer) {
      const e = out.errors[0];
      return {
        ok: false,
        error: { code: e?.code ?? 'invalid_response', message: e?.message ?? 'no answer' },
      };
    }
    return { ok: true, model: answer.model, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      error: { code: errorCode(err), message: err instanceof Error ? err.message : String(err) },
    };
  }
}
