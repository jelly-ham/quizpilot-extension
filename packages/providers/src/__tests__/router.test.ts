import type { Answer, Question } from '@quizpilot/shared';
import { describe, expect, it } from 'vitest';
import { routeMark, routeRead, routeSolve, type ProviderSet, type RoutingConfig } from '../router';
import { ProviderError, type Capabilities, type Provider } from '../types';
import { fill, judge, PNG, q, single } from './helpers';

const usage = { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 };

/** Fake provider answering everything it gets with fixed confidence. */
function fake(
  id: string,
  caps: Partial<Capabilities>,
  opts: { confidence?: number; fail?: boolean } = {},
) {
  const seen: string[][] = [];
  const p: Provider = {
    id,
    model: `${id}-model`,
    capabilities: { choice: false, judge: false, freeText: false, vision: false, ...caps },
    async solve(qs: Question[]) {
      seen.push(qs.map((x) => x.id));
      if (opts.fail) throw new ProviderError('rate_limit', 'slow down');
      const answers: Answer[] = qs.map((x) => ({
        id: x.id,
        kind: x.kind,
        model: id,
        confidence: opts.confidence ?? 0.9,
      }));
      return { answers, errors: [], usage };
    },
  };
  if (caps.vision) {
    p.read = async () => ({ questions: [judge('v1')], usage });
    p.mark = async () => ({
      questions: [{ kind: 'single', stem: 1, options: [2, 3], inputs: [] }],
      usage,
    });
  }
  return Object.assign(p, { seen });
}

const jev = () => fake('jev', { choice: true, judge: true });
const gpt = (vision = false) => fake('gpt', { choice: true, judge: true, freeText: true, vision });
const set = (...ps: Provider[]): ProviderSet => new Map(ps.map((p) => [p.id, p]));
const routing: RoutingConfig = { choice: 'jev', text: 'gpt', vision: 'gpt' };
const auto = { provider: 'auto', allowEscalation: false };
const visual = (id: string) =>
  q({
    id,
    kind: 'single',
    stem: 'Which angle?',
    options: [
      { key: 'A', text: 'α' },
      { key: 'B', text: 'β' },
    ],
    needsVision: true,
    images: [{ id: 'f', dataUrl: PNG }],
  });

describe('routeSolve', () => {
  it('sends choice/judge to Jev, text to the LLM, needsVision to the vision model', async () => {
    const j = jev();
    const g = gpt(true);
    const out = await routeSolve(
      [single('s'), fill('f'), judge('t'), visual('v')],
      set(j, g),
      routing,
      auto,
    );
    expect(j.seen).toEqual([['s', 't']]);
    expect(g.seen).toEqual([['f', 'v']]);
    expect(out.answers.map((a) => a.id)).toEqual(['s', 'f', 't', 'v']);
    expect(out.usage.map((u) => [u.provider, u.purpose, u.questionCount])).toEqual([
      ['jev', 'solve', 2],
      ['gpt', 'solve', 2],
    ]);
  });

  it('marks needsVision questions needs_vision without a vision model', async () => {
    const out = await routeSolve([visual('v'), single('s')], set(jev(), gpt(false)), routing, auto);
    expect(out.errors).toEqual([
      { id: 'v', code: 'needs_vision', message: 'no vision-capable model configured' },
    ]);
    expect(out.answers.map((a) => a.id)).toEqual(['s']);
  });

  it('falls back to any capable provider (BYOK with a single model)', async () => {
    const g = gpt();
    const out = await routeSolve([single('s'), fill('f')], set(g), {}, auto);
    expect(g.seen).toEqual([['s', 'f']]);
    expect(out.errors).toEqual([]);
  });

  it('honours an explicit provider preference where capable', async () => {
    const j = jev();
    const g = gpt();
    await routeSolve([single('s'), fill('f')], set(j, g), routing, {
      provider: 'gpt',
      allowEscalation: false,
    });
    expect(j.seen).toEqual([]);
    expect(g.seen).toEqual([['s', 'f']]);
  });

  it('rejects an unknown forced provider', async () => {
    await expect(
      routeSolve([single('s')], set(gpt()), routing, { provider: 'nope', allowEscalation: false }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rethrows when the caller aborted instead of reporting per-question errors', async () => {
    const ctrl = new AbortController();
    const j = jev();
    j.solve = async () => {
      ctrl.abort();
      throw new ProviderError('aborted', 'request aborted');
    };
    await expect(
      routeSolve([single('s')], set(j), routing, auto, { signal: ctrl.signal }),
    ).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('turns a provider failure into per-question errors without losing other groups', async () => {
    const out = await routeSolve(
      [single('s'), fill('f')],
      set(fake('jev', { choice: true }, { fail: true }), gpt()),
      routing,
      auto,
    );
    expect(out.errors).toEqual([{ id: 's', code: 'rate_limit', message: 'slow down' }]);
    expect(out.answers.map((a) => a.id)).toEqual(['f']);
  });

  it('escalates low-confidence answers to the reviewer when allowed', async () => {
    const j = fake('jev', { choice: true, judge: true }, { confidence: 0.3 });
    const g = gpt();
    const cfg = { ...routing, escalation: { threshold: 0.6 } };

    const off = await routeSolve([single('s')], set(j, g), cfg, auto);
    expect(off.answers[0]!.model).toBe('jev');

    const on = await routeSolve([single('s')], set(j, g), cfg, {
      provider: 'auto',
      allowEscalation: true,
    });
    expect(on.answers[0]!.model).toBe('gpt');
    expect(on.usage.map((u) => u.purpose)).toEqual(['solve', 'escalate']);
  });

  it('reviews with the text model at the default threshold when only the switch is on', async () => {
    const j = fake('jev', { choice: true, judge: true }, { confidence: 0.36 });
    const on = await routeSolve([single('s')], set(j, gpt()), routing, {
      provider: 'auto',
      allowEscalation: true,
    });
    expect(on.answers[0]).toMatchObject({ model: 'gpt', reviewed: true });
  });

  it('keeps the original answer when escalation fails', async () => {
    const j = fake('jev', { choice: true }, { confidence: 0.1 });
    const g = fake('gpt', { choice: true, freeText: true }, { fail: true });
    const out = await routeSolve(
      [single('s')],
      set(j, g),
      { ...routing, escalation: { threshold: 0.6 } },
      { provider: 'auto', allowEscalation: true },
    );
    expect(out.answers[0]!.model).toBe('jev');
    expect(out.errors).toEqual([]);
  });
});

describe('routeRead', () => {
  it('uses the vision provider', async () => {
    const out = await routeRead(
      { pageUrl: 'https://example.com', image: PNG },
      set(jev(), gpt(true)),
      routing,
    );
    expect(out.questions).toHaveLength(1);
    expect(out.usage).toMatchObject({ provider: 'gpt', purpose: 'read', questionCount: 1 });
  });

  it('fails clearly when no provider can read images', async () => {
    await expect(
      routeRead({ pageUrl: 'https://example.com', image: PNG }, set(jev(), gpt(false)), routing),
    ).rejects.toMatchObject({
      code: 'needs_vision',
    });
  });
});

describe('routeMark', () => {
  it('uses the vision provider and reports mark usage', async () => {
    const out = await routeMark(
      { pageUrl: 'https://example.com', image: PNG, marks: [{ id: 1, tag: 'div', text: 'Q' }] },
      set(jev(), gpt(true)),
      routing,
    );
    expect(out.questions).toHaveLength(1);
    expect(out.usage).toMatchObject({ provider: 'gpt', purpose: 'mark' });
  });
});
