# Nominal MCP Server — Implementation Specification

**Status:** implementation spec, v2. Supersedes [`docs/SPEC-original.md`](docs/SPEC-original.md)
(the design brief), which was written before the API surface and the current MCP revision
were measured. Where the two disagree, this document wins and says why.

**Target protocol revision:** `2026-07-28` (current), with backward compatibility to
`2025-11-25`, `2025-06-18`, and `2025-03-26`.

**Target runtime:** Cloudflare Workers (V8 isolate, Web-standard `fetch`), plus an
`npx` stdio bridge for local clients.

---

## 0. What changed after measuring

Three findings from research reshaped the original design. They are stated up front because
each one invalidates something the design brief assumed.

### 0.1 The API is 467 endpoints, not "large"

`nominal-api` (PyPI, v0.1410.0) is a generated Conjure client. Introspecting it yields:

| | |
|---|---|
| Services | 57 |
| Endpoints | 467 |
| Verbs | POST 305, GET 90, PUT 59, DELETE 13 |
| Path prefixes | 40 (`/scout/v1`, `/catalog/v1`, `/compute/v2`, `/ingest/v1`, `/video/v2`, …) |

The largest single services are `CatalogService` (34), `VideoService` (34), `RunService` (22),
`DataReviewService` (21), and `AssetService` (19).

At a conservative 350 tokens per JSON Schema, exposing all 467 as MCP tools costs **~163k
tokens** of `tools/list` before the user types anything. That is not a tuning problem, it is a
disqualifying one. The catalog is extracted to
[`src/nominal/catalog.raw.json`](src/nominal/catalog.raw.json) at build time and never shipped
as tool schemas.

### 0.2 MCP `2026-07-28` removed sessions — which breaks "tools discovered on demand"

The design brief proposed tier-2 tools "discovered on demand" via `nominal_tool_search`,
implying the tool list grows during a session. The current revision forbids this:

> Remove protocol-level sessions and the `Mcp-Session-Id` header from the Streamable HTTP
> transport. **List endpoints (`tools/list`, `resources/list`, `prompts/list`) no longer vary
> per-connection.** Servers that need cross-call state use explicit, server-minted handles
> passed as ordinary tool arguments. — [SEP-2567]

So tier 2 cannot be "tools that appear later". The compliant expression of the same idea is a
**two-call pattern over a static tool list**: `nominal_api_search` returns *operation
descriptors* (data, not schemas) and `nominal_api_call` executes one by id. The token cost of
tier 2 becomes proportional to what the agent actually looked up, and `tools/list` stays
constant and cacheable for every user. §4.3 specifies it.

Other consequences of the same revision, all load-bearing here:

- **No `initialize` handshake.** Every request carries
  `io.modelcontextprotocol/protocolVersion` and `…/clientCapabilities` in `_meta`.
- **`server/discover` is mandatory** (`MUST` implement).
- **Every result carries `resultType`** (`"complete"` | `"input_required"`).
- **`ttlMs` + `cacheScope` are required** on `server/discover`, `tools/list`, `prompts/list`,
  `resources/list`, `resources/templates/list`, `resources/read`.
- **`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` headers required** on POST; a mismatch
  between header and body is `HeaderMismatch` (`-32020`) + HTTP 400.
- **Error codes renumbered**: `-32020` HeaderMismatch, `-32021` MissingRequiredClientCapability,
  `-32022` UnsupportedProtocolVersion. Resource-not-found moved `-32002` → `-32602`.
- **`ping`, `logging/setLevel`, GET-stream, SSE resumability removed.** Roots, Sampling, and
  Logging are deprecated.
- **Elicitation is now MRTR**: return an `InputRequiredResult`; the client retries the original
  request with `inputResponses`.

### 0.3 The official TypeScript SDK does not implement this revision

`@modelcontextprotocol/sdk@1.30.0` pins `LATEST_PROTOCOL_VERSION = '2025-11-25'` and has no
`server/discover`, no `resultType`, no `CacheableResult`. Meanwhile real clients in the field
(Claude Code, Cursor) speak `2025-06-18`/`2025-11-25`.

Building on the SDK would mean shipping a server that cannot be spec-current. Building only to
`2026-07-28` would mean shipping a server no client can talk to today.

**Decision: hand-write a dual-era protocol core** (§3). This is tractable precisely because
`2026-07-28` is stateless — the era difference is confined to one adapter layer, ~400 lines.
It also removes a Node-shaped dependency from a Workers deployment.

---

## 1. Product shape

A hardware engineer in Claude Code (or any MCP client) connects to
`https://<worker>/mcp`, authenticates in a browser against their own Nominal account, and can
then find assets and runs, inspect channels, pull windowed telemetry summaries, run compute,
and write events and annotations back — without leaving the editor and without any dataset
crossing the context window.

Two connection modes, both first-class:

| Mode | Who | Auth |
|---|---|---|
| **Remote** `https://<worker>/mcp` | any MCP client | OAuth 2.1 (§5) |
| **Local stdio** `npx nominal-mcp` | Claude Code / Codex power users | `NOMINAL_API_KEY` env |

---

## 2. Non-negotiables

Carried forward from the design brief; still correct, restated as testable assertions.

1. **Nominal's authorization is the only enforcement layer.** Every outbound call carries the
   end user's own credential. No service accounts, no shared keys, no parallel permission
   model. If the product would deny it, the tool returns the same denial.
2. **No tool ever returns a dataset.** Reads return `{summary, schema, row_count, handle}`.
   Bulk data moves through `nominal_export` to a presigned URL or is reduced server-side by
   `nominal_compute`.
3. **No unbounded read.** Every list/query tool has a server-enforced cap. `limit` is clamped
   on the server, never trusted from the caller.
4. **Tool descriptions are product surface.** They are the only documentation the agent reads.
   Changing one is a behavior change requiring an eval run.
5. **Errors are instructive.** `"limit must be <= 500; received 5000; retry with limit=500"`
   beats a 400. Ambiguity is a return value (`{ambiguous: [...]}`), never a guess.
6. **Tool results are data, never instructions.** Nominal-sourced strings are wrapped and never
   interpolated into anything the model reads as a directive (§8.3).

---

## 3. Protocol core

### 3.1 Era adapter

One internal representation; two wire dialects.

```
                    ┌──────────────────────────────┐
  POST /mcp ───────▶│ era detect                   │
                    │  hdr MCP-Protocol-Version    │
                    │  ∪ _meta.protocolVersion     │
                    │  ∪ initialize.params         │
                    └──────────┬───────────────────┘
                               │
          ┌────────────────────┴────────────────────┐
          ▼                                         ▼
   MODERN (2026-07-28)                     LEGACY (≤2025-11-25)
   • no initialize                         • initialize handshake
   • server/discover                       • capabilities from handshake
   • resultType on every result            • resultType stripped
   • ttlMs / cacheScope emitted            • cache fields stripped
   • MRTR InputRequiredResult              • elicitation/create request
   • errors -32020/-32021/-32022           • legacy -32002 for not-found
          └────────────────────┬────────────────────┘
                               ▼
                    ┌──────────────────────────────┐
                    │ handler core (era-agnostic)  │
                    │ tools / resources / prompts  │
                    └──────────────────────────────┘
```

`src/protocol/era.ts` owns detection and the response transform. Handlers always produce
modern-shaped results; the adapter downgrades on the way out. Adding an era is one table entry.

### 3.2 Methods implemented

| Method | Modern | Legacy | Notes |
|---|:--:|:--:|---|
| `server/discover` | ✅ | — | MUST; cacheable |
| `initialize` | — | ✅ | legacy only |
| `notifications/initialized` | — | ✅ | 202, no body |
| `tools/list` | ✅ | ✅ | deterministic order, cacheable |
| `tools/call` | ✅ | ✅ | |
| `resources/list` | ✅ | ✅ | cacheable |
| `resources/templates/list` | ✅ | ✅ | cacheable |
| `resources/read` | ✅ | ✅ | cacheable, `private` |
| `prompts/list` / `prompts/get` | ✅ | ✅ | cacheable |
| `completion/complete` | ✅ | ✅ | argument autocomplete |
| `subscriptions/listen` | ✅ | — | SSE, keep-alive comments |
| `ping` | — | ✅ | removed in modern |
| `logging/setLevel` | — | ✅ | modern uses `_meta` logLevel |

### 3.3 Validation order (strict, and tested)

For every POST, in this order — order matters because it determines which error a
malformed request gets:

1. `Origin` present and not allowlisted → **403**.
2. Body not valid JSON → `-32700`, **400**.
3. Not a JSON-RPC 2.0 request/notification → `-32600`, **400**.
4. `MCP-Protocol-Version` header absent → treat as `2025-03-26` (compat) unless
   `STRICT_HEADERS=1`.
5. Header version ≠ `_meta` version → `-32020` HeaderMismatch, **400**.
6. Version unsupported → `-32022` UnsupportedProtocolVersion + `supportedVersions`, **400**.
7. `Mcp-Method` ≠ body `method`, or `Mcp-Name` ≠ `params.name`/`params.uri` → `-32020`, **400**.
8. Modern era and `_meta.clientCapabilities` missing → `-32602`, **400**.
9. Method unknown → `-32601`, **404** (per transport spec, not 400).
10. Auth missing/invalid → **401** + `WWW-Authenticate` with `resource_metadata` (§5).
11. Params invalid → `-32602`, **400**.

Tool *execution* failures are **not** JSON-RPC errors: they return `isError: true` in a normal
result, so the model can read and recover from them.

---

## 4. Tool surface

### 4.1 Budget

Tier 1 is **10 tools** with a hard ceiling of **3,000 tokens** for the full `tools/list`
payload. `scripts/token-budget.ts` measures it and CI fails the build if it is exceeded.
Measured at last run: **2,992 tokens**.

Getting under the cap took real cuts, and they are worth recording because each one is a
precedent: the optional `title` field was dropped from every tool (hosts fall back to `name`),
and `readOnlyHint: false` / `idempotentHint: false` were removed wherever they merely restated
the spec default. `destructiveHint` is always stated explicitly even when it matches the
default, because a host reads it to decide whether to prompt. For comparison, exposing all 467
operations as tools would cost roughly **163,000 tokens** — about 54x this.

### 4.2 Tier 1 (always loaded)

| Tool | Job | Annotations |
|---|---|---|
| `nominal_search` | One search across assets, runs, datasets, checklists, workbooks, events. `kind` narrows. | readOnly |
| `nominal_get` | Resolve any `nominal://` URI or bare RID to its entity summary. | readOnly, idempotent |
| `nominal_list_runs` | Runs for an asset, time-windowed, newest first. | readOnly |
| `nominal_describe_channels` | Channels on a run/dataset: name, type, unit, tags, bounds. Paged. | readOnly |
| `nominal_query_channels` | Windowed, **decimated** channel data → summary + stats + handle. Never raw rows. | readOnly |
| `nominal_compute` | Server-side compute over channels (min/max/mean/percentile/threshold-crossing/derivative). Data never moves. | readOnly |
| `nominal_export` | Bulk egress as a presigned URL, for when the agent genuinely needs the file. | readOnly |
| `nominal_write` | Create/update events, annotations, run metadata, comments. One verb, `kind`-dispatched. | **destructive**, non-idempotent |
| `nominal_api_search` | Search all 467 operations; returns descriptors, not schemas. | readOnly |
| `nominal_api_call` | Execute one operation by id, validated against the catalog. | openWorld, **destructive** if the op is |

That is 10 tools but 9 concepts — `nominal_api_search`/`nominal_api_call` are a single
find-then-invoke unit, which is how the design brief's "≤8 tools" goal survives contact with a
467-endpoint API.

### 4.3 Tier 2 — the catalog, not a tool list

`nominal_api_search(query, limit)` performs BM25-ish scoring over the extracted catalog
(service name, operation name, path, arg names) and returns compact descriptors:

```json
{ "operation_id": "scout_assets.AssetService.search_assets",
  "method": "POST", "path": "/scout/v1/search-assets",
  "args": ["search_assets_request"],
  "mutating": false, "summary": "Search assets…" }
```

`nominal_api_call(operation_id, arguments)` then:

1. looks the id up in the catalog — **unknown id is rejected**, no passthrough;
2. checks the op against the **allowlist policy** (§4.4);
3. checks the caller's scopes cover it (`read` vs `write`);
4. binds path/query/body params by name from the catalog's recorded shapes;
5. issues the HTTPS call with the caller's own token;
6. applies the response budget (§6) before returning.

This keeps the entire API reachable at a marginal cost of ~120 tokens per looked-up operation,
with `tools/list` fixed and `cacheScope: "public"`.

### 4.4 Operation policy

The catalog is partitioned at build time by `scripts/build-catalog.ts`:

- **`internal`** — 24 ops on `/internal/*`, `*-internal/v1`, `InternalXxxService`, plus
  `issue_sandbox_token`, `get_decrypted`, `get_access_token_from_api_key_value`.
  **Blocked unconditionally.** These are control-plane operations that a user token should
  never reach through an agent.
- **`mutating`** — anything not GET, plus `archive|delete|create|update|write|ingest|revoke`.
  Requires `nominal:write`, annotated destructive, and surfaced to the host for confirmation.
- **`read`** — everything else. Requires `nominal:read`.

Blocking is enforced in `nominal_api_call`, not in search, so the agent gets a legible
`"operation … is internal and not callable"` rather than silently missing results.

---

## 5. Authorization

### 5.1 The problem

The MCP spec requires the server to be an **OAuth 2.1 resource server** with a discoverable
authorization server. Nominal authenticates with **per-user API keys** (bearer tokens issued
under Settings → API keys) against a Conjure REST API. Nominal is not an OAuth AS and we do
not control their IdP.

The design brief said "support dynamic client registration" and stopped there. That leaves the
actual gap unaddressed: *what is the authorization server?*

### 5.2 The design: a thin AS that custodies the user's own key

The Worker hosts a minimal OAuth 2.1 authorization server whose only job is to bind a Nominal
API key to a scoped, audience-bound, expiring MCP access token.

```
Claude Code                 Worker (RS + AS)              Nominal API
     │                             │                            │
     │─ POST /mcp (no auth) ──────▶│                            │
     │◀─ 401 + WWW-Authenticate ───│  resource_metadata=…       │
     │                             │                            │
     │─ GET /.well-known/oauth-protected-resource ─▶            │
     │◀─ { authorization_servers: [self], scopes_supported } ───│
     │                             │                            │
     │─ GET /.well-known/oauth-authorization-server ▶           │
     │◀─ metadata (PKCE S256, DCR, CIMD, iss) ─────│            │
     │                             │                            │
     │─ /authorize?…&resource=…&code_challenge=… ─▶│            │
     │                             │  consent page:             │
     │                             │  user pastes THEIR key ───▶│ validate
     │                             │◀────────────── 200 ────────│
     │◀─ 302 ?code=…&iss=… ────────│                            │
     │─ POST /token (PKCE verifier)▶│                           │
     │◀─ access_token + refresh ───│                            │
     │                             │                            │
     │─ POST /mcp (Bearer) ───────▶│─ Bearer <user key> ───────▶│
```

**The access token is an encrypted envelope, not a session pointer.** AES-256-GCM over
`{sub, key_ref, base_url, scopes, aud, exp, jti}` with a Worker secret. Stateless validation,
no KV read on the hot path, and the Nominal key is never at rest in plaintext.

### 5.3 Compliance checklist

| Requirement | Where |
|---|---|
| RFC 9728 protected resource metadata | `/.well-known/oauth-protected-resource` |
| AS metadata (RFC 8414) | `/.well-known/oauth-authorization-server` |
| **Client ID Metadata Documents** (preferred since `2026-07-28`) | `https://` client_id fetched + validated |
| DCR (RFC 7591) — deprecated, kept for compat | `POST /register`, `application_type` required |
| PKCE S256 mandatory | rejects `plain` and missing challenge |
| **RFC 8707 resource indicators** | `resource` required at `/authorize` and `/token`; token `aud` bound |
| **Audience validation** | token `aud` ≠ this server's canonical URI → 401 |
| RFC 9207 `iss` in authorization responses | + `authorization_response_iss_parameter_supported: true` |
| 401 carries `WWW-Authenticate` with `scope` | all unauthenticated `/mcp` responses |
| Tokens never in query strings | enforced; `?access_token=` → 400 |
| One-time auth codes | KV, 60 s TTL, deleted on redemption, replay → `invalid_grant` |
| Scopes | `nominal:read`, `nominal:write`, `nominal:admin` |

**Token passthrough is explicitly refused.** A token minted for another audience is rejected
even if otherwise valid — this is the "confused deputy" case the security spec calls out.

### 5.4 stdio mode

Per spec, stdio implementations **SHOULD NOT** use the OAuth flow and instead read credentials
from the environment. The bridge reads `NOMINAL_API_KEY` + `NOMINAL_BASE_URL` and never
prompts, never writes them to disk, and never logs them.

---

## 6. Data volume controls

The single hardest constraint: a run can be gigabytes; the context window is not.

| Control | Value |
|---|---|
| Max tool result | 64 KB serialized; over → spill |
| Max rows inline | 0 — no tool returns rows |
| `nominal_query_channels` | returns count, time bounds, min/max/mean/stddev, null count, plus ≤200 **decimated** points |
| Decimation | server-side; requested window ÷ 200 buckets, min/max/mean per bucket |
| Spill | `{summary, schema, row_count, handle, next}` where `handle` is opaque and re-fetchable |
| Handles | HMAC-signed, encode `(query, user, exp)`, 1 h TTL, **passed as ordinary tool args** per SEP-2567 |
| List caps | `limit` clamped to 500; `nominal_api_search` to 50 |
| Pagination | opaque `cursor`, forward-only |
| Rate limit | 120 req/min per token; `429` + `retry_after` as a **structured retryable result**, not a 500 |

Every cap is a clamp with an explanatory message, never a rejection:
`"limit clamped from 5000 to 500"` is returned in `_meta.notices` so the agent learns.

---

## 7. Resources and prompts

### 7.1 URI scheme

```
nominal://asset/{rid}                  nominal://run/{rid}
nominal://dataset/{rid}                nominal://workbook/{rid}
nominal://checklist/{rid}              nominal://event/{rid}
nominal://channel/{datasource}/{name}  nominal://handle/{id}
```

Registered as **resource templates** (with `completion/complete` on `{rid}`) rather than a
flat `resources/list`, because listing every run in an org is exactly the unbounded read that
rule 3 forbids. `resources/list` returns only pinned/favorite entities — bounded by
construction. All reads are `cacheScope: "private"` (user-dependent), `ttlMs` 30 s for runs,
5 min for assets.

### 7.2 Prompts

`investigate_anomaly`, `compare_runs`, `preflight_check`, `summarize_run` — each a short
workflow that names the tools to use in order. Prompts are cheap and they measurably improve
trajectory on the eval tasks.

---

## 8. Security

### 8.1 Transport

Origin allowlist; DNS-rebinding rejection; HSTS; no wildcard CORS with credentials; `Vary:
Origin, Authorization`; secrets only via Worker bindings.

### 8.2 SSRF

`nominal_api_call` builds URLs from the **catalog's recorded path template only**. The base URL
is validated against an allowlist of Nominal hosts (`api.gov.nominal.io`, `api.nominal.io`,
`*.nominal.io`). A user-supplied `base_url` that resolves off-allowlist is rejected at token
mint time, not at call time.

### 8.3 Prompt injection

Nominal data — run descriptions, event titles, comments, channel names — is attacker-influenced
in the threat model (anyone who can write to the tenant can write those strings). Therefore:

- all tool output is JSON; no tool returns prose;
- string fields from Nominal are returned as values inside `structuredContent`, never
  concatenated into a `text` block that reads as guidance;
- a `_meta.provenance` marker tags every field that originated in tenant data;
- the server never echoes tenant strings into `instructions` or prompt templates.

### 8.4 Logging

Structured JSON to stdout. **Never** logged: `Authorization`, the Nominal key, token
ciphertext, request bodies of `nominal_write`. Token `jti` and `sub` hash are logged for
correlation. OpenTelemetry `traceparent` is propagated from `_meta` per the spec.

---

## 9. Testing

Four layers, all in CI.

### 9.1 Unit — `test/unit/`
Era detection, envelope crypto round-trip, PKCE, catalog binding, clamps, decimation math,
handle signing/expiry, redaction.

### 9.2 Protocol conformance — `test/conformance/`
A checklist derived line-by-line from the spec, one test per MUST. Includes every row of the
§3.3 validation order, the full §5.3 auth table, `resultType` presence/absence per era,
`ttlMs`/`cacheScope` presence on all six cacheable methods, deterministic `tools/list`
ordering, and `-32601`→404 vs `-32602`→400 status mapping.

### 9.3 Live smoke — `test/conformance/live.test.ts`
Runs against the deployed Worker with a real Nominal key. Gated on `NOMINAL_API_KEY`; skipped,
not failed, when absent.

### 9.4 Fuzzing — `test/fuzz/`

Continuous, and the part most likely to find real bugs. Six generators:

| Generator | Targets |
|---|---|
| **JSON-RPC structural** | malformed envelopes, wrong types, null ids, batch arrays, deep nesting, duplicate keys, huge ints |
| **Protocol matrix** | every (era × method × header-mismatch) combination, incl. absent/garbage versions |
| **Tool argument** | per-schema property fuzzing — wrong types, boundary ints, `__proto__`, 1 MB strings, unicode/RTL, negative limits |
| **Catalog** | random + adversarial `operation_id`s: path traversal, absolute URLs, internal ops, unknown ids |
| **Auth** | forged/expired/wrong-audience/truncated/bit-flipped tokens, replayed codes, PKCE mismatch, alg confusion |
| **Injection** | SSRF payloads in every string arg; prompt-injection strings checked for verbatim reflection into model-readable text |

**Invariants** (a violation fails the run):

1. Never a 5xx. Every failure is a typed JSON-RPC error or `isError: true`.
2. Response always valid JSON-RPC 2.0 with the request's `id`.
3. Never reflects a secret, token, internal hostname, or stack trace.
4. `resultType` present iff era is modern.
5. p99 latency under 2 s; no request hangs.
6. No internal-policy operation ever executes.
7. Every response ≤ 64 KB.

Runs **every 20 minutes** via GitHub Actions (§10) against the live deployment, seeded by run
id so failures replay deterministically. A failure opens/updates a GitHub issue with the seed
and the minimized case.

### 9.5 Agent evals — `evals/`
20–30 realistic engineer tasks scored on completion **and** trajectory (tool choice, order,
tokens). Per the design brief: most failures are description failures — fix the description,
re-run. Deferred to M5; the harness is `../04-eval-harness`.

---

## 10. CI/CD

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | push, PR | typecheck, lint, unit, conformance, token budget, `npm audit` |
| `fuzz.yml` | `*/20 * * * *` + dispatch | 6 generators against live, uploads corpus, files an issue on failure |
| `deploy.yml` | push to `main` after CI | `wrangler deploy`, then smoke-test the live URL, auto-rollback on failure |
| `catalog.yml` | weekly | re-extract from latest `nominal-api`, PR the diff |

`catalog.yml` matters: the API moves (1,107 releases of `nominal-api`). A weekly diff PR is how
this server avoids silently drifting from the platform.

---

## 11. Milestones

| M | Deliverable | State |
|---|---|---|
| M1 | Protocol core, dual-era, tier-1 tools, stdio bridge | ✅ |
| M2 | Streamable HTTP on Workers + full OAuth 2.1 AS/RS | ✅ |
| M3 | Resources, templates, prompts, completion | ✅ |
| M4 | Catalog tier (`api_search`/`api_call`) + policy | ✅ |
| M5 | Fuzzing, CI, live deploy, docs | ✅ |
| M6 | Agent evals, `nominal_execute` sandbox tier | deferred — §12 |

---

## 12. Deliberately not built

- **`nominal_execute` (the code-execution tier).** The design brief's strongest idea, and it
  belongs on Nominal's infrastructure, not ours — the whole point is that the sandbox sits
  where the data already is. Building it here would mean moving gigabytes to a Worker, which
  is the exact anti-pattern rule 2 forbids. `nominal_compute` covers the reductions that
  matter today; the sandbox needs a Nominal-side runtime and is scoped as M6.
- **Tasks extension** (`io.modelcontextprotocol/tasks`). The right answer for 20-minute
  analyses. Not yet implemented by any client we can test against; the ingest/compute
  long-poll ops are the natural first users. Deferred, not rejected.
- **MCP Apps / UI.** Out of scope.
- **Write coverage beyond events/annotations/metadata/comments.** Ingest and dataset mutation
  are reachable through `nominal_api_call` with `nominal:write`, but are not tier-1 verbs.

---

## 13. Success criteria

| | Target |
|---|---|
| Install → real analysis in Claude Code | < 10 min |
| `tools/list` token cost | < 3,000 |
| Typical analysis session, GB-scale data | < 30,000 tokens total |
| MCP `MUST` clauses covered by a test | 100% of those in §3/§5 |
| Fuzz invariant violations | 0 |
| Access the product would deny | 0 |
| Hosts verified | Claude Code + MCP Inspector |

---

## References

- MCP specification `2026-07-28` — spec index, base protocol, transports, authorization,
  tools, resources, caching, MRTR, subscriptions, discovery (64 pages, read in full)
- [SEP-2567] sessions removal · [SEP-2575] statelessness + discovery · [SEP-2322] MRTR ·
  [SEP-2549] caching · [SEP-2243] request headers
- RFC 9728, RFC 8414, RFC 8707, RFC 9207, RFC 7591, OAuth 2.1 draft, CIMD draft
- `nominal-api` 0.1410.0 (PyPI), `nominal` 1.162.0 — API surface source of truth
- Anthropic, *Writing effective tools for agents*; *Code execution with MCP*
