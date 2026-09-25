import { describe, expect, it } from 'vitest';
import { createJevProvider } from '../jev';
import { ProviderError } from '../types';
import { fakeFetch, fill, judge, json, multi, noRetry, q, single } from './helpers';

const jev = (fetch: ReturnType<typeof fakeFetch>) =>
  createJevProvider({ id: 'jev', apiKey: 'sk-test', fetch, retry: noRetry });

describe('Jev provider', () => {
  it('maps single / multi / judge into one systemone request', async () => {
    const fetch = fakeFetch((req) => {
      const keys = Object.keys(req.body.questions);
      expect(keys).toEqual(['q0', 'q1_o0', 'q1_o1', 'q1_o2', 'q2']);
      return json({
        model: 'jev-1.13.0',
        answers: {
          q0: {
            type: 'choice',
            choice: 'B',
            confidence: 0.97,
            probabilities: { A: 0.03, B: 0.97 },
          },
          q1_o0: { type: 'noul', noul: 0.95 },
          q1_o1: { type: 'noul', noul: 0.02 },
          q1_o2: { type: 'noul', noul: 0.9 },
          q2: { type: 'noul', noul: 0.99 },
        },
        usage: { input_tokens: 1_000_000, output_tokens: 50 },
      });
    });

    const out = await jev(fetch).solve([single('s'), multi('m'), judge('j')]);

    const req = fetch.calls[0]!;
    expect(req.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(req.body.model).toBe('jev-latest');
    expect(req.body.questions.q0).toMatchObject({ type: 'choice', criteria: { A: '3', B: '4' } });
    expect(req.body.questions.q2.type).toBe('noul');

    expect(out.errors).toEqual([]);
    expect(out.answers).toEqual([
      { id: 's', kind: 'single', model: 'jev-1.13.0', choice: 'B', confidence: 0.97 },
      { id: 'm', kind: 'multi', model: 'jev-1.13.0', choices: ['A', 'C'], confidence: 0.8 },
      { id: 'j', kind: 'judge', model: 'jev-1.13.0', bool: true, confidence: expect.closeTo(0.98) },
    ]);
    // $0.042 per M input tokens, output free.
    expect(out.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 50, costMicroUsd: 42_000 });
  });

  it('picks the likeliest option when no multi option passes 0.5', async () => {
    const fetch = fakeFetch(
      json({
        model: 'jev',
        answers: {
          q0_o0: { type: 'noul', noul: 0.2 },
          q0_o1: { type: 'noul', noul: 0.4 },
          q0_o2: { type: 'noul', noul: 0.1 },
        },
      }),
    );
    const out = await jev(fetch).solve([multi('m')]);
    expect(out.answers[0]!.choices).toEqual(['B']);
  });

  it('never sends fill, essay or needsVision questions', async () => {
    const fetch = fakeFetch(json({ model: 'jev', answers: {} }));
    const vision = q({
      id: 'v',
      kind: 'judge',
      stem: 'Is the triangle isosceles?',
      needsVision: true,
      images: [{ id: 'fig', dataUrl: 'data:image/png;base64,AAAA' }],
    });
    const out = await jev(fetch).solve([fill('f'), vision]);
    expect(fetch.calls).toHaveLength(0);
    expect(out.errors.map((e) => [e.id, e.code])).toEqual([
      ['f', 'unsupported'],
      ['v', 'needs_vision'],
    ]);
  });

  it('reports an unknown option as a per-question error', async () => {
    const fetch = fakeFetch(
      json({
        model: 'jev',
        answers: { q0: { type: 'choice', choice: 'Z' }, q1: { type: 'noul', noul: 0.1 } },
      }),
    );
    const out = await jev(fetch).solve([single('s'), judge('j')]);
    expect(out.errors).toEqual([
      { id: 's', code: 'invalid_response', message: expect.any(String) },
    ]);
    expect(out.answers).toEqual([expect.objectContaining({ id: 'j', bool: false })]);
  });

  it('splits large batches and keeps partial results when one request fails', async () => {
    const long = (id: string) => judge(id, 'x'.repeat(7_900));
    let call = 0;
    const fetch = fakeFetch((req) => {
      const keys = Object.keys(req.body.questions);
      // Fail the second request.
      if (++call === 2) return json({ error: 'overloaded' }, 529);
      return json({
        model: 'jev',
        answers: Object.fromEntries(keys.map((k) => [k, { type: 'noul', noul: 1 }])),
        usage: { input_tokens: 10, output_tokens: 0 },
      });
    });
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const out = await jev(fetch).solve(ids.map(long));

    expect(fetch.calls).toHaveLength(2);
    // Keys restart per request; the first request carried the first N questions.
    const firstCount = Object.keys(fetch.calls[0]!.body.questions).length;
    expect(Object.keys(fetch.calls[1]!.body.questions)[0]).toBe('q0');
    const failed = ids.slice(firstCount);
    expect(out.errors.map((e) => [e.id, e.code])).toEqual(failed.map((id) => [id, 'overloaded']));
    expect(out.answers.map((a) => a.id)).toEqual(ids.slice(0, firstCount));
    expect(out.usage.inputTokens).toBe(10);
  });

  it('throws a ProviderError when the only request fails', async () => {
    const fetch = fakeFetch(json({ error: 'bad key' }, 401));
    await expect(jev(fetch).solve([single('s')])).rejects.toMatchObject({
      code: 'auth',
      status: 401,
    });
    await expect(jev(fetch).solve([single('s')])).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects malformed responses', async () => {
    const fetch = fakeFetch(json({ nope: true }));
    await expect(jev(fetch).solve([single('s')])).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('can go through OpenRouter, using its reported cost', async () => {
    const fetch = fakeFetch(
      json({
        model: 'typesafe/jev-1.13-20260917',
        answers: { q0: { type: 'noul', noul: 0.97 } },
        usage: { input_tokens: 396, output_tokens: 50, cost: 0.000016632 },
        id: 'gen-dec-1',
        provider: 'TypeSafe',
      }),
    );
    const provider = createJevProvider({
      id: 'jev',
      apiKey: 'sk-or',
      via: 'openrouter',
      fetch,
      retry: noRetry,
    });
    const out = await provider.solve([judge('j')]);
    expect(fetch.calls[0]!.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(fetch.calls[0]!.body.model).toBe('typesafe/jev-1.13');
    expect(fetch.calls[0]!.headers['x-title']).toBe('QuizPilot');
    expect(out.answers[0]).toMatchObject({ bool: true, model: 'typesafe/jev-1.13-20260917' });
    expect(out.usage).toEqual({ inputTokens: 396, outputTokens: 50, costMicroUsd: 17 });
  });
});
