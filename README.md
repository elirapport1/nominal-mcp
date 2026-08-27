# Nominal MCP Server

An [MCP](https://modelcontextprotocol.io) server for the
[Nominal](https://nominal.io) hardware test platform. Pull test data, inspect telemetry
channels, run analysis, and write results back — from Claude Code, Cursor, or any MCP client,
without leaving your editor.

Implements MCP **`2026-07-28`** (the current revision) with backward compatibility to
`2025-11-25`, `2025-06-18`, `2025-03-26`, and `2024-11-05`.

```
10 tools  ·  467 API operations reachable  ·  2,992 tokens of tools/list  ·  OAuth 2.1
```

---

## Quick start

> **No public instance is running yet.** Deploy your own in about two minutes —
> it runs comfortably on Cloudflare's free plan.

### Deploy it

```bash
git clone https://github.com/elirapport1/nominal-mcp && cd nominal-mcp && npm ci
npx wrangler login
npx wrangler kv namespace create OAUTH_KV      # paste the id into wrangler.toml
openssl rand -base64 32 | npx wrangler secret put TOKEN_SECRET
openssl rand -base64 32 | npx wrangler secret put HANDLE_SECRET
npx wrangler deploy
```

### Connect to it

```bash
claude mcp add --transport http nominal https://<your-worker>.workers.dev/mcp
```

A browser window opens. Paste your own Nominal API key (Nominal app → Settings → API keys).
The key is encrypted into an access token scoped to this server and is never stored in
plaintext. Every request to Nominal is made with *your* credential, so the connection can
never see more than your account already can.

### Or run it over stdio

```bash
NOMINAL_API_KEY=<key> \
NOMINAL_MCP_URL=https://<your-worker>.workers.dev/mcp \
npx github:elirapport1/nominal-mcp
```

(Runs straight from the repo — nothing is published to npm, so plain
`npx nominal-mcp` will not resolve.)

Per the MCP auth spec, stdio servers read credentials from the environment instead of running
an OAuth flow. Nothing is written to disk.

---

## What you can ask for

> "Find the last hot-fire run on Engine A and tell me whether chamber pressure ever exceeded
> 900 psi."

> "Compare valve command lag between run 14 and run 15."

> "Flag an event on this run at T+4.2s and label it `anomaly`."

---

## Tools

| Tool | What it does |
|---|---|
| `nominal_search` | Search assets, runs, datasets, workbooks, checklists, events, videos |
| `nominal_get` | Resolve a `nominal://` uri, RID, or dataset UUID to full detail |
| `nominal_list_runs` | Runs for an asset, newest first, time-windowed |
| `nominal_describe_channels` | Channels on a run/dataset with unit, type, tags |
| `nominal_query_channels` | Stats + decimated trace for up to 10 channels |
| `nominal_compute` | One aggregate over a channel, computed server-side |
| `nominal_export` | Presigned URL for full-resolution data |
| `nominal_write` | Create events, comments, or run metadata |
| `nominal_api_search` | Find any of the 467 API operations by keyword |
| `nominal_api_call` | Execute one, validated against its real signature |

Plus resources under `nominal://` and four workflow prompts (`investigate_anomaly`,
`compare_runs`, `summarize_run`, `preflight_check`).

---

## Three design decisions worth knowing

**467 operations, 10 tools.** Nominal's API has 467 endpoints across 57 services. Exposing
them as tool schemas would cost roughly **163,000 tokens** of `tools/list` before you typed
anything. Instead `nominal_api_search` returns operation *descriptors* and `nominal_api_call`
executes them, so you pay ~120 tokens per operation you actually look up. `tools/list` stays
fixed at 2,992 tokens and is publicly cacheable.

**No tool ever returns a dataset.** A single run can be gigabytes of time series.
`nominal_query_channels` returns statistics plus a min/max/mean trace decimated into at most
200 buckets, and a signed handle. Bulk data leaves through a presigned URL that never enters
the context window.

**Your credential, never ours.** There is no service account. The OAuth flow binds *your*
Nominal API key into an encrypted, audience-bound, one-hour access token. Nominal's own
authorization is the only enforcement layer — the MCP server never widens access and never
implements a parallel permission model.

---

## Documentation

- **[SPEC.md](SPEC.md)** — the implementation spec: protocol decisions, tool design, auth
  model, limits, threat model, and what was deliberately left out
- [docs/SPEC-original.md](docs/SPEC-original.md) — the original design brief, kept for the
  record; SPEC.md §0 explains where measurement changed it

---

## Development

```bash
npm ci
npm run typecheck
npm test              # 115 unit + conformance tests
npm run budget        # fails if tools/list exceeds 3,000 tokens
npm run test:fuzz     # adversarial suite
npm run dev           # wrangler dev
```

### Testing

| Layer | What it covers |
|---|---|
| `test/unit/` | crypto, era detection, clamps, decimation, handles, catalog policy |
| `test/conformance/protocol.test.ts` | one test per MCP `MUST` this server owns |
| `test/conformance/auth.test.ts` | RFC 9728/8414/8707/9207/7636, PKCE, DCR, token forgery |
| `test/fuzz/` | six generators, seven invariants, seeded and replayable |

**Verification boundary:** the protocol, auth, limits, and catalog-policy layers are fully
covered. The Nominal-side *request encoding* for the tier-1 tools was derived from the
generated `nominal-api` Conjure client and tested against a stub, not against a live Nominal
deployment — see [SPEC.md §9.3](SPEC.md). If you have a key, one command closes that gap.

The fuzzer runs **every 20 minutes** against the live deployment
([`.github/workflows/fuzz.yml`](.github/workflows/fuzz.yml)). Generators cover JSON-RPC
structure, the protocol/era matrix, tool arguments, catalog operation ids, auth forgery, and
prompt-injection/SSRF payloads. Invariants: never a 5xx, always valid JSON-RPC, never reflects
a secret or stack trace, `resultType` present iff modern, bounded latency and size, and no
internal operation ever executes. A failure files an issue with the seed for exact replay.

### Deploying your own

```bash
npx wrangler kv namespace create OAUTH_KV     # put the id in wrangler.toml
npx wrangler secret put TOKEN_SECRET          # AES-GCM key material
npx wrangler secret put HANDLE_SECRET         # HMAC key for result handles
npx wrangler deploy
```

For CI deploys set the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets and a
`DEPLOY_URL` repository variable.

---

## Endpoints

| Path | |
|---|---|
| `POST /mcp` | MCP endpoint (Streamable HTTP) |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 |
| `GET\|POST /authorize`, `POST /token`, `/register`, `/revoke` | OAuth 2.1 |
| `GET /health` | liveness |

---

## License

MIT
