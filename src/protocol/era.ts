/**
 * Protocol era detection and response adaptation.
 *
 * Handlers always build a *modern* (2026-07-28) result. This module downgrades
 * it on the way out for legacy clients. Keeping the difference in one place is
 * what makes supporting five protocol revisions tractable.
 *
 * The differences that actually matter:
 *
 *              | 2026-07-28        | <= 2025-11-25
 *   -----------|-------------------|---------------------------
 *   handshake  | none (stateless)  | initialize + initialized
 *   discovery  | server/discover   | initialize result
 *   resultType | required          | must not be present
 *   ttlMs      | required on 6 ops | not defined
 *   cacheScope | required on 6 ops | not defined
 *   ping       | removed           | present
 *   setLevel   | removed (_meta)   | logging/setLevel
 *   not-found  | -32602            | -32002
 */
import {
  PROTOCOL_2024_11_05,
  PROTOCOL_2025_03_26,
  PROTOCOL_2026_07_28,
  SUPPORTED_VERSIONS,
  META_PROTOCOL_VERSION,
  type Era,
  type ProtocolVersion,
} from "./types.js";

export function isSupportedVersion(v: string): v is ProtocolVersion {
  return (SUPPORTED_VERSIONS as readonly string[]).includes(v);
}

export function eraFor(version: string): Era {
  return version === PROTOCOL_2026_07_28 ? "modern" : "legacy";
}

/**
 * Resolve the protocol version for a request from, in priority order:
 *   1. `_meta["io.modelcontextprotocol/protocolVersion"]`  (modern)
 *   2. `params.protocolVersion`                            (legacy `initialize`)
 *   3. the `MCP-Protocol-Version` header
 *   4. 2025-03-26 — the fallback the transport spec permits for pre-2025-06-18
 *      clients, which did not send the header at all.
 */
export function resolveVersion(
  headerVersion: string | null,
  body: { method?: string; params?: Record<string, unknown> },
): { version: string; source: "meta" | "params" | "header" | "default" } {
  const meta = body.params?.["_meta"] as Record<string, unknown> | undefined;
  const metaVersion = meta?.[META_PROTOCOL_VERSION];
  if (typeof metaVersion === "string") return { version: metaVersion, source: "meta" };

  if (body.method === "initialize") {
    const p = body.params?.["protocolVersion"];
    if (typeof p === "string") return { version: p, source: "params" };
  }

  if (headerVersion) return { version: headerVersion, source: "header" };
  return { version: PROTOCOL_2025_03_26, source: "default" };
}

/**
 * Pick the version to answer a legacy `initialize` with. If the client asked
 * for something we support, echo it back; otherwise offer our best legacy
 * version and let the client decide whether to proceed.
 */
export function negotiateLegacyVersion(requested: string): string {
  if (isSupportedVersion(requested) && requested !== PROTOCOL_2026_07_28) return requested;
  if (requested === PROTOCOL_2026_07_28) return PROTOCOL_2026_07_28;
  return PROTOCOL_2025_03_26;
}

/** Methods that exist only in one era. */
// `subscriptions/listen` is deliberately absent: every list this server
// exposes is static (`listChanged: false`) and resource subscriptions are off,
// so there is nothing to push. Holding a long-lived SSE stream open per client
// to deliver notifications that can never arrive would cost a running instance
// for no benefit. Clients get -32601, which is the honest answer.
const MODERN_ONLY = new Set(["server/discover"]);
const LEGACY_ONLY = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "logging/setLevel",
  "resources/subscribe",
  "resources/unsubscribe",
]);

export function methodAvailable(method: string, era: Era): boolean {
  if (MODERN_ONLY.has(method)) return era === "modern";
  if (LEGACY_ONLY.has(method)) return era === "legacy";
  return true;
}

/** The six operations that MUST carry cache hints in 2026-07-28. */
export const CACHEABLE_METHODS = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
]);

/**
 * Downgrade a modern result for the wire.
 *
 * Legacy clients validate results against an older schema, and both
 * `resultType` and the cache fields are unknown to them. Some strict clients
 * reject unknown top-level fields outright, so they are removed rather than
 * left in place.
 */
export function adaptResult(
  result: Record<string, unknown>,
  era: Era,
  method: string,
): Record<string, unknown> {
  if (era === "modern") {
    // `resultType` defaults to "complete" unless a handler set it (MRTR).
    if (!("resultType" in result)) result["resultType"] = "complete";

    // Enforce the cache-hint MUST rather than trusting each handler.
    if (CACHEABLE_METHODS.has(method) && result["resultType"] === "complete") {
      if (typeof result["ttlMs"] !== "number" || (result["ttlMs"] as number) < 0) {
        result["ttlMs"] = 0;
      }
      if (result["cacheScope"] !== "public" && result["cacheScope"] !== "private") {
        result["cacheScope"] = "private";
      }
    }
    return result;
  }

  // Legacy: strip fields the older schemas do not define.
  const { resultType: _rt, ttlMs: _ttl, cacheScope: _cs, ...rest } = result as Record<
    string,
    unknown
  >;
  void _rt;
  void _ttl;
  void _cs;

  // 2024-11-05 predates structuredContent; fold it into text so nothing is lost.
  if (era === "legacy" && "structuredContent" in rest && !("content" in rest)) {
    rest["content"] = [{ type: "text", text: JSON.stringify(rest["structuredContent"]) }];
  }
  return rest;
}

/**
 * 2024-11-05 has no `resource_link` content block. Rewrite links as text so an
 * old client renders something meaningful instead of dropping the block.
 */
export function adaptContentForVersion(
  content: unknown[],
  version: string,
): unknown[] {
  if (version !== PROTOCOL_2024_11_05) return content;
  return content.map((block) => {
    const b = block as { type?: string; uri?: string; name?: string };
    if (b.type === "resource_link") {
      return { type: "text", text: `${b.name ?? "resource"}: ${b.uri ?? ""}` };
    }
    return block;
  });
}
