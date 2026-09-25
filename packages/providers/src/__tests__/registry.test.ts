import { describe, expect, it } from 'vitest';
import {
  createProvider,
  createProviders,
  ProviderSetup,
  testProvider,
  capabilitiesOf,
  defaultRouting,
} from '../registry';
import { fakeFetch, json } from './helpers';

const jevCfg = { type: 'jev', id: 'jev', apiKey: 'k' } as const;
const gptCfg = {
  type: 'openai-compatible',
  id: 'gpt',
  apiKey: 'k',
  baseURL: 'https://api.openai.com/v1',
  model: 'gpt-x',
  vision: true,
} as const;

describe('ProviderSetup', () => {
  it('accepts a valid setup', () => {
    const r = ProviderSetup.safeParse({
      providers: [jevCfg, gptCfg],
      routing: { choice: 'jev', text: 'gpt', vision: 'gpt' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown routing targets, duplicate ids and non-vision vision routes', () => {
    const issues = (input: unknown) =>
      ProviderSetup.safeParse(input).error?.issues.map((i) => i.path.join('.'));
    expect(issues({ providers: [jevCfg], routing: { text: 'nope' } })).toEqual(['routing.text']);
    expect(issues({ providers: [jevCfg, jevCfg] })).toEqual(['providers.1.id']);
    expect(issues({ providers: [jevCfg], routing: { vision: 'jev' } })).toEqual(['routing.vision']);
  });
});

describe('createProviders', () => {
  it('builds providers with the right capabilities', () => {
    const map = createProviders([jevCfg, gptCfg]);
    expect(map.get('jev')!.capabilities).toEqual({
      choice: true,
      judge: true,
      freeText: false,
      vision: false,
    });
    expect(map.get('gpt')!.capabilities.vision).toBe(true);
    expect(map.get('gpt')!.read).toBeTypeOf('function');
  });
});

describe('testProvider', () => {
  it('reports success with the model name', async () => {
    const fetch = fakeFetch(
      json({ model: 'jev-1.13.0', answers: { q0: { type: 'noul', noul: 0.99 } } }),
    );
    const r = await testProvider(createProvider(jevCfg, { fetch }));
    expect(r).toMatchObject({ ok: true, model: 'jev-1.13.0' });
  });

  it('reports failures with their code', async () => {
    const fetch = fakeFetch(json({ error: 'nope' }, 401));
    const r = await testProvider(createProvider(jevCfg, { fetch, retry: { retries: 0 } }));
    expect(r).toMatchObject({ ok: false, error: { code: 'auth' } });
  });

  it('probes text-only providers with a fill question', async () => {
    const fetch = fakeFetch(
      json({ choices: [{ message: { content: '{"answers":[{"id":"probe","text":["2"]}]}' } }] }),
    );
    const provider = createProvider({ ...gptCfg, vision: false }, { fetch });
    const textOnly = { ...provider, capabilities: { ...provider.capabilities, judge: false } };
    expect(await testProvider(textOnly)).toMatchObject({ ok: true });
    expect(fetch.calls[0]!.body.messages[1].content).toContain('"kind":"fill"');
  });
});

describe('capabilitiesOf / defaultRouting', () => {
  const ds = {
    type: 'openai-compatible',
    id: 'ds',
    apiKey: 'k',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'd',
  } as const;

  it('describes providers without constructing them', () => {
    expect(capabilitiesOf(jevCfg)).toEqual(createProvider(jevCfg).capabilities);
    expect(capabilitiesOf(gptCfg)).toEqual(createProvider(gptCfg).capabilities);
  });

  it('assigns Jev to choice, the first text model to text, the first vision model to screenshots', () => {
    expect(defaultRouting([ds, jevCfg, gptCfg])).toEqual({
      choice: 'jev',
      text: 'ds',
      vision: 'gpt',
    });
  });

  it('keeps valid choices and repairs stale or non-vision ones', () => {
    expect(
      defaultRouting([jevCfg, gptCfg], { text: 'gpt', vision: 'jev', choice: 'gone' }),
    ).toEqual({
      choice: 'jev',
      text: 'gpt',
      vision: 'gpt',
    });
  });
});
