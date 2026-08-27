# 02 — Nominal MCP server (third-party agent support)

> *"Third-party MCP support: letting customers use the Nominal platform through Claude
> Code, Codex, and similar agent environments."*

The idea: a hardware engineer working in Claude Code should be able to pull their own test
data, run an analysis, and write results back to Nominal without leaving their editor. The
platform becomes reachable from whatever agent the customer already uses.

This is the project with the largest surface area of the six, and it's the one where the
MCP details from Module 2 of the curriculum become load-bearing rather than trivia.

## What makes this hard

It is not "wrap the REST API in `tools/call`." Three problems dominate:

1. **Scale of the tool surface.** Nominal's API is large. Fifty tool schemas in every
   request is 20k+ tokens before the user has said anything, and a model choosing among
   fifty similar names chooses badly. This is the single biggest design constraint.
2. **Data volume.** Hardware telemetry is the opposite of CRM records — a single test run
   can be gigabytes of time series. No tool can return a dataset. Every read tool has to
   return a *handle plus a summary*, and the analysis has to happen where the data is.
3. **Auth in someone else's client.** The customer's MCP client is Claude Code, not our
   harness. We control the server, not the host. That constrains the auth story to what the
   MCP spec's OAuth flow supports.

## Design

### Tool surface: three tiers, not fifty tools

**Tier 1 — always loaded (≤8 tools).** Navigation and search.
`nominal_search(query, kind, limit)`, `nominal_get(uri)`, `nominal_list_assets`,
`nominal_list_runs(asset_id, since, limit)`, `nominal_describe_channels(run_id)`,
`nominal_query(...)`, `nominal_execute(code)`, `nominal_tool_search(query)`.

**Tier 2 — discovered on demand** via `nominal_tool_search`. Domain operations: checks,
workbooks, dataset ops, annotations.

**Tier 3 — code execution.** For anything analytical. Rather than exposing forty analysis
tools, expose the Nominal Python client *as a code API* the agent imports and calls in a
sandbox. Anthropic's [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
post reports ~98% token reduction on a comparable workflow, and for time-series work it's
not an optimization — it's the only shape that works. The agent writes:

```python
run = nominal.runs.get("run_8813")
df  = run.channels(["chamber_psi", "valve_cmd"]).between(t0, t1).to_pandas()
print(df.describe())          # ← only this reaches the model
```

The gigabyte never touches the context window.

### Resources vs. tools

Use MCP **resources** for stable, addressable things — an asset, a run, a workbook — under
a `nominal://` URI scheme. Resources are attachable by the user in the client UI, which is
a much better affordance than making the agent guess an id. Tools are for verbs.

### Auth

Follow the MCP authorization spec: the server is an **OAuth 2.1 resource server**.

- Serve protected-resource metadata (RFC 9728) so any compliant client discovers the
  authorization server without configuration.
- Support dynamic client registration so Claude Code / Codex can register themselves.
- Require resource indicators (RFC 8707) so a token minted for Nominal cannot be replayed
  against another server.
- Tokens are per-user, scoped, short-lived. Nominal's own authorization model — which
  assets and runs this engineer can see — is what enforces access. **Do not build a
  parallel permission model in the MCP layer.** Same principle as Module 5.
- Scopes are coarse and legible: `nominal:read`, `nominal:analyze`, `nominal:write`.
  A user should be able to connect read-only and have that mean something.

### Guardrails

- Every list/query tool has a server-enforced max. There is no unbounded read.
- Write tools are annotated `destructiveHint`/`idempotentHint` per spec so hosts can prompt.
- Results over the budget spill to a handle: `{summary, schema, row_count, handle}` — the
  agent narrows or fetches through `nominal_execute`.
- Rate limits return structured, retryable errors with a `retry_after`, not a 500.

## Milestones

| M | Deliverable | Weeks |
|---|---|---|
| M1 | Tier-1 tools, stdio transport, works in Claude Code with a static token | 1 |
| M2 | Streamable HTTP transport + full OAuth 2.1 resource-server flow | 1 |
| M3 | Resources (`nominal://asset/…`, `nominal://run/…`), tool tiering + `nominal_tool_search` | 0.5 |
| M4 | Code-execution surface: sandbox, Nominal client preloaded, egress rules | 1 |
| M5 | Tool evals — see below — plus docs and a one-line install | 0.5 |

## Evaluating the tools (do not skip)

The MCP server *is* an agent-facing product, so it needs agent evals, not just unit tests.
Per Anthropic's [writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents):

- Write 20–30 realistic engineer tasks ("find the last hot-fire with chamber pressure over
  X and tell me if the valve lagged").
- Run them against a real agent, score task completion **and** trajectory (right tools,
  sane order, tokens burned).
- Read the transcripts and fix the *tool descriptions* — most failures are naming and
  description failures, not model failures.
- Have Claude use the tools and critique them. It's the fastest signal available.

Reuse `../04-eval-harness` rather than building a second harness.

## Success criteria

- A new user installs the server, authenticates in a browser, and completes a real analysis
  in Claude Code inside 10 minutes.
- Tier-1 schemas cost under 3k tokens.
- A typical analysis session stays under 30k total tokens despite touching GB-scale data.
- Zero cases where the MCP layer grants access Nominal's own model would deny.
- Works unmodified in at least two hosts (Claude Code and one other).

## Open questions worth deciding early

- Cloud-hosted server vs. customer-run? Hosted is a better install experience and a worse
  data-residency story. For defense-adjacent customers this may decide itself.
- Does `nominal_execute` run in Nominal's infrastructure (data is local, we own the
  sandbox) or in the customer's agent sandbox (they own it, data has to move)? Almost
  certainly the former — it's the whole reason the code-execution tier works.
- How do MCP `elicitation` and the `tasks` extension map onto long-running analyses? A
  20-minute job should be a durable handle, not a held connection.
