# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/elirapport1/nominal-mcp/security/advisories/new).
Please do not file a public issue for anything exploitable.

## Threat model

This server sits between an LLM agent and a customer's hardware test data. The
assumptions that shape every design decision:

**The agent is not trusted to respect boundaries.** It is a language model that
can be steered by anything in its context, including data returned by this
server. So the server enforces limits rather than requesting them: scopes are
checked server-side, `limit` is clamped server-side, and internal operations are
refused regardless of what the agent asks for.

**Tenant data is attacker-influenced.** Anyone who can write to a Nominal
workspace can set a run description, event title, or channel name. Those strings
reach the model. Therefore every tool returns JSON — never prose — and tenant
strings are values inside `structuredContent`, never interpolated into anything
positioned as an instruction. The fuzzer's injection generator asserts this.

**The client is someone else's product.** We control the server, not the host.
Nothing depends on the client prompting the user, honoring an annotation, or
validating a schema.

## What the server guarantees

| | |
|---|---|
| **No service accounts** | Every Nominal call carries the end user's own API key. The server cannot see more than the user can. |
| **No parallel permission model** | Nominal's authorization is the only enforcement layer. The MCP layer never widens access. |
| **Audience-bound tokens** | RFC 8707. A token minted for another MCP server is rejected here even if it decrypts — the confused-deputy case. |
| **No token passthrough** | The Nominal key is sealed inside an AES-256-GCM envelope and never appears in a URL, log, or error. |
| **PKCE S256 only** | `plain` is not offered. Authorization codes are single-use with a 60-second TTL. |
| **SSRF containment** | Outbound URLs are built from the generated catalog's path templates only, against an allowlist of Nominal hosts. Redirects are never followed while holding a credential. |
| **No unbounded reads** | Every list and query has a server-enforced cap; results over 64 KB spill to a handle. |
| **Bounded handles** | HMAC-signed, 1-hour TTL, bound to the issuing user. Another user's handle is refused. |

## Secrets

`TOKEN_SECRET` and `HANDLE_SECRET` are Worker secrets, never committed. Generate
them with `openssl rand -base64 32`. Rotating `TOKEN_SECRET` invalidates every
outstanding access token, which is the intended way to revoke everything at once.

Never logged: the `Authorization` header, the Nominal API key, token ciphertext,
and `nominal_write` request bodies. The fuzzer asserts that no secret marker or
stack trace appears in any response.

## Known limitations

- **Live-API request encoding is unverified.** The Conjure request bodies for
  the tier-1 tools were derived from the generated `nominal-api` client and
  tested against a stub, not a live Nominal deployment. See SPEC.md §9.3.
- **The rate limiter degrades to per-isolate** if the `RATE_LIMITER` binding is
  absent, which under-counts across colos. `/health` reports which one is live,
  and the deploy smoke test fails if it is not the binding.
- **The consent page accepts a pasted API key.** That is inherent to bridging a
  key-based API into OAuth. The page sets a strict CSP, `frame-ancestors 'none'`,
  and `no-store`, and the key is verified against Nominal before any token is
  minted.
