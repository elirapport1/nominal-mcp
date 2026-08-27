/**
 * OAuth 2.1 authorization server + resource server.
 *
 * Nominal issues per-user API keys and is not an OAuth AS, so this Worker hosts
 * a minimal AS whose only job is to bind a key the user already owns to a
 * scoped, audience-bound, expiring MCP access token. The user's key is the only
 * credential ever presented to Nominal.
 *
 * Implements: RFC 9728 (protected resource metadata), RFC 8414 (AS metadata),
 * RFC 7636 (PKCE, S256 only), RFC 8707 (resource indicators), RFC 9207 (iss),
 * RFC 7591 (DCR, deprecated but kept for compat), and Client ID Metadata
 * Documents, which 2026-07-28 prefers over DCR.
 */
import {
  ALL_SCOPES,
  assertAllowedHost,
  mintToken,
  subjectFor,
  type Scope,
} from "./token.js";
import { escapeHtml, sha256B64Url, constantTimeEqual } from "../util/encoding.js";
import type { Env } from "../env.js";

const ACCESS_TOKEN_TTL = 3600; // 1 h
const REFRESH_TOKEN_TTL = 30 * 24 * 3600; // 30 d
const AUTH_CODE_TTL = 60; // s — one-time, short

export const DEFAULT_NOMINAL_BASE = "https://api.gov.nominal.io/api";

// ---------------------------------------------------------------------------
// Discovery metadata
// ---------------------------------------------------------------------------

/** RFC 9728 — how a client finds the AS for this resource. */
export function protectedResourceMetadata(canonicalUri: string, origin: string) {
  return {
    resource: canonicalUri,
    authorization_servers: [origin],
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Nominal MCP Server",
    resource_documentation: "https://github.com/elirapport1/nominal-mcp",
    tls_client_certificate_bound_access_tokens: false,
  };
}

/** RFC 8414 — AS metadata. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/revoke`,
    scopes_supported: ALL_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    // OAuth 2.1: PKCE is mandatory and `plain` is not offered.
    code_challenge_methods_supported: ["S256"],
    // RFC 9207 — we always return `iss`, so clients can validate it.
    authorization_response_iss_parameter_supported: true,
    // RFC 8707
    resource_indicators_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: "https://github.com/elirapport1/nominal-mcp",
  };
}

// ---------------------------------------------------------------------------
// Client registration
// ---------------------------------------------------------------------------

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  application_type: "native" | "web";
  token_endpoint_auth_method: string;
  created_at: number;
}

/**
 * Client ID Metadata Documents: the client_id is itself an https URL pointing
 * at a JSON document describing the client. Preferred over DCR since
 * 2026-07-28. We fetch and validate it, with the SSRF guards the spec asks for.
 */
export async function resolveClientIdMetadataDocument(
  clientId: string,
): Promise<RegisteredClient | null> {
  if (!clientId.startsWith("https://")) return null;

  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  // No loopback / link-local / private targets.
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]" ||
    host === "::1"
  ) {
    return null;
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);

  if (!res || !res.ok) return null;
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > 64 * 1024) return null;

  const doc = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!doc) return null;

  // The document MUST self-identify with the same client_id it was fetched from.
  if (typeof doc["client_id"] === "string" && doc["client_id"] !== clientId) return null;

  const uris = Array.isArray(doc["redirect_uris"])
    ? (doc["redirect_uris"] as unknown[]).filter((u): u is string => typeof u === "string")
    : [];
  if (uris.length === 0) return null;

  return {
    client_id: clientId,
    client_name: typeof doc["client_name"] === "string" ? doc["client_name"] : undefined,
    redirect_uris: uris,
    application_type:
      doc["application_type"] === "web" ? "web" : "native",
    token_endpoint_auth_method: "none",
    created_at: Math.floor(Date.now() / 1000),
  };
}

/** RFC 7591 dynamic client registration. Deprecated by the spec, kept for compat. */
export async function handleRegister(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return oauthError("invalid_client_metadata", "Body must be JSON", 400);

  const uris = Array.isArray(body["redirect_uris"])
    ? (body["redirect_uris"] as unknown[]).filter((u): u is string => typeof u === "string")
    : [];
  if (uris.length === 0) {
    return oauthError("invalid_redirect_uri", "redirect_uris is required", 400);
  }
  for (const u of uris) {
    if (!isValidRedirectUri(u)) {
      return oauthError("invalid_redirect_uri", `Invalid redirect_uri: ${u}`, 400);
    }
  }

  // 2026-07-28 requires clients to state application_type to avoid the OIDC
  // redirect-URI conflict between native and web clients.
  const appType = body["application_type"];
  if (appType !== "native" && appType !== "web") {
    return oauthError(
      "invalid_client_metadata",
      "application_type is required and must be 'native' or 'web'",
      400,
    );
  }

  const client: RegisteredClient = {
    client_id: `dcr_${crypto.randomUUID()}`,
    client_name:
      typeof body["client_name"] === "string" ? body["client_name"].slice(0, 200) : undefined,
    redirect_uris: uris.slice(0, 10),
    application_type: appType,
    token_endpoint_auth_method: "none",
    created_at: Math.floor(Date.now() / 1000),
  };

  await env.OAUTH_KV.put(`client:${client.client_id}`, JSON.stringify(client), {
    expirationTtl: 90 * 24 * 3600,
  });

  return json(
    {
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      application_type: client.application_type,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: client.created_at,
    },
    201,
  );
}

function isValidRedirectUri(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash) return false;
  // https anywhere; http only for loopback (native clients); custom schemes ok.
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && url.protocol !== "javascript:";
}

async function loadClient(clientId: string, env: Env): Promise<RegisteredClient | null> {
  if (clientId.startsWith("https://")) {
    return resolveClientIdMetadataDocument(clientId);
  }
  const raw = await env.OAUTH_KV.get(`client:${clientId}`);
  return raw ? (JSON.parse(raw) as RegisteredClient) : null;
}

// ---------------------------------------------------------------------------
// /authorize
// ---------------------------------------------------------------------------

interface PendingAuth {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  scopes: Scope[];
  resource: string;
}

export async function handleAuthorize(
  req: Request,
  env: Env,
  canonicalUri: string,
  origin: string,
): Promise<Response> {
  // The consent form POSTs back with no query string, so the POST branch must
  // come before any query-parameter validation.
  if (req.method === "POST") return completeAuthorize(req, env, origin);
  if (req.method !== "GET") return htmlError("Method not allowed", 405);

  const url = new URL(req.url);
  const q = url.searchParams;

  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri");
  const responseType = q.get("response_type");
  const codeChallenge = q.get("code_challenge");
  const codeChallengeMethod = q.get("code_challenge_method");
  const resource = q.get("resource");
  const state = q.get("state") ?? undefined;

  if (!clientId) return htmlError("Missing client_id", 400);
  const client = await loadClient(clientId, env);
  if (!client) return htmlError("Unknown or unresolvable client_id", 400);

  // redirect_uri must match one the client registered. Errors before this point
  // cannot be redirected back — they are shown to the user instead.
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return htmlError("redirect_uri does not match a registered URI for this client", 400);
  }

  const fail = (code: string, desc: string) =>
    redirectError(redirectUri, code, desc, state, origin);

  if (responseType !== "code") return fail("unsupported_response_type", "response_type must be 'code'");
  // OAuth 2.1: PKCE required, S256 only.
  if (!codeChallenge) return fail("invalid_request", "code_challenge is required (PKCE)");
  if (codeChallengeMethod !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeChallenge)) {
    return fail("invalid_request", "malformed code_challenge");
  }

  // RFC 8707: the client must say which resource the token is for, and it must
  // be us. Without this a token minted here could be replayed elsewhere.
  if (!resource) return fail("invalid_target", "resource parameter is required (RFC 8707)");
  if (!resourceMatches(resource, canonicalUri)) {
    return fail("invalid_target", `resource must be ${canonicalUri}`);
  }

  const requested = (q.get("scope") ?? "nominal:read nominal:write")
    .split(/\s+/)
    .filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s));
  if (requested.length === 0) return fail("invalid_scope", "No valid scopes requested");

  {
    const pendingId = crypto.randomUUID();
    const pending: PendingAuth = {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      state,
      scopes: requested,
      resource,
    };
    await env.OAUTH_KV.put(`pending:${pendingId}`, JSON.stringify(pending), {
      expirationTtl: 600,
    });
    return consentPage(pendingId, client, requested, origin);
  }
}

/** The user pastes their own Nominal key here; we verify it before issuing a code. */
async function completeAuthorize(req: Request, env: Env, origin: string): Promise<Response> {
  const form = await req.formData().catch(() => null);
  if (!form) return htmlError("Invalid form submission", 400);

  const pendingId = String(form.get("pending") ?? "");
  const apiKey = String(form.get("api_key") ?? "").trim();
  const baseUrl = String(form.get("base_url") ?? DEFAULT_NOMINAL_BASE).trim();

  const raw = await env.OAUTH_KV.get(`pending:${pendingId}`);
  if (!raw) return htmlError("This authorization request expired. Start over.", 400);
  const pending = JSON.parse(raw) as PendingAuth;

  if (!apiKey) return consentPageError(pendingId, "Enter your Nominal API key.", origin);
  try {
    assertAllowedHost(baseUrl);
  } catch {
    return consentPageError(pendingId, "Base URL is not a recognized Nominal host.", origin);
  }

  // Verify the key actually works before minting anything, so failures surface
  // here rather than as a confusing 401 on the first tool call.
  const ok = await verifyNominalKey(apiKey, baseUrl);
  if (!ok) {
    return consentPageError(
      pendingId,
      "Nominal rejected that API key. Check the key and base URL under Settings → API keys.",
      origin,
    );
  }

  await env.OAUTH_KV.delete(`pending:${pendingId}`);

  const code = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await env.OAUTH_KV.put(
    `code:${code}`,
    JSON.stringify({
      ...pending,
      api_key: apiKey,
      base_url: baseUrl,
      sub: await subjectFor(apiKey),
    }),
    { expirationTtl: AUTH_CODE_TTL },
  );

  const back = new URL(pending.redirect_uri);
  back.searchParams.set("code", code);
  if (pending.state) back.searchParams.set("state", pending.state);
  // RFC 9207 — always present, and advertised in AS metadata.
  back.searchParams.set("iss", origin);
  return Response.redirect(back.toString(), 302);
}

/** A cheap authenticated call that tells us whether the key is live. */
async function verifyNominalKey(apiKey: string, baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/units/v1/units`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    // Anything other than an auth rejection means the credential was accepted.
    return res.status !== 401 && res.status !== 403;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// /token
// ---------------------------------------------------------------------------

export async function handleToken(
  req: Request,
  env: Env,
  canonicalUri: string,
): Promise<Response> {
  if (req.method !== "POST") return oauthError("invalid_request", "POST required", 405);
  const form = await req.formData().catch(() => null);
  if (!form) return oauthError("invalid_request", "Body must be form-encoded", 400);

  const grantType = String(form.get("grant_type") ?? "");
  const resource = form.get("resource") ? String(form.get("resource")) : null;

  // RFC 8707 applies at the token endpoint too.
  if (resource && !resourceMatches(resource, canonicalUri)) {
    return oauthError("invalid_target", `resource must be ${canonicalUri}`, 400);
  }

  if (grantType === "authorization_code") {
    return exchangeCode(form, env, canonicalUri);
  }
  if (grantType === "refresh_token") {
    return refreshGrant(form, env, canonicalUri);
  }
  return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grantType}`, 400);
}

async function exchangeCode(
  form: FormData,
  env: Env,
  canonicalUri: string,
): Promise<Response> {
  const code = String(form.get("code") ?? "");
  const verifier = String(form.get("code_verifier") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");

  if (!code) return oauthError("invalid_request", "code is required", 400);
  if (!verifier) return oauthError("invalid_request", "code_verifier is required", 400);

  const raw = await env.OAUTH_KV.get(`code:${code}`);
  if (!raw) return oauthError("invalid_grant", "Authorization code is invalid or expired", 400);

  // One-time use. Delete before validating anything else so a replay attempt
  // cannot win a race against a concurrent legitimate exchange.
  await env.OAUTH_KV.delete(`code:${code}`);

  const rec = JSON.parse(raw) as PendingAuth & {
    api_key: string;
    base_url: string;
    sub: string;
  };

  if (!constantTimeEqual(rec.client_id, clientId)) {
    return oauthError("invalid_grant", "client_id does not match the authorization request", 400);
  }
  if (redirectUri && !constantTimeEqual(rec.redirect_uri, redirectUri)) {
    return oauthError("invalid_grant", "redirect_uri does not match the authorization request", 400);
  }

  // PKCE S256 verification.
  const challenge = await sha256B64Url(verifier);
  if (!constantTimeEqual(challenge, rec.code_challenge)) {
    return oauthError("invalid_grant", "PKCE verification failed", 400);
  }

  return issueTokens(rec, env, canonicalUri);
}

async function refreshGrant(
  form: FormData,
  env: Env,
  canonicalUri: string,
): Promise<Response> {
  const refresh = String(form.get("refresh_token") ?? "");
  if (!refresh) return oauthError("invalid_request", "refresh_token is required", 400);

  const raw = await env.OAUTH_KV.get(`refresh:${refresh}`);
  if (!raw) return oauthError("invalid_grant", "Refresh token is invalid or expired", 400);

  // Rotate: a refresh token is single-use.
  await env.OAUTH_KV.delete(`refresh:${refresh}`);

  const rec = JSON.parse(raw) as PendingAuth & {
    api_key: string;
    base_url: string;
    sub: string;
  };
  return issueTokens(rec, env, canonicalUri);
}

async function issueTokens(
  rec: PendingAuth & { api_key: string; base_url: string; sub: string },
  env: Env,
  canonicalUri: string,
): Promise<Response> {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL;
  const accessToken = await mintToken(
    {
      sub: rec.sub,
      key: rec.api_key,
      base: rec.base_url,
      scopes: rec.scopes,
      aud: canonicalUri,
      exp,
      client_id: rec.client_id,
    },
    env.TOKEN_SECRET,
  );

  const refreshToken =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await env.OAUTH_KV.put(`refresh:${refreshToken}`, JSON.stringify(rec), {
    expirationTtl: REFRESH_TOKEN_TTL,
  });

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope: rec.scopes.join(" "),
  });
}

export async function handleRevoke(req: Request, env: Env): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const token = form ? String(form.get("token") ?? "") : "";
  if (token) await env.OAUTH_KV.delete(`refresh:${token}`);
  // RFC 7009: always 200, even for unknown tokens.
  return new Response(null, { status: 200 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * RFC 8707 canonical-URI comparison. Scheme and host are case-insensitive;
 * a trailing slash is not significant; everything else must match exactly.
 */
export function resourceMatches(provided: string, canonical: string): boolean {
  const norm = (s: string) => {
    try {
      const u = new URL(s);
      const path = u.pathname.replace(/\/$/, "");
      return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}`;
    } catch {
      return s.toLowerCase().replace(/\/$/, "");
    }
  };
  return norm(provided) === norm(canonical);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

function oauthError(error: string, description: string, status: number): Response {
  return json({ error, error_description: description }, status);
}

function redirectError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined,
  origin: string,
): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  // RFC 9207: `iss` on error responses too.
  u.searchParams.set("iss", origin);
  return Response.redirect(u.toString(), 302);
}

function htmlError(message: string, status: number): Response {
  return new Response(shell(`<h1>Authorization error</h1><p class="err">${escapeHtml(message)}</p>`), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function consentPageError(pendingId: string, message: string, origin: string): Response {
  return new Response(
    shell(consentForm(pendingId, null, [], origin, message)),
    { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function consentPage(
  pendingId: string,
  client: RegisteredClient,
  scopes: Scope[],
  origin: string,
): Response {
  return new Response(shell(consentForm(pendingId, client, scopes, origin, null)), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The page takes a secret; lock it down.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

function consentForm(
  pendingId: string,
  client: RegisteredClient | null,
  scopes: Scope[],
  origin: string,
  error: string | null,
): string {
  const name = client?.client_name ?? "An MCP client";
  const scopeRows = scopes
    .map((s) => {
      const label =
        s === "nominal:read"
          ? "Read your assets, runs, channels, and telemetry"
          : s === "nominal:write"
            ? "Create and update events, annotations, and metadata"
            : "Administrative operations";
      return `<li><code>${escapeHtml(s)}</code><span>${escapeHtml(label)}</span></li>`;
    })
    .join("");

  return `
  <h1>Connect Nominal</h1>
  <p class="sub"><strong>${escapeHtml(name)}</strong> is requesting access to your Nominal account.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  ${scopes.length ? `<ul class="scopes">${scopeRows}</ul>` : ""}
  <form method="POST" action="${escapeHtml(origin)}/authorize" autocomplete="off">
    <input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
    <label for="api_key">Nominal API key</label>
    <input id="api_key" name="api_key" type="password" required autocomplete="off"
           spellcheck="false" placeholder="paste your key">
    <p class="hint">Settings &rarr; API keys, in the Nominal app.</p>
    <label for="base_url">API base URL</label>
    <input id="base_url" name="base_url" type="text" value="${escapeHtml(DEFAULT_NOMINAL_BASE)}"
           spellcheck="false">
    <button type="submit">Authorize</button>
  </form>
  <p class="fine">Your key is encrypted into an access token scoped to this server and is never
  stored in plaintext. Every request to Nominal is made with your own credential, so this
  connection can never see more than your account already can.</p>`;
}

function shell(inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nominal MCP — Authorize</title><style>
:root{--bg:#fff;--fg:#12141a;--mut:#5b6472;--line:#e3e6ec;--acc:#1f6feb;--err:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e6e9ef;--mut:#9aa4b2;--line:#242a33;--acc:#4c8dff;--err:#ff6b5e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.55 ui-sans-serif,-apple-system,system-ui,"Segoe UI",sans-serif;
display:flex;justify-content:center;padding:40px 20px}
main{width:100%;max-width:420px}h1{font-size:20px;margin:0 0 6px}
.sub{color:var(--mut);margin:0 0 18px}
.err{background:color-mix(in srgb,var(--err) 12%,transparent);border:1px solid var(--err);
color:var(--err);padding:10px 12px;border-radius:8px;font-size:13.5px}
ul.scopes{list-style:none;padding:0;margin:0 0 20px;border:1px solid var(--line);border-radius:10px}
ul.scopes li{padding:10px 12px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:2px}
ul.scopes li:last-child{border-bottom:0}
ul.scopes code{font-size:12px;color:var(--acc)}ul.scopes span{font-size:13px;color:var(--mut)}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;
background:var(--bg);color:var(--fg);font:inherit;font-size:14px}
input:focus{outline:2px solid var(--acc);outline-offset:-1px;border-color:var(--acc)}
.hint{font-size:12px;color:var(--mut);margin:6px 0 0}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--acc);
color:#fff;font:inherit;font-weight:600;cursor:pointer}button:hover{filter:brightness(1.08)}
.fine{margin-top:20px;font-size:12px;color:var(--mut);line-height:1.5}
</style></head><body><main>${inner}</main></body></html>`;
}
