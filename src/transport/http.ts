/**
 * Streamable HTTP transport (MCP 2026-07-28), with backward compatibility.
 *
 * The 2026-07-28 revision removed the GET stream endpoint and protocol-level
 * sessions, so this is a single POST endpoint. `subscriptions/listen` is not
 * implemented — see era.ts for why there is nothing to push.
 *
 * Validation order matters and is specified in SPEC.md §3.3 — it determines
 * which error a malformed request gets, and the conformance suite asserts it
 * step by step.
 */
import {
  ErrorCode,
  McpError,
  UnauthorizedError,
  headerMismatch,
  internalError,
  invalidParams,
  invalidRequest,
  methodNotFound,
  parseError,
  unsupportedProtocolVersion,
} from "../protocol/errors.js";
import {
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_LOG_LEVEL,
  META_PROGRESS_TOKEN,
  META_SERVER_INFO,
  SUPPORTED_VERSIONS,
  type JsonRpcRequest,
  type RequestContext,
} from "../protocol/types.js";
import { adaptResult, eraFor, isSupportedVersion, resolveVersion } from "../protocol/era.js";
import { SERVER_INFO, dispatch } from "./handler.js";
import { directAuth, verifyToken, TokenError } from "../auth/token.js";
import { DEFAULT_NOMINAL_BASE } from "../auth/oauth.js";
import type { Env } from "../env.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

export interface TransportOptions {
  canonicalUri: string;
  origin: string;
  /** The caller's Origin, once validated against the allowlist. */
  requestOrigin?: string | null;
}

/** Methods callable without credentials, so a client can discover the server. */
const PUBLIC_METHODS = new Set([
  "server/discover",
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "prompts/list",
  "prompts/get",
  "resources/templates/list",
  "logging/setLevel",
]);

export async function handleMcpPost(
  req: Request,
  env: Env,
  opts: TransportOptions,
): Promise<Response> {
  const requestId = crypto.randomUUID();

  // (1) Origin — DNS-rebinding protection. Checked before anything is parsed.
  const origin = req.headers.get("origin");
  if (origin && !originAllowed(origin, env, opts.origin)) {
    return jsonRpcErrorResponse(
      null,
      { code: ErrorCode.InvalidRequest, message: "Origin not allowed" },
      403,
      opts,
    );
  }

  // Safe to echo now that it has passed the allowlist.
  opts = { ...opts, requestOrigin: origin };

  // A token in the query string is forbidden by the auth spec.
  const url = new URL(req.url);
  if (url.searchParams.has("access_token")) {
    return jsonRpcErrorResponse(
      null,
      {
        code: ErrorCode.InvalidRequest,
        message: "Access tokens must be sent in the Authorization header, never in the query string.",
      },
      400,
      opts,
    );
  }

  // (2) Body must be JSON and within size.
  const rawBody = await readBoundedText(req);
  if (rawBody === null) {
    return jsonRpcErrorResponse(
      null,
      { code: ErrorCode.InvalidRequest, message: `Request body exceeds ${MAX_BODY_BYTES} bytes` },
      413,
      opts,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return jsonRpcErrorResponse(
      null,
      parseError(e instanceof Error ? e.message : undefined).toBody(),
      400,
      opts,
    );
  }

  // Batch arrays were removed from the transport; the body MUST be one message.
  if (Array.isArray(body)) {
    return jsonRpcErrorResponse(
      null,
      invalidRequest(
        "Batched requests are not supported. Send one JSON-RPC message per HTTP POST.",
      ).toBody(),
      400,
      opts,
    );
  }

  // (3) JSON-RPC shape.
  if (typeof body !== "object" || body === null) {
    return jsonRpcErrorResponse(null, invalidRequest("Request body must be a JSON object").toBody(), 400, opts);
  }
  const msg = body as Record<string, unknown>;
  if (msg["jsonrpc"] !== "2.0") {
    return jsonRpcErrorResponse(
      idOf(msg),
      invalidRequest("'jsonrpc' must be exactly \"2.0\"").toBody(),
      400,
      opts,
    );
  }
  if (typeof msg["method"] !== "string" || msg["method"] === "") {
    return jsonRpcErrorResponse(idOf(msg), invalidRequest("'method' must be a non-empty string").toBody(), 400, opts);
  }
  const method = msg["method"] as string;
  const isNotification = !("id" in msg) || msg["id"] === undefined;
  if (!isNotification && msg["id"] === null) {
    return jsonRpcErrorResponse(null, invalidRequest("'id' must not be null").toBody(), 400, opts);
  }
  if (!isNotification && typeof msg["id"] !== "string" && typeof msg["id"] !== "number") {
    return jsonRpcErrorResponse(null, invalidRequest("'id' must be a string or number").toBody(), 400, opts);
  }
  if (msg["params"] !== undefined && (typeof msg["params"] !== "object" || msg["params"] === null || Array.isArray(msg["params"]))) {
    return jsonRpcErrorResponse(idOf(msg), invalidParams("'params' must be an object").toBody(), 400, opts);
  }

  const id = isNotification ? null : (msg["id"] as string | number);
  const params = (msg["params"] ?? {}) as Record<string, unknown>;
  const meta = (params["_meta"] ?? {}) as Record<string, unknown>;

  // (4-6) Protocol version.
  const headerVersion = req.headers.get("mcp-protocol-version");
  if (!headerVersion && env.STRICT_HEADERS === "1") {
    return jsonRpcErrorResponse(
      id,
      invalidRequest("MCP-Protocol-Version header is required").toBody(),
      400,
      opts,
    );
  }
  const { version, source } = resolveVersion(headerVersion, { method, params });

  // (5) Header/body mismatch.
  const metaVersion = meta[META_PROTOCOL_VERSION_KEY];
  if (headerVersion && typeof metaVersion === "string" && headerVersion !== metaVersion) {
    return jsonRpcErrorResponse(
      id,
      headerMismatch("MCP-Protocol-Version", headerVersion, metaVersion).toBody(),
      400,
      opts,
    );
  }

  if (!isSupportedVersion(version)) {
    return jsonRpcErrorResponse(
      id,
      unsupportedProtocolVersion(version, SUPPORTED_VERSIONS).toBody(),
      400,
      opts,
    );
  }
  const era = eraFor(version);

  // (7) Mcp-Method / Mcp-Name headers.
  const hMethod = req.headers.get("mcp-method");
  if (hMethod && hMethod !== method) {
    return jsonRpcErrorResponse(id, headerMismatch("Mcp-Method", hMethod, method).toBody(), 400, opts);
  }
  const hName = req.headers.get("mcp-name");
  if (hName) {
    const expected =
      method === "tools/call" || method === "prompts/get"
        ? params["name"]
        : method === "resources/read"
          ? params["uri"]
          : undefined;
    if (typeof expected === "string" && !mcpNameMatches(hName, expected)) {
      return jsonRpcErrorResponse(id, headerMismatch("Mcp-Name", hName, expected).toBody(), 400, opts);
    }
  }

  // (8) Modern requests must declare client capabilities.
  if (era === "modern" && !PUBLIC_METHODS.has(method)) {
    if (meta[META_CLIENT_CAPABILITIES] === undefined) {
      return jsonRpcErrorResponse(
        id,
        invalidParams(
          `Requests at protocol version ${version} must include '${META_CLIENT_CAPABILITIES}' in params._meta.`,
        ).toBody(),
        400,
        opts,
      );
    }
  }

  // Notifications: acknowledge and stop. No body, per the transport spec.
  if (isNotification) {
    return new Response(null, { status: 202, headers: baseHeaders(opts) });
  }

  // (10) Authentication.
  let auth = null;
  let authFailure: UnauthorizedError | null = null;
  const authorization = req.headers.get("authorization");
  if (authorization) {
    try {
      auth = await authenticate(
        authorization,
        env,
        opts.canonicalUri,
        req.headers.get("x-nominal-base-url"),
      );
    } catch (e) {
      authFailure = e instanceof UnauthorizedError ? e : new UnauthorizedError("Invalid credentials");
    }
  }
  // A bad credential is always an error, even on a public method — silently
  // downgrading to anonymous would hide a misconfigured client.
  if (authFailure) return unauthorizedResponse(authFailure, opts);
  if (!auth && !PUBLIC_METHODS.has(method)) {
    return unauthorizedResponse(new UnauthorizedError("Authorization required"), opts);
  }

  const ctx: RequestContext = {
    era,
    protocolVersion: version,
    clientInfo: meta[META_CLIENT_INFO] as RequestContext["clientInfo"],
    clientCapabilities: (meta[META_CLIENT_CAPABILITIES] ?? {}) as RequestContext["clientCapabilities"],
    logLevel: typeof meta[META_LOG_LEVEL] === "string" ? (meta[META_LOG_LEVEL] as string) : undefined,
    progressToken: meta[META_PROGRESS_TOKEN] as string | number | undefined,
    auth,
    canonicalUri: opts.canonicalUri,
    requestId,
    traceparent: typeof meta["traceparent"] === "string" ? meta["traceparent"] : undefined,
    notices: [],
  };

  if (source === "default") {
    ctx.notices.push(
      "No MCP-Protocol-Version header; assuming 2025-03-26. Send the header to pin a version.",
    );
  }

  // (11) Dispatch.
  const started = Date.now();
  try {
    const result = await dispatch({ jsonrpc: "2.0", id, method, params } as JsonRpcRequest, ctx, {
      handleSecret: env.HANDLE_SECRET,
    });

    if (!result["_meta"]) result["_meta"] = {};
    (result["_meta"] as Record<string, unknown>)[META_SERVER_INFO] ??= SERVER_INFO;

    const adapted = adaptResult(result, era, method);
    log(env, {
      level: "info",
      msg: "mcp_request",
      method,
      version,
      era,
      requestId,
      durationMs: Date.now() - started,
      subject: auth?.subject,
      client: ctx.clientInfo?.name,
    });

    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: adapted }), {
      status: 200,
      headers: baseHeaders(opts),
    });
  } catch (e) {
    if (e instanceof UnauthorizedError) return unauthorizedResponse(e, opts);

    if (e instanceof McpError) {
      log(env, { level: "warn", msg: "mcp_error", method, requestId, code: e.code });
      return jsonRpcErrorResponse(id, e.toBody(), e.httpStatus, opts);
    }

    // Anything unhandled is a bug. Log it with detail; return none.
    log(env, {
      level: "error",
      msg: "unhandled",
      method,
      requestId,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      stack: e instanceof Error ? e.stack?.slice(0, 2000) : undefined,
    });
    return jsonRpcErrorResponse(id, internalError().toBody(), 500, opts);
  }
}

const META_PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

/** `Mcp-Name` may be base64-encoded when the value is not ASCII-safe. */
function mcpNameMatches(headerValue: string, expected: string): boolean {
  if (headerValue === expected) return true;
  const m = /^=\?[Bb]\?(.*)\?=$/.exec(headerValue) ?? /^base64:(.*)$/.exec(headerValue);
  if (m?.[1]) {
    try {
      return new TextDecoder().decode(
        Uint8Array.from(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
      ) === expected;
    } catch {
      return false;
    }
  }
  return false;
}

async function authenticate(
  authorization: string,
  env: Env,
  canonicalUri: string,
  baseUrlHeader?: string | null,
) {
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m?.[1]) {
    throw new UnauthorizedError("Authorization header must be 'Bearer <token>'", "invalid_request");
  }
  const token = m[1].trim();

  // One of ours?
  if (token.startsWith("nmcp_")) {
    try {
      return await verifyToken(token, env.TOKEN_SECRET, canonicalUri);
    } catch (e) {
      if (e instanceof TokenError) {
        throw new UnauthorizedError(
          e.reason === "expired"
            ? "Access token has expired; refresh it."
            : e.reason === "audience"
              ? "Access token was not issued for this server."
              : "Access token is invalid.",
          "invalid_token",
        );
      }
      throw new UnauthorizedError("Access token is invalid.");
    }
  }

  // Otherwise treat it as a raw Nominal key (stdio bridge / direct mode).
  //
  // Nominal is deployed to GovCloud, commercial, private clouds and on-prem, so
  // the base URL cannot be hardcoded: a caller on any host other than the
  // GovCloud default would otherwise have every call silently sent to the wrong
  // deployment. The header is still validated against the host allowlist.
  const base = (baseUrlHeader ?? "").trim() || DEFAULT_NOMINAL_BASE;
  try {
    return await directAuth(token, base);
  } catch (e) {
    if (baseUrlHeader && e instanceof TokenError && e.reason === "host") {
      throw new UnauthorizedError(
        `X-Nominal-Base-Url is not an allowed Nominal host: ${baseUrlHeader}`,
        "invalid_request",
      );
    }
    throw new UnauthorizedError("Credential is not a valid MCP access token or Nominal API key.");
  }
}

function unauthorizedResponse(e: UnauthorizedError, opts: TransportOptions): Response {
  const params = [
    `error="${e.errorCode}"`,
    `error_description="${e.message.replace(/"/g, "'")}"`,
    `resource_metadata="${opts.origin}/.well-known/oauth-protected-resource"`,
    `scope="nominal:read nominal:write"`,
  ].join(", ");
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: ErrorCode.InvalidRequest, message: e.message },
    }),
    {
      status: 401,
      headers: { ...baseHeaders(opts), "www-authenticate": `Bearer ${params}` },
    },
  );
}

function idOf(msg: Record<string, unknown>): string | number | null {
  const id = msg["id"];
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function jsonRpcErrorResponse(
  id: string | number | null,
  error: { code: number; message: string; data?: unknown },
  status: number,
  opts: TransportOptions,
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error }), {
    status,
    headers: baseHeaders(opts),
  });
}

export function baseHeaders(opts: TransportOptions): Record<string, string> {
  return {
    "content-type": "application/json",
    "cache-control": "no-store",
    vary: "Origin, Authorization, MCP-Protocol-Version, X-Nominal-Base-Url",
    "x-content-type-options": "nosniff",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "referrer-policy": "no-referrer",
    // The Origin was already validated against the allowlist before we got
    // here, so echoing it is safe and is what a browser client needs.
    "access-control-allow-origin": opts.requestOrigin || opts.origin,
  };
}

function originAllowed(origin: string, env: Env, selfOrigin: string): boolean {
  if (origin === selfOrigin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // Local development hosts are always permitted.
  if (
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  ) {
    return true;
  }
  const extra = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes("*")) return true;
  return extra.includes(origin);
}

async function readBoundedText(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  return text;
}

function log(env: Env, fields: Record<string, unknown>): void {
  // Structured, and never carrying a credential — see SPEC.md §8.4.
  console.log(JSON.stringify({ ts: new Date().toISOString(), env: env.ENVIRONMENT, ...fields }));
}
