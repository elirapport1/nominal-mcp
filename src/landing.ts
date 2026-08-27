import { TOOL_DEFINITIONS } from "./transport/handler.js";
import { CATALOG_STATS } from "./tools/catalog.js";
import { escapeHtml } from "./util/encoding.js";

export function landingPage(origin: string): string {
  const tools = TOOL_DEFINITIONS.map(
    (t) =>
      `<tr><td><code>${escapeHtml(t.name)}</code></td><td>${escapeHtml(
        t.description.split(".")[0] ?? "",
      )}.</td></tr>`,
  ).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nominal MCP Server</title><style>
:root{--bg:#fff;--fg:#12141a;--mut:#5b6472;--line:#e3e6ec;--acc:#1f6feb;--code:#f4f6fa}
@media(prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e6e9ef;--mut:#9aa4b2;--line:#242a33;--acc:#4c8dff;--code:#161b22}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.6 ui-sans-serif,-apple-system,system-ui,"Segoe UI",sans-serif;
display:flex;justify-content:center;padding:48px 20px 80px}
main{width:100%;max-width:760px}h1{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:16px;margin:34px 0 10px;padding-top:16px;border-top:1px solid var(--line)}
.sub{color:var(--mut);margin:0 0 6px}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 0}
.badge{font-size:12px;padding:3px 9px;border:1px solid var(--line);border-radius:99px;color:var(--mut)}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px 14px;
overflow-x:auto;font-size:13px;margin:10px 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
table{width:100%;border-collapse:collapse;margin-top:8px;display:block;overflow-x:auto}
td{padding:7px 10px;border-bottom:1px solid var(--line);font-size:13.5px;vertical-align:top}
td:first-child{white-space:nowrap;width:1%}
a{color:var(--acc)}.mut{color:var(--mut);font-size:13.5px}
ul{padding-left:20px}li{margin:4px 0;font-size:14px}
</style></head><body><main>
<h1>Nominal MCP Server</h1>
<p class="sub">The Nominal hardware test platform, reachable from any MCP client.</p>
<div class="badges">
  <span class="badge">MCP 2026-07-28</span>
  <span class="badge">+ 4 earlier revisions</span>
  <span class="badge">${TOOL_DEFINITIONS.length} tools</span>
  <span class="badge">${CATALOG_STATS.total} API operations</span>
  <span class="badge">OAuth 2.1</span>
</div>

<h2>Connect from Claude Code</h2>
<pre>claude mcp add --transport http nominal ${escapeHtml(origin)}/mcp</pre>
<p class="mut">A browser window opens; paste your own Nominal API key (Settings &rarr; API keys).
Your key is encrypted into an access token scoped to this server and is never stored in plaintext.
Every call to Nominal uses your credential, so this connection can never see more than your
account already can.</p>

<h2>Or run it locally over stdio</h2>
<pre>NOMINAL_API_KEY=&lt;your key&gt; npx nominal-mcp</pre>

<h2>Tools</h2>
<table><tbody>${tools}</tbody></table>
<p class="mut">The other ${CATALOG_STATS.total} API operations are reachable through
<code>nominal_api_search</code> and <code>nominal_api_call</code> rather than as tool schemas —
467 schemas would cost roughly 163k tokens in every request.</p>

<h2>Endpoints</h2>
<ul>
<li><code>POST /mcp</code> — MCP endpoint</li>
<li><code>GET /.well-known/oauth-protected-resource</code> — RFC 9728</li>
<li><code>GET /.well-known/oauth-authorization-server</code> — RFC 8414</li>
<li><code>GET /health</code></li>
</ul>

<h2>Source</h2>
<p class="mut"><a href="https://github.com/elirapport1/nominal-mcp">github.com/elirapport1/nominal-mcp</a>
 — spec, conformance suite, and the fuzzer that runs against this deployment every 20 minutes.</p>
</main></body></html>`;
}
