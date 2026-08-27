/** Rate limiter: binding path, isolate fallback, and key derivation. */
import { describe, expect, it } from "vitest";
import {
  checkRateLimit,
  limiterKind,
  rateLimitKey,
  rateLimitResponse,
  type RateLimiterBinding,
} from "../../src/limits/ratelimit.js";

const req = (headers: Record<string, string> = {}) =>
  new Request("https://x.test/mcp", { method: "POST", headers });

describe("rate limiter", () => {
  it("uses the native binding when present and writes no storage", async () => {
    const calls: string[] = [];
    const binding: RateLimiterBinding = {
      async limit({ key }) {
        calls.push(key);
        return { success: true };
      },
    };
    const r = await checkRateLimit(req(), binding, 120);
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe("binding");
    expect(calls.length).toBe(1);
  });

  it("reports a rejection from the binding with a retry hint", async () => {
    const binding: RateLimiterBinding = { async limit() { return { success: false }; } };
    const r = await checkRateLimit(req(), binding, 120);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("falls back to an isolate counter when the binding is absent", async () => {
    const headers = { authorization: "Bearer fallback-test-token" };
    let last = await checkRateLimit(req(headers), undefined, 5);
    expect(last.kind).toBe("isolate");
    for (let i = 0; i < 5; i++) last = await checkRateLimit(req(headers), undefined, 5);
    expect(last.allowed).toBe(false);
    expect(last.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("never lets a limiter failure reject the request", async () => {
    const broken: RateLimiterBinding = { async limit() { throw new Error("limiter down"); } };
    const r = await checkRateLimit(req({ authorization: "Bearer resilience" }), broken, 120);
    expect(r.allowed).toBe(true);
    expect(r.kind).toBe("isolate");
  });

  it("treats a non-positive rpm as disabled", async () => {
    expect((await checkRateLimit(req(), undefined, 0)).kind).toBe("disabled");
    expect((await checkRateLimit(req(), undefined, NaN)).allowed).toBe(true);
  });

  it("buckets per credential, not globally", async () => {
    const a = await rateLimitKey(req({ authorization: "Bearer aaa" }));
    const b = await rateLimitKey(req({ authorization: "Bearer bbb" }));
    expect(a).not.toBe(b);
    expect(await rateLimitKey(req({ authorization: "Bearer aaa" }))).toBe(a);
  });

  it("never uses the raw credential as the key", async () => {
    const key = await rateLimitKey(req({ authorization: "Bearer super-secret-value" }));
    expect(key).not.toContain("super-secret");
    expect(key).toMatch(/^[0-9a-f]{24}$/);
  });

  it("falls back to client IP when unauthenticated", async () => {
    const a = await rateLimitKey(req({ "cf-connecting-ip": "1.2.3.4" }));
    const b = await rateLimitKey(req({ "cf-connecting-ip": "5.6.7.8" }));
    expect(a).not.toBe(b);
  });

  it("returns 429 as a retryable JSON-RPC error", async () => {
    const res = rateLimitResponse({ allowed: false, retryAfterSeconds: 42, kind: "binding" }, 120);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    const body: any = await res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.data.retryable).toBe(true);
    expect(body.error.data.retry_after_seconds).toBe(42);
  });

  it("reports which limiter is live so a downgrade is visible", () => {
    expect(limiterKind({ async limit() { return { success: true }; } }, 120)).toBe("binding");
    expect(limiterKind(undefined, 120)).toBe("isolate-fallback");
    expect(limiterKind(undefined, 0)).toBe("disabled");
  });
});
