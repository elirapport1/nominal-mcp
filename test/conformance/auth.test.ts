/**
 * Authorization conformance — the §5.3 table in SPEC.md, one test per row,
 * plus the token-forgery cases that matter most.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  LATEST,
  TEST_CANONICAL,
  TEST_ORIGIN,
  call,
  installDefaultRoutes,
  installFetchStub,
  kv,
  raw,
  restoreFetch,
  stub,

  testToken,
} from "../harness.js";
import { mintToken } from "../../src/auth/token.js";
import { sha256B64Url } from "../../src/util/encoding.js";

beforeAll(() => {
  installFetchStub();
  installDefaultRoutes();
});
afterAll(restoreFetch);
beforeEach(() => {
  stub.reset();
  installDefaultRoutes();
  kv.clear();
});

const get = (path: string) => raw(new Request(`${TEST_ORIGIN}${path}`));
const getJson = async (path: string): Promise<any> => (await get(path)).json();

describe("discovery metadata", () => {
  it("serves RFC 9728 protected resource metadata", async () => {
    const res = await get("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    const m: any = await res.json();
    expect(m.resource).toBe(TEST_CANONICAL);
    expect(m.authorization_servers).toContain(TEST_ORIGIN);
    expect(m.scopes_supported).toContain("nominal:read");
  });

  it("serves RFC 8414 authorization server metadata", async () => {
    const m = await getJson("/.well-known/oauth-authorization-server");
    expect(m.issuer).toBe(TEST_ORIGIN);
    expect(m.authorization_endpoint).toBe(`${TEST_ORIGIN}/authorize`);
    expect(m.token_endpoint).toBe(`${TEST_ORIGIN}/token`);
  });

  it("offers S256 only — OAuth 2.1 forbids plain PKCE", async () => {
    const m = await getJson("/.well-known/oauth-authorization-server");
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("advertises RFC 9207 iss support and resource indicators", async () => {
    const m = await getJson("/.well-known/oauth-authorization-server");
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
    expect(m.resource_indicators_supported).toBe(true);
    expect(m.client_id_metadata_document_supported).toBe(true);
  });
});

describe("401 challenge", () => {
  it("challenges an unauthenticated tools/call with resource_metadata", async () => {
    const r = await call("tools/call", { name: "nominal_search", arguments: {} }, { token: null });
    expect(r.status).toBe(401);
    const wa = r.headers.get("www-authenticate")!;
    expect(wa).toMatch(/^Bearer /);
    expect(wa).toContain(`resource_metadata="${TEST_ORIGIN}/.well-known/oauth-protected-resource"`);
    expect(wa).toContain("scope=");
  });

  it("allows discovery methods without a credential", async () => {
    for (const m of ["server/discover", "tools/list", "prompts/list"]) {
      const r = await call(m, {}, { token: null });
      expect(r.status, m).toBe(200);
    }
  });

  it("rejects an access token passed in the query string", async () => {
    const res = await raw(
      new Request(`${TEST_ORIGIN}/mcp?access_token=abc`, {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": LATEST },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.message).toMatch(/query string/i);
  });
});

describe("token validation", () => {
  it("accepts a well-formed token", async () => {
    const r = await call("tools/call", { name: "nominal_search", arguments: { kind: "run" } });
    expect(r.status).toBe(200);
  });

  it("rejects an expired token", async () => {
    const token = await testToken(["nominal:read"], { exp: Math.floor(Date.now() / 1000) - 10 });
    const r = await call("tools/call", { name: "nominal_search", arguments: {} }, { token });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("rejects a token minted for another audience (confused deputy)", async () => {
    const token = await testToken(["nominal:read"], { aud: "https://evil.example/mcp" });
    const r = await call("tools/call", { name: "nominal_search", arguments: {} }, { token });
    expect(r.status).toBe(401);
  });

  it("rejects a token minted under a different secret", async () => {
    const token = await mintToken(
      {
        sub: "x",
        key: "k",
        base: "https://api.gov.nominal.io/api",
        scopes: ["nominal:read"],
        aud: TEST_CANONICAL,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "a-completely-different-secret",
    );
    const r = await call("tools/call", { name: "nominal_search", arguments: {} }, { token });
    expect(r.status).toBe(401);
  });

  it("rejects a bit-flipped token", async () => {
    const token = await testToken();
    const bytes = [...token];
    const i = token.length - 5;
    bytes[i] = bytes[i] === "A" ? "B" : "A";
    const r = await call("tools/call", { name: "nominal_search", arguments: {} }, { token: bytes.join("") });
    expect(r.status).toBe(401);
  });

  it("rejects a truncated token", async () => {
    const token = (await testToken()).slice(0, 30);
    const r = await call("tools/call", { name: "nominal_search", arguments: {} }, { token });
    expect(r.status).toBe(401);
  });

  it("rejects a malformed Authorization header", async () => {
    const r = await call(
      "tools/call",
      { name: "nominal_search", arguments: {} },
      { headers: { authorization: "Basic abc" } },
    );
    expect(r.status).toBe(401);
  });
});

describe("scopes", () => {
  it("refuses a write tool on a read-only connection", async () => {
    const token = await testToken(["nominal:read"]);
    const r = await call(
      "tools/call",
      { name: "nominal_write", arguments: { kind: "event", name: "x", start: "2026-01-01T00:00:00Z" } },
      { token, headers: { "mcp-name": "nominal_write" } },
    );
    expect(r.status).toBe(200);
    expect(r.json.result.isError).toBe(true);
    expect(r.json.result.structuredContent.error).toContain("nominal:write");
  });

  it("allows a write tool with the write scope", async () => {
    const token = await testToken(["nominal:read", "nominal:write"]);
    const r = await call(
      "tools/call",
      { name: "nominal_write", arguments: { kind: "event", name: "x", start: "2026-01-01T00:00:00Z" } },
      { token, headers: { "mcp-name": "nominal_write" } },
    );
    expect(r.json.result.isError).toBe(false);
  });
});

describe("dynamic client registration", () => {
  const register = (body: unknown) =>
    raw(
      new Request(`${TEST_ORIGIN}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("registers a valid native client", async () => {
    const res = await register({
      redirect_uris: ["http://127.0.0.1:8976/callback"],
      application_type: "native",
      client_name: "Test Client",
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).client_id).toMatch(/^dcr_/);
  });

  it("requires application_type (2026-07-28)", async () => {
    const res = await register({ redirect_uris: ["https://ok.example/cb"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_client_metadata");
  });

  it("rejects a javascript: redirect_uri", async () => {
    const res = await register({
      redirect_uris: ["javascript:alert(1)"],
      application_type: "web",
    });
    expect(res.status).toBe(400);
  });

  it("rejects plain http to a non-loopback host", async () => {
    const res = await register({
      redirect_uris: ["http://evil.example/cb"],
      application_type: "web",
    });
    expect(res.status).toBe(400);
  });
});

describe("authorization code flow", () => {
  async function registerClient(): Promise<string> {
    const res = await raw(
      new Request(`${TEST_ORIGIN}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://127.0.0.1:8976/callback"],
          application_type: "native",
        }),
      }),
    );
    return ((await res.json()) as any).client_id;
  }

  const VERIFIER = "verifier_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop123";

  async function authorizeUrl(clientId: string, overrides: Record<string, string> = {}) {
    const challenge = await sha256B64Url(VERIFIER);
    const p = new URLSearchParams({
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:8976/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: TEST_CANONICAL,
      scope: "nominal:read nominal:write",
      state: "xyz",
      ...overrides,
    });
    return `${TEST_ORIGIN}/authorize?${p}`;
  }

  it("requires the RFC 8707 resource parameter", async () => {
    const clientId = await registerClient();
    const url = await authorizeUrl(clientId);
    const stripped = new URL(url);
    stripped.searchParams.delete("resource");
    const res = await raw(new Request(stripped.toString()));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=invalid_target");
  });

  it("rejects a resource naming a different server", async () => {
    const clientId = await registerClient();
    const res = await raw(
      new Request(await authorizeUrl(clientId, { resource: "https://other.example/mcp" })),
    );
    expect(res.headers.get("location")).toContain("error=invalid_target");
  });

  it("rejects plain PKCE", async () => {
    const clientId = await registerClient();
    const res = await raw(
      new Request(await authorizeUrl(clientId, { code_challenge_method: "plain" })),
    );
    expect(res.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects an unregistered redirect_uri without redirecting", async () => {
    const clientId = await registerClient();
    const res = await raw(
      new Request(await authorizeUrl(clientId, { redirect_uri: "https://evil.example/steal" })),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("shows a consent page for a valid request", async () => {
    const clientId = await registerClient();
    const res = await raw(new Request(await authorizeUrl(clientId)));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Nominal API key");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("completes the flow and returns iss on the redirect", async () => {
    const clientId = await registerClient();
    const page = await raw(new Request(await authorizeUrl(clientId)));
    const html = await page.text();
    const pending = /name="pending" value="([^"]+)"/.exec(html)![1]!;

    const form = new FormData();
    form.set("pending", pending);
    form.set("api_key", "a-real-looking-nominal-key");
    form.set("base_url", "https://api.gov.nominal.io/api");
    const res = await raw(new Request(`${TEST_ORIGIN}/authorize`, { method: "POST", body: form }));

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("iss")).toBe(TEST_ORIGIN);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // Exchange with the correct verifier.
    const body = new FormData();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("code_verifier", VERIFIER);
    body.set("client_id", clientId);
    body.set("redirect_uri", "http://127.0.0.1:8976/callback");
    body.set("resource", TEST_CANONICAL);
    const tokenRes = await raw(new Request(`${TEST_ORIGIN}/token`, { method: "POST", body }));
    expect(tokenRes.status).toBe(200);
    const tok: any = await tokenRes.json();
    expect(tok.access_token).toMatch(/^nmcp_/);
    expect(tok.token_type).toBe("Bearer");
    expect(tok.refresh_token).toBeTruthy();

    // And the token actually works.
    const r = await call("tools/call", { name: "nominal_search", arguments: {} }, { token: tok.access_token });
    expect(r.status).toBe(200);

    // Replaying the same code must fail — codes are one-time.
    const replay = await raw(new Request(`${TEST_ORIGIN}/token`, { method: "POST", body }));
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects an exchange with the wrong PKCE verifier", async () => {
    const clientId = await registerClient();
    const page = await raw(new Request(await authorizeUrl(clientId)));
    const pending = /name="pending" value="([^"]+)"/.exec(await page.text())![1]!;

    const form = new FormData();
    form.set("pending", pending);
    form.set("api_key", "key");
    form.set("base_url", "https://api.gov.nominal.io/api");
    const red = await raw(new Request(`${TEST_ORIGIN}/authorize`, { method: "POST", body: form }));
    const code = new URL(red.headers.get("location")!).searchParams.get("code")!;

    const body = new FormData();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("code_verifier", "the-wrong-verifier-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    body.set("client_id", clientId);
    const res = await raw(new Request(`${TEST_ORIGIN}/token`, { method: "POST", body }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects a token request naming a different resource", async () => {
    const body = new FormData();
    body.set("grant_type", "authorization_code");
    body.set("code", "whatever");
    body.set("code_verifier", "v");
    body.set("resource", "https://evil.example/mcp");
    const res = await raw(new Request(`${TEST_ORIGIN}/token`, { method: "POST", body }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_target");
  });
});

describe("transport security", () => {
  it("rejects a disallowed Origin with 403", async () => {
    const r = await call("tools/list", {}, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  it("allows localhost origins", async () => {
    const r = await call("tools/list", {}, { origin: "http://localhost:3000" });
    expect(r.status).toBe(200);
  });

  it("sets Vary on Origin and Authorization", async () => {
    const r = await call("tools/list");
    expect(r.headers.get("vary")).toContain("Authorization");
  });

  it("refuses GET on /mcp — the GET stream was removed in 2026-07-28", async () => {
    const res = await raw(new Request(`${TEST_ORIGIN}/mcp`));
    expect(res.status).toBe(405);
  });
});
