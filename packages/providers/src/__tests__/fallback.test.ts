import { describe, expect, it } from 'vitest';
import { circuitBreaker, withFallback } from '../fallback';
import { ProviderError, type Provider } from '../types';

const provider = (id: string, model: string, fail?: string): Provider & { calls: number } => {
  const p = {
    id,
    model,
    calls: 0,
    capabilities: { choice: true, judge: true, freeText: true, vision: false },
    async solve() {
      p.calls++;
      if (fail) throw new ProviderError(fail as never, 'down');
      return {
        answers: [{ id: 'q', kind: 'single' as const, choice: 'A', model }],
        errors: [],
        usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 },
      };
    },
  };
  return p;
};

describe('withFallback', () => {
  it('uses the backup when the primary service fails, then skips the primary for a while', async () => {
    let t = 0;
    const breaker = circuitBreaker(60_000, () => t);
    const primary = provider('m', 'deepseek/deepseek-v4.1-flash', 'overloaded');
    const backup = provider('b', 'deepseek-chat');
    const p = withFallback(primary, backup, breaker);

    const first = await p.solve([]);
    expect(first.answers[0]!.model).toBe('deepseek-chat');
    expect(p.model).toBe('deepseek-chat');
    expect(primary.calls).toBe(1);

    await p.solve([]); // breaker open: straight to the backup
    expect(primary.calls).toBe(1);
    expect(backup.calls).toBe(2);

    t = 61_000; // cooled down: the primary is tried again
    await p.solve([]);
    expect(primary.calls).toBe(2);
  });

  it("doesn't fail over on the caller's own errors", async () => {
    const p = withFallback(provider('m', 'x', 'bad_request'), provider('b', 'y'), circuitBreaker());
    await expect(p.solve([])).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('reports the primary model when it answers', async () => {
    const p = withFallback(provider('m', 'x'), provider('b', 'y'), circuitBreaker());
    await p.solve([]);
    expect(p.model).toBe('x');
  });
});
