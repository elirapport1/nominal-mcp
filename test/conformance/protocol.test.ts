/**
 * Protocol conformance: one test per MUST clause in MCP 2026-07-28 that this
 * server is responsible for. Each `describe` names the spec section it comes
 * from so a failure points straight at the requirement.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  LATEST,
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

// ===========================================================================
describe("base protocol — messages", () => {
  it("rejects a body that is not valid JSON with -32700", async () => {
    const res = await raw(
      new Request(`${TEST_ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": LATEST },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    const b: any = await res.json();
    expect(b.error.code).toBe(-32700);
  });

  it("rejects a missing jsonrpc version with -32600", async () => {
    const r = await call("tools/list", {}, { rawBody: JSON.stringify({ id: 1, method: "tools/list" }) });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32600);
  });

  it("rejects a null id (MUST NOT be null, unlike base JSON-RPC)", async () => {
    const r = await call(
      "tools/list",
      {},
      { rawBody: JSON.stringify({ jsonrpc: "2.0", id: null, method: "tools/list" }) },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32600);
  });

  it("rejects batch arrays — one JSON-RPC message per POST", async () => {
    const r = await call("tools/list", {}, { rawBody: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]) });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32600);
  });

  it("returns 202 with no body for a notification", async () => {
    const res = await raw(
      new Request(`${TEST_ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("echoes the request id on every response", async () => {
    const r = await call("tools/list", {}, { id: "abc-123" });
    expect(r.json.id).toBe("abc-123");
  });

  it("returns -32601 with HTTP 404 for an unknown method", async () => {
    const r = await call("does/not/exist");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe(-32601);
  });
});

// ===========================================================================
describe("versioning and headers", () => {
  it("implements server/discover and lists supported versions", async () => {
    const r = await call("server/discover");
    expect(r.status).toBe(200);
    expect(r.json.result.supportedVersions).toContain(LATEST);
    expect(r.json.result.capabilities).toBeDefined();
    expect(r.json.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("nominal-mcp");
  });

  it("returns HeaderMismatch (-32020) when header and _meta versions differ", async () => {
    const r = await call(
      "tools/list",
      {},
      { headers: { "mcp-protocol-version": "2025-06-18" }, version: LATEST },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32020);
  });

  it("returns HeaderMismatch when Mcp-Method disagrees with the body", async () => {
    const r = await call("tools/list", {}, { headers: { "mcp-method": "tools/call" } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32020);
  });

  it("returns HeaderMismatch when Mcp-Name disagrees with params.name", async () => {
    const r = await call(
      "tools/call",
      { name: "nominal_search", arguments: {} },
      { headers: { "mcp-name": "something_else" } },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32020);
  });

  it("returns UnsupportedProtocolVersion (-32022) with the supported list", async () => {
    const r = await call("tools/list", {}, { version: "1999-01-01" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32022);
    expect(r.json.error.data.supportedVersions).toContain(LATEST);
  });

  it("requires clientCapabilities in _meta on modern non-public methods", async () => {
    const token = await testToken();
    const r = await call(
      "tools/call",
      {
        name: "nominal_search",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": LATEST,
          "io.modelcontextprotocol/clientCapabilities": undefined,
        },
      },
      { token, noMeta: true },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32602);
  });

  it("accepts a request with no version header as 2025-03-26", async () => {
    const res = await raw(
      new Request(`${TEST_ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
describe("results — resultType and caching", () => {
  it("sets resultType 'complete' on modern results", async () => {
    const r = await call("tools/list");
    expect(r.json.result.resultType).toBe("complete");
  });

  it("omits resultType for legacy clients", async () => {
    const r = await call("tools/list", {}, { version: "2025-06-18" });
    expect(r.json.result.resultType).toBeUndefined();
  });

  const cacheable: Array<[string, Record<string, unknown>]> = [
    ["server/discover", {}],
    ["tools/list", {}],
    ["prompts/list", {}],
    ["resources/list", {}],
    ["resources/templates/list", {}],
    ["resources/read", { uri: "nominal://server/capabilities" }],
  ];

  it.each(cacheable)("%s carries ttlMs and cacheScope", async (method, params) => {
    const r = await call(method, params);
    expect(r.status).toBe(200);
    expect(typeof r.json.result.ttlMs).toBe("number");
    expect(r.json.result.ttlMs).toBeGreaterThanOrEqual(0);
    expect(["public", "private"]).toContain(r.json.result.cacheScope);
  });

  it("strips cache hints for legacy clients", async () => {
    const r = await call("tools/list", {}, { version: "2025-11-25" });
    expect(r.json.result.ttlMs).toBeUndefined();
    expect(r.json.result.cacheScope).toBeUndefined();
  });

  it("marks user-scoped resource reads as private", async () => {
    const r = await call("resources/read", { uri: "nominal://server/capabilities" });
    expect(r.json.result.cacheScope).toBe("private");
  });

  it("marks the tool list public — it is identical for every user", async () => {
    const r = await call("tools/list");
    expect(r.json.result.cacheScope).toBe("public");
  });
});

// ===========================================================================
describe("legacy era", () => {
  it("answers initialize with a negotiated version", async () => {
    const r = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {} }, { version: "2025-06-18" });
    expect(r.status).toBe(200);
    expect(r.json.result.protocolVersion).toBe("2025-06-18");
    expect(r.json.result.serverInfo.name).toBe("nominal-mcp");
  });

  it("rejects initialize from a modern client (removed in 2026-07-28)", async () => {
    const r = await call("initialize", { protocolVersion: LATEST });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe(-32601);
  });

  it("rejects server/discover from a legacy client", async () => {
    const r = await call("server/discover", {}, { version: "2025-06-18" });
    expect(r.status).toBe(404);
  });

  it("answers ping for legacy clients only", async () => {
    const ok = await call("ping", {}, { version: "2025-06-18" });
    expect(ok.status).toBe(200);
    const gone = await call("ping", {});
    expect(gone.status).toBe(404);
  });
});

// ===========================================================================
describe("tools", () => {
  it("returns a deterministic, stable tool order", async () => {
    const a = await call("tools/list");
    const b = await call("tools/list");
    const names = (x: any) => x.json.result.tools.map((t: any) => t.name);
    expect(names(a)).toEqual(names(b));
    expect(names(a)).toEqual([...names(a)].sort());
  });

  it("gives every tool a name, description, and object inputSchema", async () => {
    const r = await call("tools/list");
    for (const t of r.json.result.tools) {
      expect(t.name).toMatch(/^nominal_[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("annotates write tools as destructive and reads as read-only", async () => {
    const r = await call("tools/list");
    const byName = Object.fromEntries(r.json.result.tools.map((t: any) => [t.name, t]));
    expect(byName["nominal_search"].annotations.readOnlyHint).toBe(true);
    expect(byName["nominal_write"].annotations.destructiveHint).toBe(true);
    expect(byName["nominal_api_call"].annotations.destructiveHint).toBe(true);
  });

  it("reports an unknown tool as -32602, not -32601", async () => {
    const r = await call("tools/call", { name: "nope", arguments: {} }, { headers: { "mcp-name": "nope" } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32602);
  });

  it("returns tool failures as isError results, not JSON-RPC errors", async () => {
    const r = await call(
      "tools/call",
      { name: "nominal_get", arguments: { uri: "not-a-uri" } },
      { headers: { "mcp-name": "nominal_get" } },
    );
    expect(r.status).toBe(200);
    expect(r.json.error).toBeUndefined();
    expect(r.json.result.isError).toBe(true);
    expect(r.json.result.structuredContent.error).toContain("Could not interpret");
  });

  it("returns structuredContent alongside content", async () => {
    const r = await call(
      "tools/call",
      { name: "nominal_search", arguments: { query: "hotfire", kind: "run" } },
      { headers: { "mcp-name": "nominal_search" } },
    );
    expect(r.json.result.isError).toBe(false);
    expect(r.json.result.structuredContent.results[0].name).toBe("Hot fire 14");
    expect(r.json.result.content[0].type).toBe("text");
  });
});

// ===========================================================================
describe("resources", () => {
  it("exposes templates rather than an unbounded list", async () => {
    const r = await call("resources/templates/list");
    const names = r.json.result.resourceTemplates.map((t: any) => t.name);
    expect(names).toContain("run");
    expect(names).toContain("asset");
    expect(names).toContain("channel");
  });

  it("reports an unknown resource as -32602 for modern clients", async () => {
    const r = await call("resources/read", { uri: "nominal://bogus/x" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32602);
  });

  it("reports an unknown resource as -32002 for legacy clients", async () => {
    const r = await call("resources/read", { uri: "nominal://bogus/x" }, { version: "2025-06-18" });
    expect(r.json.error.code).toBe(-32002);
  });
});

// ===========================================================================
describe("prompts", () => {
  it("lists prompts with arguments", async () => {
    const r = await call("prompts/list");
    const p = r.json.result.prompts.find((x: any) => x.name === "investigate_anomaly");
    expect(p.arguments.find((a: any) => a.name === "run").required).toBe(true);
  });

  it("rejects a prompts/get missing a required argument", async () => {
    const r = await call("prompts/get", { name: "investigate_anomaly", arguments: {} });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32602);
  });

  it("builds prompt messages from arguments", async () => {
    const r = await call("prompts/get", {
      name: "investigate_anomaly",
      arguments: { run: "nominal://run/ri.x", symptom: "pressure spike" },
    });
    expect(r.json.result.messages[0].content.text).toContain("pressure spike");
  });
});
