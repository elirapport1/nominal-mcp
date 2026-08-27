/**
 * Access-token minting and validation.
 *
 * Design: the access token is a self-contained AES-256-GCM envelope, not a
 * pointer into a session store. Validation is a decrypt + a few comparisons,
 * so the hot path touches no storage, which matters on Workers.
 *
 * The envelope custodies the user's own Nominal API key. That key is the only
 * credential ever presented to Nominal — there is no service account, and the
 * MCP layer never widens what the user could already do.
 *
 * Token format:  nmcp_<base64url(iv ‖ ciphertext ‖ tag)>
 */
import { b64urlDecode, b64urlEncode, constantTimeEqual } from "../util/encoding.js";

export type Scope = "nominal:read" | "nominal:write" | "nominal:admin";
export const ALL_SCOPES: Scope[] = ["nominal:read", "nominal:write", "nominal:admin"];

export const TOKEN_PREFIX = "nmcp_";

/** Hosts a Nominal credential may be sent to. Anything else is SSRF. */
export const ALLOWED_NOMINAL_HOSTS = [
  "api.gov.nominal.io",
  "api.nominal.io",
  "api-staging.nominal.io",
];

export interface TokenEnvelope {
  /** Stable per-user subject: SHA-256 of the API key, hex, first 32 chars. */
  sub: string;
  /** The user's Nominal API key. Never leaves this envelope in plaintext. */
  key: string;
  /** Nominal API base URL this key belongs to. */
  base: string;
  scopes: Scope[];
  /** RFC 8707 audience: the canonical URI of this MCP server. */
  aud: string;
  /** Seconds since epoch. */
  exp: number;
  iat: number;
  /** Unique token id, for logging and refresh-token revocation. */
  jti: string;
  /** OAuth client this token was issued to, when minted via the OAuth flow. */
  client_id?: string;
}

/** What handlers actually see. The raw key stays in `credential`. */
export interface AuthContext {
  subject: string;
  credential: string;
  baseUrl: string;
  scopes: Scope[];
  jti: string;
  expiresAt: number;
  clientId?: string;
  /** "oauth" = minted by us; "direct" = a raw Nominal key passed through. */
  mode: "oauth" | "direct";
}

export function hasScope(ctx: AuthContext, scope: Scope): boolean {
  if (ctx.scopes.includes(scope)) return true;
  // admin implies read+write; write implies read.
  if (scope === "nominal:read") {
    return ctx.scopes.includes("nominal:write") || ctx.scopes.includes("nominal:admin");
  }
  if (scope === "nominal:write") return ctx.scopes.includes("nominal:admin");
  return false;
}

async function importKey(secret: string): Promise<CryptoKey> {
  // Derive a fixed-length key from the configured secret so operators are not
  // forced to supply exactly 32 bytes.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function subjectFor(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export async function mintToken(
  envelope: Omit<TokenEnvelope, "jti" | "iat"> & { jti?: string },
  secret: string,
): Promise<string> {
  const full: TokenEnvelope = {
    ...envelope,
    iat: Math.floor(Date.now() / 1000),
    jti: envelope.jti ?? crypto.randomUUID(),
  };
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(full));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return TOKEN_PREFIX + b64urlEncode(out);
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "malformed"
      | "undecryptable"
      | "expired"
      | "audience"
      | "host",
  ) {
    super(message);
    this.name = "TokenError";
  }
}

export async function verifyToken(
  token: string,
  secret: string,
  canonicalUri: string,
): Promise<AuthContext> {
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new TokenError("Token is not an MCP access token", "malformed");
  }
  const raw = token.slice(TOKEN_PREFIX.length);

  let bytes: Uint8Array;
  try {
    bytes = b64urlDecode(raw);
  } catch {
    throw new TokenError("Token is not valid base64url", "malformed");
  }
  if (bytes.length < 12 + 16 + 2) {
    throw new TokenError("Token is truncated", "malformed");
  }

  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const key = await importKey(secret);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  } catch {
    // Covers forgery, bit-flips, and tokens minted under a different secret.
    throw new TokenError("Token authentication failed", "undecryptable");
  }

  let env: TokenEnvelope;
  try {
    env = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new TokenError("Token payload is not JSON", "undecryptable");
  }

  if (
    typeof env.key !== "string" ||
    typeof env.base !== "string" ||
    typeof env.aud !== "string" ||
    typeof env.exp !== "number" ||
    !Array.isArray(env.scopes)
  ) {
    throw new TokenError("Token payload is malformed", "malformed");
  }

  if (env.exp * 1000 <= Date.now()) {
    throw new TokenError("Token has expired", "expired");
  }

  // RFC 8707 audience binding. A token minted for another MCP server MUST NOT
  // be accepted here, even if it decrypts — this is the confused-deputy case.
  if (!constantTimeEqual(env.aud, canonicalUri)) {
    throw new TokenError(
      `Token audience ${env.aud} does not match this server`,
      "audience",
    );
  }

  assertAllowedHost(env.base);

  return {
    subject: env.sub,
    credential: env.key,
    baseUrl: env.base,
    scopes: env.scopes.filter((s): s is Scope => ALL_SCOPES.includes(s as Scope)),
    jti: env.jti,
    expiresAt: env.exp,
    clientId: env.client_id,
    mode: "oauth",
  };
}

/** Rejects any base URL that is not a known Nominal API host. */
export function assertAllowedHost(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TokenError(`Invalid base URL: ${baseUrl}`, "host");
  }
  if (url.protocol !== "https:") {
    throw new TokenError("Nominal base URL must use https", "host");
  }
  const host = url.hostname.toLowerCase();
  const ok =
    ALLOWED_NOMINAL_HOSTS.includes(host) ||
    (host.endsWith(".nominal.io") && !host.includes(".."));
  if (!ok) {
    throw new TokenError(`Host not allowed: ${host}`, "host");
  }
  return url;
}

/**
 * Direct mode: the caller presents a raw Nominal API key instead of one of our
 * tokens. Used by the stdio bridge and by operators who would rather not run
 * the OAuth flow. Grants read+write; the key itself is what Nominal enforces.
 */
export async function directAuth(
  apiKey: string,
  baseUrl: string,
): Promise<AuthContext> {
  assertAllowedHost(baseUrl);
  return {
    subject: await subjectFor(apiKey),
    credential: apiKey,
    baseUrl,
    scopes: ["nominal:read", "nominal:write"],
    jti: "direct",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    mode: "direct",
  };
}
