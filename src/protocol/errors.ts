/**
 * JSON-RPC / MCP error codes and constructors.
 *
 * The 2026-07-28 revision partitions the implementation-defined range:
 *   -32000..-32019  legacy, grandfathered, MUST NOT allocate new codes here
 *   -32020..-32099  reserved for the MCP specification
 *
 * Codes renumbered in this revision (were -32001/-32003/-32004 in the draft):
 *   -32020 HeaderMismatch
 *   -32021 MissingRequiredClientCapability
 *   -32022 UnsupportedProtocolVersion
 *
 * Resource-not-found moved -32002 -> -32602. We MUST NOT emit -32002 when
 * serving a 2026-07-28 client, but SHOULD still emit it to legacy clients that
 * expect it. `resourceNotFound()` takes the era for exactly that reason.
 */
import type { Era, JsonRpcErrorBody } from "./types.js";

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Legacy resource-not-found. Emitted only to legacy clients. */
  LegacyResourceNotFound: -32002,
  HeaderMismatch: -32020,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,
} as const;

/**
 * An error that carries both a JSON-RPC code and the HTTP status the transport
 * spec mandates for it. The status is not always 400 — an unimplemented method
 * MUST be 404 so clients can distinguish it from a legacy HTTP+SSE server.
 */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus: number = 400,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }

  toBody(): JsonRpcErrorBody {
    const body: JsonRpcErrorBody = { code: this.code, message: this.message };
    if (this.data !== undefined) body.data = this.data;
    return body;
  }
}

export const parseError = (detail?: string) =>
  new McpError(ErrorCode.ParseError, `Parse error${detail ? `: ${detail}` : ""}`, 400);

export const invalidRequest = (message: string) =>
  new McpError(ErrorCode.InvalidRequest, message, 400);

/** Per transport spec: unknown method MUST be HTTP 404 with code -32601. */
export const methodNotFound = (method: string) =>
  new McpError(ErrorCode.MethodNotFound, `Method not found: ${method}`, 404);

export const invalidParams = (message: string, data?: unknown) =>
  new McpError(ErrorCode.InvalidParams, message, 400, data);

export const internalError = (message = "Internal error") =>
  new McpError(ErrorCode.InternalError, message, 500);

export const headerMismatch = (header: string, headerValue: string, bodyValue: string) =>
  new McpError(
    ErrorCode.HeaderMismatch,
    `Header ${header} (${headerValue}) does not match the corresponding request body value (${bodyValue})`,
    400,
    { header, headerValue, bodyValue },
  );

export const unsupportedProtocolVersion = (requested: string, supported: readonly string[]) =>
  new McpError(
    ErrorCode.UnsupportedProtocolVersion,
    `Unsupported protocol version: ${requested}`,
    400,
    { requested, supportedVersions: supported },
  );

export const missingClientCapability = (required: string[]) =>
  new McpError(
    ErrorCode.MissingRequiredClientCapability,
    `Request requires client capabilities not declared: ${required.join(", ")}`,
    400,
    { requiredCapabilities: required },
  );

/** -32602 for modern clients, -32002 for legacy ones that still expect it. */
export const resourceNotFound = (uri: string, era: Era) =>
  era === "modern"
    ? new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`, 400, { uri })
    : new McpError(ErrorCode.LegacyResourceNotFound, `Resource not found: ${uri}`, 400, { uri });

/**
 * Raised when a request carries no usable credential. The transport turns this
 * into a 401 with a `WWW-Authenticate` challenge; it is not a JSON-RPC error
 * with a body the model should read.
 */
export class UnauthorizedError extends Error {
  constructor(
    message = "Authorization required",
    readonly errorCode: "invalid_token" | "insufficient_scope" | "invalid_request" = "invalid_token",
    readonly requiredScopes?: string[],
  ) {
    super(message);
    this.name = "UnauthorizedError";
  }
}
