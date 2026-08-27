/** Unit tests for the pure logic: crypto, era detection, limits, catalog. */
import { describe, expect, it } from "vitest";
import {
  b64urlDecode,
  b64urlEncode,
  constantTimeEqual,
  sha256B64Url,
  hmacSign,
  hmacVerify,
  escapeHtml,
} from "../../src/util/encoding.js";
import {
  assertAllowedHost,
  directAuth,
  hasScope,
  mintToken,
  subjectFor,
  verifyToken,
  TokenError,
  type AuthContext,
} from "../../src/auth/token.js";
import {
  clampLimit,
  decimate,
  enforceResultBudget,
  signHandle,
  summarize,
  verifyHandle,
  MAX_RESULT_BYTES,
} from "../../src/limits/budget.js";
import { eraFor, isSupportedVersion, resolveVersion, adaptResult, methodAvailable } from "../../src/protocol/era.js";
import { parseNominalUri, parseRid, buildNominalUri, isRid } from "../../src/nominal/rid.js";
import { OPERATIONS, OPERATIONS_BY_ID, CATALOG_STATS } from "../../src/tools/catalog.js";
import { resourceMatches } from "../../src/auth/oauth.js";

const SECRET = "unit-test-secret-000000000000000000";
const AUD = "https://x.test/mcp";

describe("encoding", () => {
  it("round-trips base64url including edge lengths", () => {
    for (const n of [0, 1, 2, 3, 16, 31, 32, 100, 5000]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 7) % 256);
      expect([...b64urlDecode(b64urlEncode(bytes))]).toEqual([...bytes]);
    }
  });

  it("produces url-safe output with no padding", () => {
    const s = b64urlEncode(new Uint8Array([251, 255, 254, 253]));
    expect(s).not.toMatch(/[+/=]/);
  });

  it("rejects non-base64url input", () => {
    expect(() => b64urlDecode("abc!def")).toThrow();
  });

  it("compares equal and unequal strings correctly", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("computes a stable PKCE S256 challenge", async () => {
    // RFC 7636 Appendix B test vector.
    expect(await sha256B64Url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("signs and verifies HMACs, rejecting tampering", async () => {
    const sig = await hmacSign(SECRET, "payload");
    expect(await hmacVerify(SECRET, "payload", sig)).toBe(true);
    expect(await hmacVerify(SECRET, "payload2", sig)).toBe(false);
    expect(await hmacVerify("other", "payload", sig)).toBe(false);
  });

  it("escapes HTML metacharacters", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;",
    );
  });
});

describe("token envelope", () => {
  const base = {
    sub: "s",
    key: "nominal-key",
    base: "https://api.gov.nominal.io/api",
    scopes: ["nominal:read"] as const,
    aud: AUD,
  };

  it("round-trips and recovers the credential", async () => {
    const t = await mintToken({ ...base, scopes: [...base.scopes], exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const ctx = await verifyToken(t, SECRET, AUD);
    expect(ctx.credential).toBe("nominal-key");
    expect(ctx.mode).toBe("oauth");
  });

  it("does not leak the key into the token text", async () => {
    const t = await mintToken({ ...base, scopes: [...base.scopes], exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    expect(t).not.toContain("nominal-key");
  });

  it("rejects expiry, audience, secret, and format failures", async () => {
    const exp = Math.floor(Date.now() / 1000);
    await expect(verifyToken(await mintToken({ ...base, scopes: [...base.scopes], exp: exp - 1 }, SECRET), SECRET, AUD)).rejects.toThrow(TokenError);
    const good = await mintToken({ ...base, scopes: [...base.scopes], exp: exp + 60 }, SECRET);
    await expect(verifyToken(good, SECRET, "https://other.test/mcp")).rejects.toThrow(/audience/);
    await expect(verifyToken(good, "wrong-secret", AUD)).rejects.toThrow(/authentication failed/);
    await expect(verifyToken("not-a-token", SECRET, AUD)).rejects.toThrow(/not an MCP access token/);
    await expect(verifyToken("nmcp_!!!", SECRET, AUD)).rejects.toThrow(/base64url/);
    await expect(verifyToken("nmcp_AAAA", SECRET, AUD)).rejects.toThrow(/truncated/);
  });

  it("derives a stable subject from the key", async () => {
    expect(await subjectFor("k")).toBe(await subjectFor("k"));
    expect(await subjectFor("k")).not.toBe(await subjectFor("k2"));
    expect((await subjectFor("k")).length).toBe(32);
  });

  it("implies narrower scopes from broader ones", () => {
    const ctx = (scopes: string[]) => ({ scopes } as AuthContext);
    expect(hasScope(ctx(["nominal:admin"]), "nominal:read")).toBe(true);
    expect(hasScope(ctx(["nominal:write"]), "nominal:read")).toBe(true);
    expect(hasScope(ctx(["nominal:read"]), "nominal:write")).toBe(false);
    expect(hasScope(ctx([]), "nominal:read")).toBe(false);
  });
});

describe("host allowlist (SSRF)", () => {
  it("accepts known Nominal hosts", () => {
    for (const h of [
      "https://api.gov.nominal.io/api",
      "https://api.nominal.io/api",
      "https://tenant.nominal.io/api",
    ]) {
      expect(() => assertAllowedHost(h)).not.toThrow();
    }
  });

  it("rejects other hosts, http, and lookalikes", () => {
    for (const h of [
      "https://evil.example/api",
      "http://api.gov.nominal.io/api",
      "https://nominal.io.evil.com/api",
      "https://localhost/api",
      "https://127.0.0.1/api",
      "not-a-url",
      "https://api.gov.nominal.io.evil.io/api",
    ]) {
      expect(() => assertAllowedHost(h), h).toThrow(TokenError);
    }
  });

  it("refuses to build a direct auth context for a bad host", async () => {
    await expect(directAuth("k", "https://evil.example")).rejects.toThrow();
  });
});

describe("era detection", () => {
  it("classifies versions", () => {
    expect(eraFor("2026-07-28")).toBe("modern");
    expect(eraFor("2025-11-25")).toBe("legacy");
    expect(isSupportedVersion("2026-07-28")).toBe(true);
    expect(isSupportedVersion("2030-01-01")).toBe(false);
  });

  it("prefers _meta, then initialize params, then header, then default", () => {
    expect(
      resolveVersion("2025-06-18", {
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
      }).version,
    ).toBe("2026-07-28");
    expect(
      resolveVersion(null, { method: "initialize", params: { protocolVersion: "2025-11-25" } }).version,
    ).toBe("2025-11-25");
    expect(resolveVersion("2025-06-18", { params: {} }).version).toBe("2025-06-18");
    expect(resolveVersion(null, { params: {} })).toEqual({ version: "2025-03-26", source: "default" });
  });

  it("gates era-specific methods", () => {
    expect(methodAvailable("server/discover", "modern")).toBe(true);
    expect(methodAvailable("server/discover", "legacy")).toBe(false);
    expect(methodAvailable("initialize", "modern")).toBe(false);
    expect(methodAvailable("ping", "legacy")).toBe(true);
    expect(methodAvailable("tools/list", "modern")).toBe(true);
  });

  it("adds resultType and cache hints for modern, strips them for legacy", () => {
    const modern = adaptResult({ tools: [] }, "modern", "tools/list");
    expect(modern["resultType"]).toBe("complete");
    expect(typeof modern["ttlMs"]).toBe("number");

    const legacy = adaptResult({ tools: [], resultType: "complete", ttlMs: 1, cacheScope: "public" }, "legacy", "tools/list");
    expect(legacy["resultType"]).toBeUndefined();
    expect(legacy["ttlMs"]).toBeUndefined();
  });

  it("repairs an invalid ttlMs rather than emitting it", () => {
    const r = adaptResult({ tools: [], ttlMs: -5 }, "modern", "tools/list");
    expect(r["ttlMs"]).toBe(0);
  });
});

describe("limits", () => {
  it("clamps limits and explains why", () => {
    expect(clampLimit(undefined, 500, 25).value).toBe(25);
    expect(clampLimit(10, 500).value).toBe(10);
    const over = clampLimit(5000, 500);
    expect(over.value).toBe(500);
    expect(over.notice).toContain("500");
    expect(clampLimit(-3, 500).value).toBe(1);
    expect(clampLimit("abc", 500, 25).value).toBe(25);
    expect(clampLimit(7.9, 500).value).toBe(7);
    // Infinity is not a usable bound; fall back rather than clamp.
    expect(clampLimit(Infinity, 500, 25).value).toBe(25);
    expect(clampLimit(NaN, 500, 25).value).toBe(25);
  });

  it("summarizes a series, handling nulls and empties", () => {
    const s = summarize([
      { t: "a", v: 1 },
      { t: "b", v: 3 },
      { t: "c", v: null },
      { t: "d", v: 5 },
    ]);
    expect(s.count).toBe(4);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.mean).toBe(3);
    expect(s.nulls).toBe(1);
    expect(summarize([]).min).toBeNull();
  });

  it("decimates to at most the requested buckets and keeps extremes", () => {
    const pts = Array.from({ length: 10_000 }, (_, i) => ({ t: String(i), v: i === 5000 ? 9999 : 1 }));
    const d = decimate(pts, 200);
    expect(d.length).toBeLessThanOrEqual(200);
    expect(Math.max(...d.map((b) => b.max ?? 0))).toBe(9999);
  });

  it("passes through series shorter than the bucket count", () => {
    expect(decimate([{ t: "a", v: 1 }], 200).length).toBe(1);
    expect(decimate([], 200)).toEqual([]);
  });

  it("truncates oversized arrays into valid JSON", () => {
    const big = Array.from({ length: 50_000 }, (_, i) => ({ i, pad: "x".repeat(50) }));
    const r = enforceResultBudget(big);
    expect(r.truncated).toBe(true);
    const serialized = JSON.stringify(r.value);
    expect(serialized.length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect((r.value as any).total).toBe(50_000);
  });

  it("truncates oversized objects with a preview", () => {
    const r = enforceResultBudget({ blob: "x".repeat(200_000) });
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r.value).length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it("leaves small results untouched", () => {
    const v = { a: 1 };
    const r = enforceResultBudget(v);
    expect(r.truncated).toBe(false);
    expect(r.value).toBe(v);
  });
});

describe("handles", () => {
  const payload = { kind: "channel_query", subject: "u1", query: { a: 1 }, exp: Math.floor(Date.now() / 1000) + 60 };

  it("round-trips for the issuing user", async () => {
    const h = await signHandle(payload, SECRET);
    expect((await verifyHandle(h, SECRET, "u1")).kind).toBe("channel_query");
  });

  it("rejects another user's handle", async () => {
    const h = await signHandle(payload, SECRET);
    await expect(verifyHandle(h, SECRET, "u2")).rejects.toThrow(/different user/);
  });

  it("rejects tampering, wrong secrets, expiry, and malformed input", async () => {
    const h = await signHandle(payload, SECRET);
    const [p, body, sig] = h.split(".");
    await expect(verifyHandle(`${p}.${body}X.${sig}`, SECRET, "u1")).rejects.toThrow();
    await expect(verifyHandle(h, "other-secret", "u1")).rejects.toThrow(/signature/);
    await expect(verifyHandle("garbage", SECRET, "u1")).rejects.toThrow(/malformed/);
    const expired = await signHandle({ ...payload, exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
    await expect(verifyHandle(expired, SECRET, "u1")).rejects.toThrow(/expired/);
  });
});

describe("RIDs and URIs", () => {
  it("parses a Nominal RID", () => {
    const p = parseRid("ri.scout.gov-staging.run.f0b1c2d3-1111-2222-3333-444455556666");
    expect(p?.type).toBe("run");
    expect(p?.kind).toBe("run");
    expect(isRid("not a rid")).toBe(false);
  });

  it("parses nominal:// URIs and bare RIDs", () => {
    expect(parseNominalUri("nominal://run/ri.scout.gov.run.abc")).toEqual({ kind: "run", id: "ri.scout.gov.run.abc" });
    expect(parseNominalUri("ri.scout.gov.asset.abc")?.kind).toBe("asset");
    expect(parseNominalUri("nominal://channel/ds1/chamber_psi")).toEqual({
      kind: "channel",
      id: "ds1",
      channel: "chamber_psi",
    });
  });

  it("rejects unknown kinds and malformed URIs", () => {
    expect(parseNominalUri("nominal://bogus/x")).toBeNull();
    expect(parseNominalUri("nominal://run")).toBeNull();
    expect(parseNominalUri("https://evil.example")).toBeNull();
    expect(parseNominalUri("")).toBeNull();
  });

  it("round-trips URIs with characters needing encoding", () => {
    const uri = buildNominalUri("channel", "ds/1", "a b/c");
    const p = parseNominalUri(uri);
    expect(p?.channel).toBe("a b/c");
  });
});

describe("operation catalog", () => {
  it("contains every extracted operation", () => {
    expect(OPERATIONS.length).toBe(467);
    expect(CATALOG_STATS.total).toBe(467);
  });

  it("classifies internal operations and never leaves them callable", () => {
    expect(CATALOG_STATS.byPolicy["internal"]).toBeGreaterThan(0);
    const internal = OPERATIONS.filter((o) => o.policy === "internal");
    for (const o of internal) {
      expect(/internal|api-key|sandbox-token|secrets\/internal|authorization/i.test(o.id + o.path)).toBe(true);
    }
  });

  it("classifies every creating/deleting operation as mutating", () => {
    const creates = OPERATIONS.filter(
      (o) => /^(batch_)?(create|delete|archive|update)_/.test(o.op) && o.policy !== "internal",
    );
    expect(creates.length).toBeGreaterThan(50);
    for (const o of creates) expect(o.policy, o.id).toBe("mutating");
  });

  it("leaves no state-changing verb classified read-only", () => {
    // Regression: batch_cancel_ingest_jobs was read-only because the verb
    // regex was anchored and did not see past the batch_ prefix.
    const leaked = OPERATIONS.filter(
      (o) =>
        o.policy === "read" &&
        /^(batch_|bulk_)?(create|update|delete|archive|unarchive|cancel|revoke|kill|write|ingest|upload|ensure)/.test(o.op),
    );
    expect(leaked.map((o) => o.id)).toEqual([]);
  });

  it("only gates a GET as mutating when its name implies a state change", () => {
    // Nominal has GETs whose names imply creation (an OAuth redirect handler).
    // Requiring write scope for those is the safe direction to be wrong in.
    const gatedGets = OPERATIONS.filter((o) => o.method === "GET" && o.policy === "mutating");
    for (const o of gatedGets) {
      expect(/^(create|update|delete|archive|generate|rotate|set)/.test(o.op), o.id).toBe(true);
    }
    // ...and it stays a small, reviewable set.
    expect(gatedGets.length).toBeLessThan(10);
  });

  it("has a unique, well-formed id and path for every operation", () => {
    expect(new Set(OPERATIONS.map((o) => o.id)).size).toBe(OPERATIONS.length);
    for (const o of OPERATIONS) {
      expect(o.path.startsWith("/")).toBe(true);
      expect(o.path).not.toContain("..");
      expect(OPERATIONS_BY_ID.get(o.id)).toBe(o);
    }
  });

  it("declares every path-template placeholder as a path param", () => {
    for (const o of OPERATIONS) {
      const placeholders = [...o.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      expect(new Set(placeholders)).toEqual(new Set(o.pathParams));
    }
  });
});

describe("RFC 8707 resource matching", () => {
  it("ignores case and trailing slashes but nothing else", () => {
    expect(resourceMatches("https://x.test/mcp", "https://x.test/mcp")).toBe(true);
    expect(resourceMatches("https://X.TEST/mcp", "https://x.test/mcp")).toBe(true);
    expect(resourceMatches("https://x.test/mcp/", "https://x.test/mcp")).toBe(true);
    expect(resourceMatches("https://x.test/other", "https://x.test/mcp")).toBe(false);
    expect(resourceMatches("https://evil.test/mcp", "https://x.test/mcp")).toBe(false);
    expect(resourceMatches("http://x.test/mcp", "https://x.test/mcp")).toBe(false);
  });
});
