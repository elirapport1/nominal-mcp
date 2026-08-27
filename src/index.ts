/**
 * Worker entry point.
 *
 * Routes:
 *   POST /mcp                                        MCP endpoint (Streamable HTTP)
 *   GET  /.well-known/oauth-protected-resource       RFC 9728
 *   GET  /.well-known/oauth-authorization-server     RFC 8414
 *   GET  /.well-known/openid-configuration           alias, some clients probe it
 *   GET|POST /authorize                              OAuth 2.1 + consent
 *   POST /token, /register, /revoke                  OAuth 2.1
 *   GET  /health, /                                  liveness + landing page
 */
import { handleMcpPost, baseHeaders } from "./transport/http.js";
import {
  authorizationServerMetadata,
  handleAuthorize,
  handleRegister,
  handleRevoke,
  handleToken,
  protectedResourceMetadata,
} from "./auth/oauth.js";
import { TOOL_DEFINITIONS, SERVER_INFO } from "./transport/handler.js";
import { CATALOG_STATS } from "./tools/catalog.js";
import { landingPage } from "./landing.js";
import { checkRateLimit, limiterKind, rateLimitResponse } from "./limits/ratelimit.js";
import type { Env } from "./env.js";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = (env.PUBLIC_ORIGIN ?? url.origin).replace(/\/$/, "");
    const canonicalUri = `${origin}/mcp`;
    const opts = { canonicalUri, origin };

    // Fail closed if the deployment is missing its secrets.
    if (!env.TOKEN_SECRET || !env.HANDLE_SECRET) {
      return json(
        {
          error: "server_misconfigured",
          detail: "TOKEN_SECRET and HANDLE_SECRET must be set (wrangler secret put).",
        },
        500,
      );
    }

    if (req.method === "OPTIONS") return preflight(req, origin);

    try {
      switch (url.pathname) {
        case "/mcp":
          if (req.method === "POST") {
            const rpm = Number(env.RATE_LIMIT_RPM ?? "120");
            const rate = await checkRateLimit(req, env.RATE_LIMITER, rpm);
            if (!rate.allowed) return rateLimitResponse(rate, rpm);
            return handleMcpPost(req, env, opts);
          }
          // The GET stream endpoint was removed in 2026-07-28.
          return json(
            {
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32601,
                message:
                  "The MCP endpoint accepts POST only. The GET stream endpoint was removed in protocol version 2026-07-28.",
              },
            },
            405,
            { allow: "POST, OPTIONS" },
          );

        case "/.well-known/oauth-protected-resource":
        case "/.well-known/oauth-protected-resource/mcp":
          return json(protectedResourceMetadata(canonicalUri, origin), 200, {
            "cache-control": "public, max-age=3600",
          });

        case "/.well-known/oauth-authorization-server":
        case "/.well-known/oauth-authorization-server/mcp":
        case "/.well-known/openid-configuration":
          return json(authorizationServerMetadata(origin), 200, {
            "cache-control": "public, max-age=3600",
          });

        case "/authorize":
          return handleAuthorize(req, env, canonicalUri, origin);

        case "/token":
          return handleToken(req, env, canonicalUri);

        case "/register":
          if (req.method !== "POST") return json({ error: "invalid_request" }, 405);
          return handleRegister(req, env);

        case "/revoke":
          if (req.method !== "POST") return json({ error: "invalid_request" }, 405);
          return handleRevoke(req, env);

        case "/health":
          return json({
            status: "ok",
            server: SERVER_INFO,
            // Lets a smoke test confirm it is talking to the build it just shipped.
            commit: env.GIT_SHA ?? "unknown",
            environment: env.ENVIRONMENT ?? "unknown",
            protocol_versions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"],
            tools: TOOL_DEFINITIONS.length,
            api_operations: CATALOG_STATS.total,
            rate_limiter: limiterKind(env.RATE_LIMITER, Number(env.RATE_LIMIT_RPM ?? "120")),
            time: new Date().toISOString(),
          });

        case "/":
          return new Response(landingPage(origin), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });

        default:
          return json({ error: "not_found", path: url.pathname }, 404);
      }
    } catch (e) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "unhandled_worker_error",
          path: url.pathname,
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        }),
      );
      return json({ error: "internal_error" }, 500);
    }
  },
};

function preflight(req: Request, origin: string): Response {
  const requested = req.headers.get("access-control-request-headers");
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": req.headers.get("origin") ?? origin,
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers":
        requested ?? "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
      "access-control-max-age": "86400",
      vary: "Origin",
    },
  });
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

export { baseHeaders };
