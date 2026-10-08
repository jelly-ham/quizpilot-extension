import type { ProviderConfig } from '@quizpilot/providers';
import { describe, expect, it } from 'vitest';
import { ProviderConfig as ProviderConfigSchema } from '@quizpilot/providers';
import { originPattern, PRESETS, supportsReasoning, uniqueId } from './presets';

const jev: ProviderConfig = { type: 'jev', id: 'jev', apiKey: 'k' };
const qwen: ProviderConfig = {
  type: 'openai-compatible',
  id: 'qwen',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-vl-max',
  apiKey: 'k',
  vision: true,
};

describe('helpers', () => {
  it('uniqueId suffixes taken ids', () => {
    expect(uniqueId('openai', ['openai', 'openai-2'])).toBe('openai-3');
  });

  it('originPattern uses the provider origin', () => {
    expect(originPattern(jev)).toBe('https://api.typesafe.ai/*');
    expect(originPattern({ ...jev, via: 'openrouter' })).toBe('https://openrouter.ai/*');
    expect(originPattern(qwen)).toBe('https://dashscope.aliyuncs.com/*');
  });
});

describe('supportsReasoning', () => {
  it('offers a thinking level only for OpenRouter, whose reasoning field the adapter sends', () => {
    expect(supportsReasoning('https://openrouter.ai/api/v1')).toBe(true);
    expect(supportsReasoning('https://api.openai.com/v1')).toBe(false);
    expect(supportsReasoning('not a url')).toBe(false);
    // A look-alike host is not OpenRouter.
    expect(supportsReasoning('https://notopenrouter.ai/v1')).toBe(false);
    expect(supportsReasoning('https://eu.openrouter.ai/api/v1')).toBe(true);
  });

  it('a config with a thinking level is valid', () => {
    const r = ProviderConfigSchema.safeParse({ ...qwen, reasoning: 'medium' });
    expect(r.success).toBe(true);
  });
});

describe('presets', () => {
  it('each preset makes a valid config once a model and key are filled in', () => {
    for (const p of PRESETS) {
      const config =
        p.type === 'jev'
          ? { type: 'jev', id: p.id, apiKey: 'k', via: p.via }
          : {
              type: 'openai-compatible',
              id: p.id,
              baseURL: p.id === 'custom' ? 'https://llm.example.com/v1' : p.baseURL,
              model: p.model || 'some-model',
              vision: p.vision,
              apiKey: 'k',
              ...(p.headers ? { headers: p.headers } : {}),
              ...(p.jsonMode === false ? { jsonMode: false } : {}),
            };
      expect(ProviderConfigSchema.safeParse(config).success, p.id).toBe(true);
    }
    expect(PRESETS.length).toBeGreaterThanOrEqual(20);
  });
});
