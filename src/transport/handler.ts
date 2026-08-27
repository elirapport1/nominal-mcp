/**
 * MCP method dispatch. Transport-agnostic: takes a parsed JSON-RPC request plus
 * a RequestContext and returns a result object. The HTTP layer (http.ts) owns
 * status codes, headers, and auth challenges.
 *
 * Handlers always build a modern (2026-07-28) result; era.ts downgrades it.
 */
import {
  adaptContentForVersion,
  methodAvailable,
  negotiateLegacyVersion,
} from "../protocol/era.js";
import {
  ErrorCode,
  McpError,
  UnauthorizedError,
  internalError,
  invalidParams,
  methodNotFound,
} from "../protocol/errors.js";
import {
  META_SERVER_INFO,
  SUPPORTED_VERSIONS,
  type JsonRpcRequest,
  type RequestContext,
  type ServerCapabilities,
  type ToolDefinition,
} from "../protocol/types.js";
import { NominalClient, NominalError } from "../nominal/client.js";
import { TIER1_TOOLS, ToolError, type ToolHandler } from "../tools/tier1.js";
import { CATALOG_TOOLS } from "../tools/catalog.js";
import { enforceResultBudget, HandleError } from "../limits/budget.js";
import {
  RESOURCE_TEMPLATES,
  completeResourceArgument,
  listResources,
  readResource,
} from "../resources/index.js";
import { PROMPTS, getPromptMessages } from "../prompts/index.js";

export const SERVER_INFO = {
  name: "nominal-mcp",
  version: "1.0.0",
  title: "Nominal",
} as const;

export const SERVER_CAPABILITIES: ServerCapabilities = {
  tools: { listChanged: false },
  resources: { subscribe: false, listChanged: false },
  prompts: { listChanged: false },
  completions: {},
};

export const SERVER_INSTRUCTIONS = `Nominal is a hardware test-data platform: assets (hardware under test), runs (tests), datasets, and telemetry channels.

Typical path: nominal_search to find something -> nominal_get for detail -> nominal_describe_channels to see what was recorded -> nominal_query_channels for statistics over a window.

Two things to know. Channel data is never returned raw: queries give statistics plus a decimated trace, and bulk data comes back as a presigned URL from nominal_export. And only a handful of common operations are tools — the other ${"467"} API operations are reachable via nominal_api_search followed by nominal_api_call.`;

/** Deterministic order — SEP-2549 asks for it, and it keeps prompt caches warm. */
const ALL_TOOLS = [...TIER1_TOOLS, ...CATALOG_TOOLS].sort((a, b) =>
  a.def.name.localeCompare(b.def.name),
);
const TOOLS_BY_NAME = new Map<string, { def: ToolDefinition; handler: ToolHandler }>(
  ALL_TOOLS.map((t) => [t.def.name, t]),
);

export const TOOL_DEFINITIONS: ToolDefinition[] = ALL_TOOLS.map((t) => t.def);

export interface HandlerDeps {
  handleSecret: string;
}

function clientFor(ctx: RequestContext): NominalClient {
  if (!ctx.auth) throw new UnauthorizedError("Authorization required to reach Nominal");
  return new NominalClient(ctx.auth);
}

function maybeClient(ctx: RequestContext): NominalClient | null {
  return ctx.auth ? new NominalClient(ctx.auth) : null;
}

export async function dispatch(
  req: JsonRpcRequest,
  ctx: RequestContext,
  deps: HandlerDeps,
): Promise<Record<string, unknown>> {
  const { method } = req;
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (!methodAvailable(method, ctx.era)) {
    throw methodNotFound(
      `${method} (not available in protocol version ${ctx.protocolVersion})`,
    );
  }

  switch (method) {
    // -----------------------------------------------------------------------
    case "server/discover":
      return {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: SERVER_CAPABILITIES,
        instructions: SERVER_INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: "public",
        _meta: { [META_SERVER_INFO]: SERVER_INFO },
      };

    case "initialize": {
      const requested =
        typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "2025-06-18";
      return {
        protocolVersion: negotiateLegacyVersion(requested),
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      };
    }

    case "ping":
      return {};

    case "logging/setLevel":
      return {};

    // -----------------------------------------------------------------------
    case "tools/list":
      return {
        tools: TOOL_DEFINITIONS,
        // Tool list is identical for every user, so it may be shared-cached.
        ttlMs: 3_600_000,
        cacheScope: "public",
      };

    case "tools/call":
      return callTool(params, ctx, deps);

    // -----------------------------------------------------------------------
    case "resources/list": {
      const resources = await listResources(ctx, maybeClient(ctx));
      return { resources, ttlMs: 30_000, cacheScope: "private" };
    }

    case "resources/templates/list":
      return {
        resourceTemplates: RESOURCE_TEMPLATES,
        ttlMs: 3_600_000,
        cacheScope: "public",
      };

    case "resources/read": {
      const uri = params["uri"];
      if (typeof uri !== "string" || !uri) {
        throw invalidParams("'uri' is required and must be a string.");
      }
      const contents = await readResource(uri, ctx, maybeClient(ctx));
      return {
        contents: [contents],
        // User-scoped data: never shared across authorization contexts.
        ttlMs: 30_000,
        cacheScope: "private",
      };
    }

    case "resources/subscribe":
    case "resources/unsubscribe":
      // Advertised as unsupported; answer politely rather than erroring.
      return {};

    // -----------------------------------------------------------------------
    case "prompts/list":
      return {
        prompts: PROMPTS.map((p) => p.def),
        ttlMs: 3_600_000,
        cacheScope: "public",
      };

    case "prompts/get": {
      const name = params["name"];
      if (typeof name !== "string") throw invalidParams("'name' is required and must be a string.");
      const rawArgs = (params["arguments"] ?? {}) as Record<string, unknown>;
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawArgs)) {
        if (typeof v === "string") args[k] = v;
      }
      try {
        const { description, messages } = getPromptMessages(name, args);
        return { description, messages };
      } catch (e) {
        throw invalidParams(e instanceof Error ? e.message : String(e));
      }
    }

    // -----------------------------------------------------------------------
    case "completion/complete": {
      const ref = params["ref"] as { type?: string; uri?: string; name?: string } | undefined;
      const argument = params["argument"] as { name?: string; value?: string } | undefined;
      if (!ref || !argument?.name) {
        throw invalidParams("'ref' and 'argument' are required.");
      }
      let values: string[] = [];
      if (ref.type === "ref/resource" && ref.uri) {
        values = await completeResourceArgument(
          ref.uri,
          argument.name,
          argument.value ?? "",
          maybeClient(ctx),
        );
      }
      return {
        completion: { values: values.slice(0, 100), total: values.length, hasMore: false },
      };
    }

    default:
      throw methodNotFound(method);
  }
}

async function callTool(
  params: Record<string, unknown>,
  ctx: RequestContext,
  deps: HandlerDeps,
): Promise<Record<string, unknown>> {
  const name = params["name"];
  if (typeof name !== "string" || !name) {
    throw invalidParams("'name' is required and must be a string.");
  }
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    throw invalidParams(
      `Unknown tool: ${name}. Available tools: ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}.`,
      { available: TOOL_DEFINITIONS.map((t) => t.name) },
    );
  }

  const rawArgs = params["arguments"];
  if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
    throw invalidParams("'arguments' must be an object.");
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  // Auth is required for every tool: they all reach Nominal.
  if (!ctx.auth) throw new UnauthorizedError("Authorization required to call Nominal tools");

  const started = Date.now();
  try {
    const result = await tool.handler({
      args,
      ctx,
      client: clientFor(ctx),
      handleSecret: deps.handleSecret,
    });

    const { value, truncated, bytes } = enforceResultBudget(result);
    const meta: Record<string, unknown> = {
      [META_SERVER_INFO]: SERVER_INFO,
      "io.nominal.mcp/durationMs": Date.now() - started,
    };
    if (ctx.notices.length) meta["io.nominal.mcp/notices"] = [...ctx.notices];
    if (truncated) meta["io.nominal.mcp/truncatedFromBytes"] = bytes;

    // Data, never prose. A tenant-controlled string must not reach the model
    // in a position where it reads as an instruction.
    const content = adaptContentForVersion(
      [{ type: "text", text: JSON.stringify(value) }],
      ctx.protocolVersion,
    );

    return { content, structuredContent: value as never, isError: false, _meta: meta };
  } catch (e) {
    return toolFailure(e, name, ctx, started);
  }
}

/**
 * Tool failures are results, not JSON-RPC errors. The model needs to read them
 * and recover; a protocol error would abort the call instead.
 */
function toolFailure(
  e: unknown,
  toolName: string,
  ctx: RequestContext,
  started: number,
): Record<string, unknown> {
  // An auth failure is a transport concern — rethrow so it becomes a 401.
  if (e instanceof UnauthorizedError) throw e;
  if (e instanceof McpError) throw e;

  let payload: Record<string, unknown>;

  if (e instanceof ToolError) {
    payload = { error: e.message, tool: toolName, ...(e.data ?? {}) };
  } else if (e instanceof NominalError) {
    payload = {
      error: e.message,
      tool: toolName,
      status: e.status,
      retryable: e.retryable,
      ...(e.retryAfter ? { retry_after_seconds: e.retryAfter } : {}),
      ...(e.nominalCode ? { nominal_error_code: e.nominalCode } : {}),
    };
  } else if (e instanceof HandleError) {
    payload = { error: e.message, tool: toolName };
  } else {
    // Never surface an internal message or stack to the model.
    payload = {
      error: "The tool failed unexpectedly. Retry, or narrow the request.",
      tool: toolName,
    };
    console.error(
      JSON.stringify({
        level: "error",
        msg: "unhandled tool error",
        tool: toolName,
        requestId: ctx.requestId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  const meta: Record<string, unknown> = {
    [META_SERVER_INFO]: SERVER_INFO,
    "io.nominal.mcp/durationMs": Date.now() - started,
  };
  if (ctx.notices.length) meta["io.nominal.mcp/notices"] = [...ctx.notices];

  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as never,
    isError: true,
    _meta: meta,
  };
}

export { internalError, ErrorCode };
