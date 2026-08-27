/**
 * In-process test harness: runs the Worker's fetch handler against an
 * in-memory KV and a stubbed Nominal API, so the conformance and fuzz suites
 * exercise the real routing, auth, and dispatch code with no network.
 */
import worker from "../src/index.js";
import { mintToken, type Scope } from "../src/auth/token.js";
import type { Env } from "../src/env.js";

export const TEST_ORIGIN = "https://nominal-mcp.test";
export const TEST_CANONICAL = `${TEST_ORIGIN}/mcp`;
export const TEST_BASE = "https://api.gov.nominal.io/api";
export const LATEST = "2026-07-28";

export class MemoryKV {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<{ keys: { name: string }[] }> {
    return { keys: [...this.store.keys()].map((name) => ({ name })) };
  }

  clear(): void {
    this.store.clear();
  }
}

export interface StubCall {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

/** Records outbound calls and replays canned Nominal responses. */
export class NominalStub {
  calls: StubCall[] = [];
  routes = new Map<string, (body: unknown) => { status?: number; body: unknown }>();
  /** Set to fail every call with this status. */
  failWith: number | null = null;

  reset(): void {
    this.calls = [];
    this.failWith = null;
  }

  on(pathSuffix: string, fn: (body: unknown) => { status?: number; body: unknown }): void {
    this.routes.set(pathSuffix, fn);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers = new Headers(init?.headers as HeadersInit);
    this.calls.push({ method, url, body, authorization: headers.get("authorization") });

    if (this.failWith) {
      return new Response(JSON.stringify({ errorName: "Stub:Forced" }), {
        status: this.failWith,
        headers: { "content-type": "application/json" },
      });
    }

    const path = new URL(url).pathname;
    for (const [suffix, fn] of this.routes) {
      if (path.endsWith(suffix)) {
        const r = fn(body);
        return new Response(JSON.stringify(r.body), {
          status: r.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

export const stub = new NominalStub();

/** Default routes covering the tier-1 happy paths. */
export function installDefaultRoutes(): void {
  stub.routes.clear();
  stub.on("/units/v1/units", () => ({ body: { units: [] } }));
  stub.on("/scout/v1/search-runs", () => ({
    body: {
      results: [
        {
          rid: "ri.scout.gov.run.11111111-1111-1111-1111-111111111111",
          title: "Hot fire 14",
          description: "Static fire",
          startTime: { seconds: 1770000000, nanos: 0 },
          endTime: { seconds: 1770000600, nanos: 0 },
          runNumber: 14,
          labels: ["hotfire"],
        },
      ],
      nextPageToken: null,
    },
  }));
  stub.on("/scout/v1/search-assets", () => ({
    body: {
      results: [
        { rid: "ri.scout.gov.asset.22222222-2222-2222-2222-222222222222", title: "Engine A" },
      ],
      nextPageToken: null,
    },
  }));
  stub.on("/catalog/v1/search-datasets-v2", () => ({ body: { results: [], nextPageToken: null } }));
  stub.on("/event/v1/search-events", () => ({ body: { results: [], nextPageToken: null } }));
  stub.on("/scout/v1/asset/multiple", () => ({
    body: {
      "ri.scout.gov.asset.22222222-2222-2222-2222-222222222222": {
        rid: "ri.scout.gov.asset.22222222-2222-2222-2222-222222222222",
        title: "Engine A",
        labels: [],
        properties: {},
      },
    },
  }));
  stub.on("/data-source/v1/data-sources/search-channels", () => ({
    body: {
      results: [
        {
          name: "chamber_psi",
          dataSource: "ri.catalog.gov.dataset.33333333-3333-3333-3333-333333333333",
          unit: { symbol: "psi" },
          dataType: "DOUBLE",
        },
      ],
    },
  }));
  stub.on("/compute/v2/compute", () => ({
    body: {
      numericSeries: {
        points: Array.from({ length: 1000 }, (_, i) => ({
          timestamp: { seconds: 1770000000 + i, nanos: 0 },
          value: Math.sin(i / 50) * 100 + 500,
        })),
      },
    },
  }));
  stub.on("/export/v1/generateExportPresignedLink", () => ({
    body: { url: "https://example-presigned.invalid/x.csv", expiresIn: 900 },
  }));
  stub.on("/event/v1/events", () => ({ body: { uuid: "ev-1" } }));
  // Path params — match on the prefix segment.
  stub.routes.set("/x-run", () => ({ body: {} }));
}

/** GET /scout/v1/run/{rid} needs prefix matching, handled separately. */
const RUN_FIXTURE = {
  rid: "ri.scout.gov.run.11111111-1111-1111-1111-111111111111",
  title: "Hot fire 14",
  description: "Static fire",
  startTime: { seconds: 1770000000, nanos: 0 },
  endTime: { seconds: 1770000600, nanos: 0 },
  runNumber: 14,
  labels: ["hotfire"],
  properties: {},
  assets: ["ri.scout.gov.asset.22222222-2222-2222-2222-222222222222"],
  dataSources: {
    primary: {
      dataSource: { dataset: "ri.catalog.gov.dataset.33333333-3333-3333-3333-333333333333" },
    },
  },
};

const realFetch = globalThis.fetch;

export function installFetchStub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;

    // Prefix routes that carry a path parameter.
    if (/^\/scout\/v1\/run\/[^/]+$/.test(path)) {
      stub.calls.push({ method: init?.method ?? "GET", url, body: null, authorization: null });
      if (stub.failWith) {
        return new Response(JSON.stringify({ errorName: "Stub:Forced" }), { status: stub.failWith });
      }
      return new Response(JSON.stringify(RUN_FIXTURE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/^\/catalog\/v1\/datasets\/[^/]+$/.test(path)) {
      stub.calls.push({ method: init?.method ?? "GET", url, body: null, authorization: null });
      return new Response(JSON.stringify({ rid: "ds", name: "Dataset" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return stub.fetch(input, init);
  }) as typeof fetch;
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

export const kv = new MemoryKV();

export const testEnv: Env = {
  TOKEN_SECRET: "test-token-secret-not-a-real-key-000000",
  HANDLE_SECRET: "test-handle-secret-not-a-real-key-00000",
  OAUTH_KV: kv as unknown as KVNamespace,
  PUBLIC_ORIGIN: TEST_ORIGIN,
  ALLOWED_ORIGINS: "",
  STRICT_HEADERS: "0",
  // Effectively off for tests; the rate limiter has its own suite.
  RATE_LIMIT_RPM: "100000",
  ENVIRONMENT: "test",
};

export async function testToken(
  scopes: Scope[] = ["nominal:read", "nominal:write"],
  overrides: Partial<{ aud: string; exp: number; base: string }> = {},
): Promise<string> {
  return mintToken(
    {
      sub: "test-subject",
      key: "nominal-test-api-key",
      base: overrides.base ?? TEST_BASE,
      scopes,
      aud: overrides.aud ?? TEST_CANONICAL,
      exp: overrides.exp ?? Math.floor(Date.now() / 1000) + 3600,
    },
    testEnv.TOKEN_SECRET,
  );
}

export interface RpcOptions {
  version?: string;
  token?: string | null;
  headers?: Record<string, string>;
  /** Omit the auto-generated _meta block entirely. */
  noMeta?: boolean;
  /** Send as a notification (no id). */
  notification?: boolean;
  id?: string | number;
  origin?: string;
  /** Send this exact string as the body instead of serializing. */
  rawBody?: string;
}

/** Build a spec-shaped POST /mcp request. */
export function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  opts: RpcOptions = {},
): Request {
  const version = opts.version ?? LATEST;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": version,
    "mcp-method": method,
    ...opts.headers,
  };
  // An explicit Authorization in opts.headers wins, so tests can send a
  // deliberately malformed credential.
  if (opts.token !== null && !("authorization" in headers)) {
    headers["authorization"] = `Bearer ${opts.token ?? "PLACEHOLDER"}`;
  }
  if (opts.origin) headers["origin"] = opts.origin;

  if (method === "tools/call" && typeof params["name"] === "string" && !("mcp-name" in headers)) {
    headers["mcp-name"] = params["name"] as string;
  }
  if (method === "resources/read" && typeof params["uri"] === "string" && !("mcp-name" in headers)) {
    headers["mcp-name"] = params["uri"] as string;
  }

  const withMeta = opts.noMeta
    ? params
    : {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
          ...((params["_meta"] as Record<string, unknown>) ?? {}),
        },
      };

  const body =
    opts.rawBody ??
    JSON.stringify({
      jsonrpc: "2.0",
      ...(opts.notification ? {} : { id: opts.id ?? 1 }),
      method,
      params: withMeta,
    });

  return new Request(`${TEST_ORIGIN}/mcp`, { method: "POST", headers, body });
}

export async function call(
  method: string,
  params: Record<string, unknown> = {},
  opts: RpcOptions = {},
): Promise<{ status: number; json: any; headers: Headers }> {
  const token = opts.token === undefined ? await testToken() : opts.token;
  const res = await worker.fetch(mcpRequest(method, params, { ...opts, token }), testEnv);
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { __unparsed: text };
  }
  return { status: res.status, json: parsed, headers: res.headers };
}

export async function raw(req: Request): Promise<Response> {
  return worker.fetch(req, testEnv);
}

export { worker };
