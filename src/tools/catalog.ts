/**
 * The catalog tier: all 467 Nominal operations, reachable without paying for
 * 467 tool schemas.
 *
 * The original design called these "tier-2 tools discovered on demand". MCP
 * 2026-07-28 makes that impossible — SEP-2567 removed sessions, and
 * `tools/list` "no longer varies per-connection". A server cannot grow its tool
 * list for one client mid-session.
 *
 * So the same idea is expressed as two static tools over a data catalog:
 * `nominal_api_search` returns operation *descriptors* (~120 tokens each) and
 * `nominal_api_call` executes one by id. `tools/list` stays constant and
 * publicly cacheable, and the agent pays only for what it actually looked up.
 */
// Plain JSON import, no import attribute: esbuild inlines it at bundle time,
// and the `with { type: "json" }` form is not parsed by every bundler in the
// toolchain (wrangler 3 rejects it outright).
import catalogData from "../nominal/catalog.json";
import { NominalClient } from "../nominal/client.js";
import { hasScope } from "../auth/token.js";
import { clampLimit } from "../limits/budget.js";
import { ToolError, type ToolHandler } from "./tier1.js";
import type { ToolDefinition } from "../protocol/types.js";

export interface CatalogOperation {
  id: string;
  op: string;
  service: string;
  method: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  bodyArg: string | null;
  args: string[];
  argTypes: Record<string, string>;
  binary: boolean;
  policy: "read" | "mutating" | "internal";
  domain: string;
  summary: string;
  hay: string;
}

interface CatalogFile {
  operationCount: number;
  byPolicy: Record<string, number>;
  byDomain: Record<string, number>;
  operations: CatalogOperation[];
}

const CATALOG = catalogData as unknown as CatalogFile;

export const OPERATIONS: CatalogOperation[] = CATALOG.operations;
export const OPERATIONS_BY_ID = new Map(OPERATIONS.map((o) => [o.id, o]));
export const CATALOG_STATS = {
  total: CATALOG.operationCount,
  byPolicy: CATALOG.byPolicy,
  byDomain: CATALOG.byDomain,
};

/** Cheap lexical scoring. Exact and prefix matches on the operation name win. */
function score(op: CatalogOperation, terms: string[]): number {
  let s = 0;
  const name = op.op.toLowerCase();
  const domain = op.domain.toLowerCase();
  for (const t of terms) {
    if (name === t) s += 100;
    else if (name.startsWith(t)) s += 40;
    else if (name.includes(t)) s += 25;
    if (domain === t) s += 30;
    if (op.hay.includes(t)) s += 8;
    // Whole-word hit in the haystack beats a substring hit.
    if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(op.hay)) s += 6;
  }
  // Prefer read operations and shorter names when otherwise equal.
  if (op.policy === "read") s += 3;
  s -= Math.min(6, Math.floor(name.length / 12));
  return s;
}

export const apiSearchTool: ToolHandler = async ({ args, ctx }) => {
  const query = typeof args["query"] === "string" ? args["query"].trim() : "";
  if (!query) {
    throw new ToolError(
      "'query' is required. Describe the operation you want, e.g. 'archive dataset' or 'video segments'.",
      { domains: Object.keys(CATALOG_STATS.byDomain) },
    );
  }
  const { value: limit, notice } = clampLimit(args["limit"], 25, 8);
  if (notice) ctx.notices.push(notice);

  const domain = typeof args["domain"] === "string" ? args["domain"].toLowerCase() : undefined;
  if (domain && !(domain in CATALOG_STATS.byDomain)) {
    throw new ToolError(
      `Unknown domain ${JSON.stringify(domain)}. Available: ${Object.keys(CATALOG_STATS.byDomain).join(", ")}.`,
    );
  }
  const mutatingFilter = args["mutating"];

  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) {
    throw new ToolError("'query' must contain at least one word of two or more characters.");
  }

  const pool = OPERATIONS.filter((o) => {
    if (o.policy === "internal") return false; // never advertised
    if (domain && o.domain !== domain) return false;
    if (mutatingFilter === true && o.policy !== "mutating") return false;
    if (mutatingFilter === false && o.policy !== "read") return false;
    return true;
  });

  const ranked = pool
    .map((o) => ({ o, s: score(o, terms) }))
    .filter((r) => r.s > 8)
    .sort((a, b) => b.s - a.s || a.o.id.localeCompare(b.o.id))
    .slice(0, limit);

  if (ranked.length === 0) {
    return {
      query,
      count: 0,
      operations: [],
      hint: `No operation matched. Try a single keyword, or browse by domain: ${Object.keys(CATALOG_STATS.byDomain).join(", ")}.`,
    };
  }

  return {
    query,
    count: ranked.length,
    operations: ranked.map(({ o }) => ({
      operation_id: o.id,
      method: o.method,
      path: o.path,
      summary: o.summary,
      domain: o.domain,
      mutating: o.policy === "mutating",
      arguments: o.args,
      argument_types: o.argTypes,
      ...(o.binary ? { returns_binary: true } : {}),
    })),
    next: "Call nominal_api_call with an operation_id and an 'arguments' object keyed by the argument names above.",
  };
};

export const apiCallTool: ToolHandler = async ({ args, ctx, client }) => {
  const id = typeof args["operation_id"] === "string" ? args["operation_id"].trim() : "";
  if (!id) {
    throw new ToolError("'operation_id' is required. Use nominal_api_search to find one.");
  }

  const op = OPERATIONS_BY_ID.get(id);
  if (!op) {
    // Help rather than just refuse — a near miss is usually a typo.
    const near = OPERATIONS.filter((o) => o.op === id.split(".").pop())
      .slice(0, 3)
      .map((o) => o.id);
    throw new ToolError(
      `Unknown operation_id ${JSON.stringify(id)}. Operation ids come from nominal_api_search and are never constructed by hand.`,
      near.length ? { did_you_mean: near } : undefined,
    );
  }

  // Policy gate. Internal ops are never callable with a user-delegated token.
  if (op.policy === "internal") {
    throw new ToolError(
      `Operation ${id} is an internal control-plane operation and is not callable through MCP.`,
    );
  }
  if (op.policy === "mutating") {
    if (!ctx.auth || !hasScope(ctx.auth, "nominal:write")) {
      throw new ToolError(
        `Operation ${id} modifies data and needs the 'nominal:write' scope; this connection is read-only.`,
      );
    }
  } else if (ctx.auth && !hasScope(ctx.auth, "nominal:read")) {
    throw new ToolError(`Operation ${id} needs the 'nominal:read' scope.`);
  }

  const provided = (args["arguments"] ?? {}) as Record<string, unknown>;
  if (typeof provided !== "object" || provided === null || Array.isArray(provided)) {
    throw new ToolError("'arguments' must be a JSON object keyed by the operation's argument names.");
  }

  // Reject anything the operation does not declare, so a typo surfaces here
  // rather than as a confusing Nominal-side error.
  const unknown = Object.keys(provided).filter((k) => !op.args.includes(k));
  if (unknown.length) {
    throw new ToolError(
      `Unknown argument(s) for ${id}: ${unknown.join(", ")}. This operation accepts: ${op.args.join(", ") || "(none)"}.`,
      { accepts: op.args, types: op.argTypes },
    );
  }

  // Bind path params from the catalog's recorded template. Path components are
  // encoded, so a value can never introduce a new segment.
  let path = op.path;
  for (const p of op.pathParams) {
    // Conjure path params are camelCase in the template, snake_case in the args.
    const snake = p.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const v = provided[snake] ?? provided[p];
    if (v === undefined || v === null || v === "") {
      throw new ToolError(`Operation ${id} requires path parameter '${snake}'.`, {
        accepts: op.args,
      });
    }
    if (typeof v !== "string" && typeof v !== "number") {
      throw new ToolError(`Path parameter '${snake}' must be a string or number.`);
    }
    path = path.replace(`{${p}}`, encodeURIComponent(String(v)));
  }
  if (/\{[^}]+\}/.test(path)) {
    throw new ToolError(`Could not bind every path parameter for ${id}; unresolved: ${path}`);
  }

  const query: Record<string, string | string[]> = {};
  for (const q of op.queryParams) {
    const snake = q.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const v = provided[snake] ?? provided[q];
    if (v === undefined || v === null) continue;
    query[q] = Array.isArray(v) ? v.map(String) : String(v);
  }

  // Body: whatever argument the generated client serialized as the JSON body.
  let body: unknown;
  if (op.bodyArg) {
    const bodyArgName = op.args.find(
      (a) => op.bodyArg === a || op.bodyArg?.includes(`(${a})`) || op.bodyArg?.includes(a),
    );
    if (bodyArgName && bodyArgName in provided) {
      body = provided[bodyArgName];
    } else if (op.args.length === 1 && op.args[0] && op.args[0] in provided) {
      body = provided[op.args[0]];
    } else if (op.method !== "GET" && op.method !== "DELETE") {
      const missing = op.args.filter((a) => !op.pathParams.includes(a) && !op.queryParams.includes(a));
      if (missing.length) {
        throw new ToolError(
          `Operation ${id} needs a request body. Provide '${missing[0]}' inside 'arguments'.`,
          { accepts: op.args, types: op.argTypes },
        );
      }
    }
  }

  const res = await client.call({
    method: op.method,
    path,
    query,
    body,
    binary: op.binary,
  });

  return {
    operation_id: id,
    method: op.method,
    path,
    mutating: op.policy === "mutating",
    result: res,
  };
};

export const CATALOG_TOOLS: Array<{ def: ToolDefinition; handler: ToolHandler }> = [
  {
    def: {
      name: "nominal_api_search",
      description: `Find one of the ${CATALOG_STATS.total} Nominal API operations by keyword, when no other tool fits. Returns operation ids and argument names for nominal_api_call.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, e.g. 'archive dataset'." },
          domain: {
            type: "string",
            enum: Object.keys(CATALOG_STATS.byDomain),
            },
          mutating: { type: "boolean", description: "true=writes only, false=reads only." },
          limit: { type: "integer", minimum: 1, maximum: 25, default: 8 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    handler: apiSearchTool,
  },
  {
    def: {
      name: "nominal_api_call",
      description:
        "Execute an operation returned by nominal_api_search. Arguments are validated against its real signature. Writes need the nominal:write scope.",
      annotations: { destructiveHint: true, openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: {
          operation_id: {
            type: "string",
            description: "Exactly as returned by nominal_api_search.",
          },
          arguments: {
            type: "object",
            description: "Keyed by the argument names nominal_api_search listed.",
            additionalProperties: true,
          },
        },
        required: ["operation_id"],
        additionalProperties: false,
      },
    },
    handler: apiCallTool,
  },
];
