import { describe, expect, it } from 'vitest';
import { postJson } from '../http';
import { fakeFetch, json } from './helpers';

const opts = (fetch: ReturnType<typeof fakeFetch>, sleeps: number[] = []) => ({
  fetch,
  headers: {},
  timeoutMs: 5_000,
  retry: { retries: 2, sleep: async (ms: number) => void sleeps.push(ms) },
});

describe('postJson', () => {
  it('retries 429 and 529, honouring Retry-After', async () => {
    const sleeps: number[] = [];
    const fetch = fakeFetch(
      json({}, 429, { 'Retry-After': '2' }),
      json({}, 529),
      json({ ok: true }),
    );
    await expect(postJson('https://x.test', {}, opts(fetch, sleeps))).resolves.toEqual({
      ok: true,
    });
    expect(fetch.calls).toHaveLength(3);
    expect(sleeps[0]).toBe(2000);
  });

  it('gives up after the retry budget', async () => {
    const fetch = fakeFetch(json({}, 503));
    await expect(postJson('https://x.test', {}, opts(fetch))).rejects.toMatchObject({
      code: 'overloaded',
    });
    expect(fetch.calls).toHaveLength(3);
  });

  it('does not retry client errors', async () => {
    const fetch = fakeFetch(json({ error: 'bad' }, 422));
    await expect(postJson('https://x.test', {}, opts(fetch))).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(fetch.calls).toHaveLength(1);
  });

  it('retries network errors', async () => {
    const fetch = fakeFetch(new TypeError('fetch failed'), json({ ok: 1 }));
    await expect(postJson('https://x.test', {}, opts(fetch))).resolves.toEqual({ ok: 1 });
  });

  it('reports caller aborts as aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetch = fakeFetch(new DOMException('aborted', 'AbortError'));
    await expect(
      postJson('https://x.test', {}, { ...opts(fetch), signal: ctrl.signal }),
    ).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('sends JSON with the given headers', async () => {
    const fetch = fakeFetch(json({ ok: true }));
    await postJson(
      'https://x.test/p',
      { a: 1 },
      { ...opts(fetch), headers: { Authorization: 'Bearer k' } },
    );
    expect(fetch.calls[0]).toMatchObject({
      url: 'https://x.test/p',
      headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
      body: { a: 1 },
    });
  });

  it('reports timeouts as timeout', async () => {
    const fetch: typeof globalThis.fetch = (_u, init) =>
      new Promise((_, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
      );
    await expect(
      postJson('https://x.test', {}, { fetch, headers: {}, timeoutMs: 20, retry: { retries: 0 } }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});
