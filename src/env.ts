/** Worker bindings. Secrets come from `wrangler secret put`, never from source. */
export interface Env {
  /** AES-GCM key material for access-token envelopes. REQUIRED. */
  TOKEN_SECRET: string;
  /** HMAC key for result handles. REQUIRED. */
  HANDLE_SECRET: string;
  /** KV: OAuth clients, auth codes, refresh tokens, rate-limit counters. */
  OAUTH_KV: KVNamespace;
  /** Public origin, e.g. https://nominal-mcp.example.workers.dev. Optional; inferred otherwise. */
  PUBLIC_ORIGIN?: string;
  /** Comma-separated extra allowed Origins for browser clients. */
  ALLOWED_ORIGINS?: string;
  /** "1" to reject requests with no MCP-Protocol-Version header. */
  STRICT_HEADERS?: string;
  /** Requests per minute per subject. Default 120. */
  RATE_LIMIT_RPM?: string;
  /**
   * Cloudflare native rate limiter. Optional: absent in local dev and in forks
   * that have not declared it, in which case an in-isolate fallback is used.
   */
  RATE_LIMITER?: import("./limits/ratelimit.js").RateLimiterBinding;
  ENVIRONMENT?: string;
  /** Commit the running build came from; set at deploy time. */
  GIT_SHA?: string;
}
