# CLAUDE.md — Nominal MCP server

An MCP server that exposes the Nominal platform to third-party agent environments (Claude
Code, Codex, and anything else that speaks MCP), so a hardware engineer can pull test data,
analyze it, and write results back without leaving their editor.

Read `SPEC.md` first. The MCP spec is at
https://modelcontextprotocol.io/specification/latest — check it rather than recalling it;
the protocol moves.

## The three constraints that shape every decision

1. **Context budget.** The customer's agent has other things in its window. Tier-1 tool
   schemas must stay under 3k tokens total. Every new always-loaded tool is a tax on every
   request in every session.
2. **Data volume.** Test runs are gigabytes of time series. **No tool ever returns a
   dataset.** Reads return `{summary, schema, row_count, handle}`. Analysis happens through
   `nominal_execute` in a sandbox where the data already is.
3. **We are the server, not the host.** The client is someone else's product. We cannot
   assume UI, prompts, or a particular model. Everything the agent needs to use a tool
   correctly must be in the tool's name, description, and schema.

## Non-negotiables

- **Nominal's own authorization is the enforcement layer.** The MCP server never widens
  access and never implements a parallel permission model. If a user can't see a run in the
  product, no tool call returns it.
- **Per-user OAuth, always.** Server is an OAuth 2.1 resource server: RFC 9728
  protected-resource metadata, dynamic client registration, RFC 8707 resource indicators.
  No shared API keys, no service accounts.
- **No unbounded reads.** Every list/query tool has a server-enforced maximum. `limit` is
  capped on the server, not trusted from the caller.
- **Tool descriptions are product surface.** They are the only documentation the agent
  reads. Changing one is a behavior change and needs an eval run, not just review.
- **Write tools are annotated** (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so
  hosts can prompt correctly.

## Layout

```
server/
  transport/     stdio + streamable HTTP
  auth/          OAuth 2.1 resource server, PRM, DCR, token validation
  tools/
    tier1/       ≤8 always-loaded navigation + query tools
    tier2/       discovered via nominal_tool_search
  resources/     nominal:// URI scheme (asset, run, workbook, dataset)
  execute/       sandboxed code execution with the Nominal client preloaded
  limits/        pagination, caps, structured retryable errors
evals/
  tasks/         20–30 realistic engineer tasks
  run.py         drives a real agent, scores completion + trajectory
```

## Tool authoring rules

- Name for the agent's mental model, not the API's. `nominal_list_runs(asset_id, since)`
  beats `nominal_query_run_index_v2`.
- One clear job per tool. If a description needs "or", it's two tools.
- Errors are instructive and recoverable: say what to call instead. `"limit must be <= 100;
  received 5000"` beats a 400.
- Ambiguity is a return value: `{ambiguous: [...]}`, never a guess.
- Return structured JSON. Never return prose containing instructions to the model — that
  channel is data and mixing them is how injection lands.

## Adding a tool — checklist

1. Does it belong in tier 1? Default is no. Tier 1 has a fixed budget.
2. Could `nominal_execute` do it with the Python client instead? If yes, don't add a tool.
3. Is there a server-enforced bound on the result size?
4. Is `readOnlyHint`/`destructiveHint` set correctly?
5. Add an eval task exercising it, and run the suite. Tool changes ship with eval deltas.

## Testing

- Protocol conformance against the MCP inspector (`npx @modelcontextprotocol/inspector`).
- Auth: token for another resource must be rejected; expired token returns a proper 401
  with `WWW-Authenticate`; a user must never see another user's runs.
- Agent evals in `evals/` — task completion *and* trajectory (tool choice, order, token
  cost). Most failures here are description failures; fix the description, re-run.
- Install test: fresh machine, fresh account, real analysis in Claude Code, under 10
  minutes.
