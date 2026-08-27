/**
 * Per-caller rate limiting.
 *
 * History worth keeping: the first implementation counted requests in KV, one
 * read plus one write per request. Cloudflare's KV free plan allows **1,000
 * writes per day**, so that design would have stopped serving after roughly a
 * thousand requests — and on paid plans it would have added a storage write to
 * the latency of every single call. It was a scaling blocker disguised as a
 * twelve-line function.
 *
 * This uses Cloudflare's native Rate Limiting binding instead: it runs in the
 * edge runtime, costs nothing, writes nothing, and is consistent per colo.
 *
 * If the binding is absent (local `wrangler dev` without config, or a fork that
 * has not declared it), we fall back to an in-isolate counter. That fallback is
 * per-isolate rather than global, so it under-counts across colos — it is a
 * safety net that keeps a single client from hammering one instance, not a
 * substitute for the real thing. `limiterKind` reports which one is live so
 * /health can surface it rather than let a silent downgrade look like success.
 */

export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  kind: "binding" | "isolate" | "disabled";
}

/** Fallback state. Bounded so a flood of distinct keys cannot grow it forever. */
const isolateCounters = new Map<string, { count: number; resetAt: number }>();
const MAX_TRACKED_KEYS = 10_000;

function isolateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();

  // Opportunistic sweep; keeps the map from growing without bound.
  if (isolateCounters.size > MAX_TRACKED_KEYS) {
    for (const [k, v] of isolateCounters) {
      if (v.resetAt <= now) isolateCounters.delete(k);
    }
    // Still oversized after sweeping: drop the oldest entries outright.
    if (isolateCounters.size > MAX_TRACKED_KEYS) {
      const excess = isolateCounters.size - MAX_TRACKED_KEYS;
      let i = 0;
      for (const k of isolateCounters.keys()) {
        if (i++ >= excess) break;
        isolateCounters.delete(k);
      }
    }
  }

  const entry = isolateCounters.get(key);
  if (!entry || entry.resetAt <= now) {
    isolateCounters.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0, kind: "isolate" };
  }

  entry.count++;
  if (entry.count > limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      kind: "isolate",
    };
  }
  return { allowed: true, retryAfterSeconds: 0, kind: "isolate" };
}

/**
 * Derive a stable bucket key. Authenticated callers are limited per credential
 * so one user's traffic cannot exhaust another's; anonymous callers fall back
 * to the client IP. The credential is hashed — it is never used verbatim as a
 * key, because keys reach logs and metrics.
 */
export async function rateLimitKey(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") ?? "";
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const material = auth ? `t:${auth}` : `ip:${ip}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function checkRateLimit(
  req: Request,
  binding: RateLimiterBinding | undefined,
  rpm: number,
): Promise<RateLimitResult> {
  if (!Number.isFinite(rpm) || rpm <= 0) {
    return { allowed: true, retryAfterSeconds: 0, kind: "disabled" };
  }

  const key = await rateLimitKey(req);

  if (binding && typeof binding.limit === "function") {
    try {
      const { success } = await binding.limit({ key });
      return {
        allowed: success,
        // The binding uses a fixed 60s period; that is the honest retry hint.
        retryAfterSeconds: success ? 0 : 60,
        kind: "binding",
      };
    } catch {
      // A limiter failure must never take the server down with it. Fall
      // through to the isolate counter rather than rejecting the request.
    }
  }

  return isolateLimit(key, rpm, 60_000);
}

export function limiterKind(binding: RateLimiterBinding | undefined, rpm: number): string {
  if (!Number.isFinite(rpm) || rpm <= 0) return "disabled";
  return binding ? "binding" : "isolate-fallback";
}

/** 429 shaped as a JSON-RPC error the agent can actually act on. */
export function rateLimitResponse(result: RateLimitResult, rpm: number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32603,
        message: `Rate limit exceeded (${rpm} requests/minute). Retry in ${result.retryAfterSeconds}s.`,
        data: { retry_after_seconds: result.retryAfterSeconds, retryable: true },
      },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(result.retryAfterSeconds),
        "cache-control": "no-store",
      },
    },
  );
}
