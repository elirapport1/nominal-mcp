/**
 * Bounded parallelism.
 *
 * Cloudflare Workers cap simultaneous outbound connections at 6 per
 * invocation. `nominal_query_channels` accepts up to 10 channels and was
 * firing all of them at once, which pushes past the cap: the excess queues
 * inside the runtime, so it still completes, but the fan-out stops being
 * parallel exactly when it matters and the behaviour becomes opaque.
 *
 * Bounding it explicitly at 4 keeps us clear of the cap with headroom for the
 * run-metadata lookup that precedes the fan-out, and makes the concurrency a
 * stated property rather than an emergent one.
 */

/** Safely under the Workers connection cap, with room for a preceding call. */
export const MAX_OUTBOUND_CONCURRENCY = 4;

export type Settled<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

/**
 * Like `Promise.allSettled(items.map(fn))` but never runs more than `limit` at
 * once. Results stay in input order regardless of completion order, because
 * callers pair them positionally with the inputs.
 */
export async function mapSettled<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = MAX_OUTBOUND_CONCURRENCY,
): Promise<Array<Settled<R>>> {
  const results = new Array<Settled<R>>(items.length);
  if (items.length === 0) return results;

  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/**
 * Retry a transient failure once, with jitter.
 *
 * Deliberately narrow: only failures the caller could not have prevented and
 * that a retry could plausibly fix — 429, 502, 503, 504, and network errors.
 * A 4xx is the agent's problem to fix and retrying it just burns time; a
 * mutating call is never retried, because a write that appeared to fail may
 * well have landed.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retryable: (e: unknown) => boolean;
    attempts?: number;
    baseDelayMs?: number;
    /** Deterministic jitter source, for tests. */
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const attempts = opts.attempts ?? 2;
  const base = opts.baseDelayMs ?? 250;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const isLast = attempt === attempts - 1;
      if (isLast || !opts.retryable(e)) throw e;
      // Full jitter: avoids a thundering herd when many agents retry together.
      await sleep(Math.round(base * 2 ** attempt * random()));
    }
  }
  throw lastError;
}
