import { errorCode, type CallCtx, type Provider } from './types';

/** Tracks whether the primary service (OpenRouter) is failing, so calls skip it for a while. */
export interface CircuitBreaker {
  isOpen(): boolean;
  trip(): void;
}

/** In-memory breaker: after a failure, the primary is skipped for `cooldownMs`. */
export function circuitBreaker(cooldownMs = 60_000, now = () => Date.now()): CircuitBreaker {
  let until = 0;
  return {
    isOpen: () => now() < until,
    trip: () => {
      until = now() + cooldownMs;
    },
  };
}

/** Service-level failures worth trying the backup for; not the caller's own mistakes. */
const FAILOVER = new Set([
  'upstream',
  'timeout',
  'overloaded',
  'rate_limit',
  'auth',
  'invalid_response',
]);

/**
 * A provider that answers with `primary` and falls back to `backup` when the primary's service
 * fails (outage, timeout, exhausted key). While the breaker is open the primary is skipped.
 * `model` reports whichever answered last, so usage logs name the model that actually ran.
 * read/mark fall back only if the backup can do them (a text-only backup can't read images).
 */
export function withFallback(
  primary: Provider,
  backup: Provider,
  breaker: CircuitBreaker,
): Provider {
  const wrapped: Provider = {
    id: primary.id,
    model: primary.model,
    capabilities: primary.capabilities,
    solve: (qs, ctx) => run((p) => p.solve(qs, ctx), true, ctx),
  };
  async function run<T>(
    call: (p: Provider) => Promise<T>,
    backupCan: boolean,
    ctx?: CallCtx,
  ): Promise<T> {
    if (!breaker.isOpen() || !backupCan) {
      try {
        wrapped.model = primary.model;
        return await call(primary);
      } catch (err) {
        if (ctx?.signal?.aborted || !FAILOVER.has(errorCode(err)) || !backupCan) throw err;
        breaker.trip();
      }
    }
    wrapped.model = backup.model;
    return call(backup);
  }
  if (primary.read) wrapped.read = (req, ctx) => run((p) => p.read!(req, ctx), !!backup.read, ctx);
  if (primary.mark) wrapped.mark = (req, ctx) => run((p) => p.mark!(req, ctx), !!backup.mark, ctx);
  return wrapped;
}
