import { ProviderError, type FetchFn } from './types';

/** "https://x/v1/" → "https://x/v1", so paths can be appended with a single slash. */
export const trimSlash = (url: string) => url.replace(/\/+$/, '');

export interface RetryOptions {
  /** Extra attempts after the first. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_RETRY: RetryOptions = {
  retries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  sleep: abortableSleep,
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

export interface PostJsonOptions {
  fetch: FetchFn;
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  retry?: Partial<RetryOptions>;
}

/** POST JSON with timeout and retry on 429 / 5xx / 529 / network errors. Returns parsed JSON. */
export async function postJson(
  url: string,
  body: unknown,
  opts: PostJsonOptions,
): Promise<unknown> {
  const retry = { ...DEFAULT_RETRY, ...opts.retry };
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await opts.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: payload,
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new ProviderError('aborted', 'request aborted');
      const error = timeout.aborted
        ? new ProviderError('timeout', `request timed out after ${opts.timeoutMs}ms`)
        : new ProviderError('upstream', `network error: ${(err as Error).message}`);
      if (attempt < retry.retries) {
        await retry.sleep(backoff(attempt, retry), opts.signal);
        continue;
      }
      throw error;
    }

    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new ProviderError('invalid_response', 'response body is not JSON', res.status);
      }
    }

    const text = await res.text().catch(() => '');
    if (RETRYABLE_STATUS.has(res.status) && attempt < retry.retries) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      await retry.sleep(
        Math.min(retryAfter ?? backoff(attempt, retry), retry.maxDelayMs),
        opts.signal,
      );
      continue;
    }
    throw new ProviderError(codeForStatus(res.status), describe(res.status, text), res.status);
  }
}

function codeForStatus(status: number) {
  if (status === 401 || status === 403) return 'auth' as const;
  if (status === 400 || status === 404 || status === 413 || status === 422)
    return 'bad_request' as const;
  if (status === 429) return 'rate_limit' as const;
  if (status === 503 || status === 529) return 'overloaded' as const;
  return 'upstream' as const;
}

function describe(status: number, body: string): string {
  const snippet = body.length > 300 ? `${body.slice(0, 300)}…` : body;
  return `HTTP ${status}${snippet ? `: ${snippet}` : ''}`;
}

function backoff(attempt: number, r: RetryOptions): number {
  const exp = Math.min(r.maxDelayMs, r.baseDelayMs * 2 ** attempt);
  return exp / 2 + Math.random() * (exp / 2);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('aborted', 'request aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('aborted', 'request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
