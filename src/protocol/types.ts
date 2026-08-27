/**
 * MCP wire types, current as of protocol revision 2026-07-28.
 *
 * Only the parts this server implements are modelled. Where a field was added
 * or removed by a specific revision the comment names it, because the era
 * adapter (era.ts) keys off exactly those differences.
 */

export const PROTOCOL_2026_07_28 = "2026-07-28";
export const PROTOCOL_2025_11_25 = "2025-11-25";
export const PROTOCOL_2025_06_18 = "2025-06-18";
export const PROTOCOL_2025_03_26 = "2025-03-26";
export const PROTOCOL_2024_11_05 = "2024-11-05";

/** Newest first — this is also the order advertised in `supportedVersions`. */
export const SUPPORTED_VERSIONS = [
  PROTOCOL_2026_07_28,
  PROTOCOL_2025_11_25,
  PROTOCOL_2025_06_18,
  PROTOCOL_2025_03_26,
  PROTOCOL_2024_11_05,
] as const;

export type ProtocolVersion = (typeof SUPPORTED_VERSIONS)[number];

/**
 * MODERN = 2026-07-28: stateless, `server/discover`, `resultType`, cache hints.
 * LEGACY = 2025-11-25 and earlier: `initialize` handshake, no `resultType`.
 */
export type Era = "modern" | "legacy";

// ---------------------------------------------------------------------------
// Reserved `_meta` keys (spec §"General fields")
// ---------------------------------------------------------------------------

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const META_LOG_LEVEL = "io.modelcontextprotocol/logLevel";
export const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
export const META_PROGRESS_TOKEN = "progressToken";

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcErrorBody;
}

export interface JsonRpcResultResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: Record<string, unknown>;
}

export type JsonRpcResponse = JsonRpcResultResponse | JsonRpcErrorResponse;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** 2026-07-28 requires `resultType` on every result. Stripped for legacy. */
export type ResultType = "complete" | "input_required";

/**
 * Cache hints. REQUIRED (2026-07-28) on results of: server/discover, tools/list,
 * prompts/list, resources/list, resources/templates/list, resources/read.
 */
export interface CacheHints {
  ttlMs: number; // MUST be >= 0
  cacheScope: "public" | "private";
}

export interface Implementation {
  name: string;
  version: string;
  title?: string;
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  completions?: Record<string, never>;
  logging?: Record<string, never>;
  experimental?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface ClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: Record<string, never>;
  elicitation?: Record<string, never>;
  experimental?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

export type ContentBlock =
  | { type: "text"; text: string; _meta?: Record<string, unknown> }
  | { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType?: string; text?: string; blob?: string };
    };

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: JsonValue;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Resources & prompts
// ---------------------------------------------------------------------------

export interface ResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: { audience?: string[]; priority?: number };
}

export interface ResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptDefinition {
  name: string;
  title?: string;
  description: string;
  arguments?: PromptArgument[];
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: ContentBlock;
}

// ---------------------------------------------------------------------------
// Request context — everything a handler needs, assembled per request.
// ---------------------------------------------------------------------------

export interface RequestContext {
  era: Era;
  protocolVersion: string;
  clientInfo?: Implementation;
  clientCapabilities: ClientCapabilities;
  logLevel?: string;
  progressToken?: string | number;
  /** Nominal credential + scopes resolved from the Authorization header. */
  auth: import("../auth/token.js").AuthContext | null;
  /** Canonical URI of this MCP server, used for RFC 8707 audience checks. */
  canonicalUri: string;
  requestId: string;
  traceparent?: string;
  /** Non-fatal advisories surfaced to the agent in `_meta.notices`. */
  notices: string[];
}
