/**
 * Fuzz runner.
 *
 * Runs the six generators against either the in-process Worker (default) or a
 * live deployment (`--target https://...`), and checks seven invariants that
 * must hold for every single response.
 *
 * Usage:
 *   npm run test:fuzz
 *   npx tsx test/fuzz/run.ts --cases 4000 --seed 12345
 *   npx tsx test/fuzz/run.ts --target https://nominal-mcp.workers.dev --cases 500
 *
 * A failure prints the seed and the exact case so it replays deterministically.
 */
import {
  authCases,
  catalogCases,
  injectionCases,
  protocolCases,
  structuralCases,
  rng,
  type FuzzCase,
} from "./generators.js";
import { OPERATIONS } from "../../src/tools/catalog.js";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TARGET = arg("target");
const TOTAL = Number(arg("cases", "3000"));
const SEED = Number(arg("seed", String(Date.now() % 2_147_483_647)));
const VERBOSE = process.argv.includes("--verbose");
/**
 * Requests per second. Unlimited in-process; paced against a live target so the
 * run exercises the protocol rather than the rate limiter (which defaults to
 * 120 rpm and would otherwise answer 429 to most cases).
 */
const RPS = Number(arg("rps", TARGET ? "1.6" : "0"));

const ALL_GENERATORS = ["structural", "protocol", "tool-args", "catalog", "auth", "injection"] as const;
type GeneratorName = (typeof ALL_GENERATORS)[number];

/**
 * Generators that never reach Nominal: their cases are refused at the protocol
 * or auth layer before any tool runs. This is the default set for a live
 * target, because fuzzing a deployment must not turn into load against
 * someone else's production API.
 */
const SAFE_FOR_LIVE: GeneratorName[] = ["structural", "protocol", "auth"];

const selected: GeneratorName[] = (() => {
  const explicit = arg("generators");
  if (explicit) {
    const names = explicit.split(",").map((s) => s.trim()) as GeneratorName[];
    const bad = names.filter((n) => !ALL_GENERATORS.includes(n));
    if (bad.length) {
      console.error(`unknown generator(s): ${bad.join(", ")}`);
      console.error(`available: ${ALL_GENERATORS.join(", ")}`);
      process.exit(2);
    }
    return names;
  }
  return TARGET ? SAFE_FOR_LIVE : [...ALL_GENERATORS];
})();

// ---------------------------------------------------------------------------
// Invariants (SPEC.md §9.4)
// ---------------------------------------------------------------------------

export interface Violation {
  invariant: string;
  detail: string;
  generator: string;
  label: string;
  body: string;
  status: number;
  responseSnippet: string;
}

/** Substrings that must never appear in any response body. */
const SECRET_MARKERS = [
  "TOKEN_SECRET",
  "HANDLE_SECRET",
  "nominal-test-api-key",
  "test-token-secret",
  "test-handle-secret",
  "OAUTH_KV",
  "at Object.",
  "at async",
  ".ts:",
  "node_modules",
  "Uncaught",
  "ReferenceError",
  "TypeError:",
  "SyntaxError:",
];

const INTERNAL_IDS = new Set(OPERATIONS.filter((o) => o.policy === "internal").map((o) => o.id));

const MAX_RESPONSE_BYTES = 64 * 1024;
/** Generous: the budget applies to the tool result, plus protocol envelope. */
const MAX_RESPONSE_BYTES_HARD = 256 * 1024;

function checkInvariants(
  c: FuzzCase,
  status: number,
  text: string,
  elapsedMs: number,
): Violation[] {
  const v: Violation[] = [];
  const snippet = text.slice(0, 400);
  const add = (invariant: string, detail: string) =>
    v.push({
      invariant,
      detail,
      generator: c.generator,
      label: c.label,
      body: c.body.slice(0, 600),
      status,
      responseSnippet: snippet,
    });

  // 1. Never a 5xx. Every failure is typed.
  if (status >= 500) add("no-5xx", `HTTP ${status}`);

  // 2. Valid JSON-RPC 2.0 (202 notifications legitimately have no body).
  let parsed: any = null;
  if (status !== 202 && status !== 204) {
    if (!text) {
      add("valid-jsonrpc", "empty body");
    } else {
      try {
        parsed = JSON.parse(text);
      } catch {
        add("valid-jsonrpc", "response is not JSON");
      }
      if (parsed) {
        if (parsed.jsonrpc !== "2.0") add("valid-jsonrpc", `jsonrpc=${parsed.jsonrpc}`);
        const hasResult = "result" in parsed;
        const hasError = "error" in parsed;
        if (hasResult === hasError) {
          add("valid-jsonrpc", "must have exactly one of result/error");
        }
        if (hasError) {
          if (typeof parsed.error?.code !== "number") add("valid-jsonrpc", "error.code not a number");
          if (typeof parsed.error?.message !== "string") add("valid-jsonrpc", "error.message not a string");
          // Reserved MCP sub-range may only carry spec-defined codes.
          const code = parsed.error?.code;
          if (code <= -32020 && code >= -32099 && ![-32020, -32021, -32022].includes(code)) {
            add("reserved-error-range", `undefined code ${code} in the MCP-reserved range`);
          }
        }
      }
    }
  }

  // 3. No secret, credential, internal host, or stack trace ever reflected.
  //    A marker that was already in the request is the caller's own string
  //    being echoed back as data, not a leak — only flag what the server
  //    introduced by itself.
  for (const marker of SECRET_MARKERS) {
    if (text.includes(marker) && !c.body.includes(marker)) {
      add("no-leak", `response contains ${JSON.stringify(marker)}`);
    }
  }

  // 4. resultType present iff the negotiated era is modern.
  if (parsed?.result) {
    const bodyVersion = /"io\.modelcontextprotocol\/protocolVersion":"([^"]+)"/.exec(c.body)?.[1];
    if (bodyVersion === "2026-07-28") {
      if (parsed.result.resultType !== "complete" && parsed.result.resultType !== "input_required") {
        add("result-type", `modern result missing resultType (got ${parsed.result.resultType})`);
      }
    } else if (bodyVersion && parsed.result.resultType !== undefined) {
      add("result-type", `legacy (${bodyVersion}) result carried resultType`);
    }
  }

  // 5. Latency ceiling.
  if (elapsedMs > 5000) add("latency", `${elapsedMs}ms`);

  // 6. No internal-policy operation ever executes.
  if (parsed?.result && !parsed.result.isError) {
    const opId = parsed.result.structuredContent?.operation_id;
    if (typeof opId === "string" && INTERNAL_IDS.has(opId)) {
      add("internal-blocked", `internal operation ${opId} executed`);
    }
  }
  // Also: the search tool must never advertise an internal operation.
  if (parsed?.result?.structuredContent?.operations) {
    for (const o of parsed.result.structuredContent.operations) {
      if (INTERNAL_IDS.has(o?.operation_id)) {
        add("internal-blocked", `internal operation ${o.operation_id} advertised by api_search`);
      }
    }
  }

  // 7. Response size bounded.
  if (text.length > MAX_RESPONSE_BYTES_HARD) {
    add("size", `${text.length} bytes > ${MAX_RESPONSE_BYTES_HARD}`);
  }

  // 8. Injection payloads must not come back as model-readable instructions.
  //    They may appear inside structuredContent as echoed argument values —
  //    that is data. They must not appear in a `content` text block that is
  //    not JSON, which is the channel the model reads as prose.
  if (c.generator === "injection" && parsed?.result?.content) {
    for (const block of parsed.result.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        try {
          JSON.parse(block.text);
        } catch {
          add("no-prose-echo", "tool returned a non-JSON text block on an injection case");
        }
      }
    }
  }

  return v;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

type Send = (c: FuzzCase) => Promise<{ status: number; text: string }>;

async function inProcessSend(): Promise<{ send: Send; token: string }> {
  const h = await import("../harness.js");
  h.installFetchStub();
  h.installDefaultRoutes();
  const token = await h.testToken();
  const worker = h.worker;

  const send: Send = async (c) => {
    const headers: Record<string, string> = { ...c.headers };
    if (!c.anonymous) {
      headers["authorization"] = c.authOverride ?? `Bearer ${token}`;
    }
    const req = new Request(`${h.TEST_ORIGIN}/mcp`, {
      method: "POST",
      headers,
      body: c.body,
    });
    const res = await worker.fetch(req, h.testEnv);
    return { status: res.status, text: await res.text() };
  };
  return { send, token };
}

function liveSend(target: string, token: string): Send {
  const url = target.replace(/\/$/, "").endsWith("/mcp")
    ? target.replace(/\/$/, "")
    : `${target.replace(/\/$/, "")}/mcp`;
  return async (c) => {
    const headers: Record<string, string> = { ...c.headers };
    if (!c.anonymous) headers["authorization"] = c.authOverride ?? `Bearer ${token}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: c.body,
        signal: AbortSignal.timeout(15_000),
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return { status: 599, text: `__transport_error__ ${e instanceof Error ? e.message : String(e)}` };
    }
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const r = rng(SEED);
  const per = Math.max(1, Math.floor(TOTAL / selected.length));

  let send: Send;
  let token: string;
  if (TARGET) {
    token = process.env["NOMINAL_API_KEY"] ?? "nmcp_placeholder_no_credential_supplied";
    send = liveSend(TARGET, token);
  } else {
    const ip = await inProcessSend();
    send = ip.send;
    token = ip.token;
  }

  const { toolArgCases } = await import("./generators.js");
  const build: Record<GeneratorName, () => FuzzCase[]> = {
    structural: () => structuralCases(r, per),
    protocol: () => protocolCases(r, per),
    "tool-args": () => toolArgCases(r, per),
    catalog: () => catalogCases(r, per),
    auth: () => authCases(r, per, token),
    injection: () => injectionCases(r, per),
  };

  const cases: FuzzCase[] = [];
  for (const name of selected) cases.push(...build[name]());

  console.log(
    `fuzzing ${cases.length} cases  seed=${SEED}  target=${TARGET ?? "in-process"}`,
  );
  console.log(`generators: ${selected.join(", ")}`);
  const skipped = ALL_GENERATORS.filter((g) => !selected.includes(g));
  if (skipped.length) {
    // Never let reduced coverage look like full coverage.
    console.log(`skipped:    ${skipped.join(", ")}${TARGET ? " (would call the live Nominal API)" : ""}`);
  }

  const violations: Violation[] = [];
  // A tool-level rejection is HTTP 200 with isError:true, so counting only
  // HTTP status would report refused internal operations as "accepted".
  const byGenerator: Record<
    string,
    { n: number; ok: number; protocolRejected: number; toolRejected: number }
  > = {};
  const statuses: Record<number, number> = {};
  let maxMs = 0;
  let totalMs = 0;
  const started = Date.now();

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    byGenerator[c.generator] ??= { n: 0, ok: 0, protocolRejected: 0, toolRejected: 0 };
    byGenerator[c.generator]!.n++;

    if (RPS > 0) await sleep(1000 / RPS);
    const t0 = Date.now();
    const { status, text } = await send(c);
    const ms = Date.now() - t0;
    totalMs += ms;
    if (ms > maxMs) maxMs = ms;
    statuses[status] = (statuses[status] ?? 0) + 1;

    if (status >= 400) byGenerator[c.generator]!.protocolRejected++;
    else if (text.includes('"isError":true')) byGenerator[c.generator]!.toolRejected++;
    else byGenerator[c.generator]!.ok++;

    violations.push(...checkInvariants(c, status, text, ms));

    if (VERBOSE && i % 250 === 0) {
      process.stdout.write(`  ${i}/${cases.length}\r`);
    }
  }

  const wall = Date.now() - started;
  console.log(`\ncompleted in ${(wall / 1000).toFixed(1)}s  avg ${(totalMs / cases.length).toFixed(1)}ms  max ${maxMs}ms\n`);

  console.log("by generator:");
  for (const [g, s] of Object.entries(byGenerator)) {
    console.log(
      `  ${g.padEnd(12)} ${String(s.n).padStart(5)} cases  ` +
        `${String(s.ok).padStart(5)} ok  ` +
        `${String(s.protocolRejected).padStart(5)} protocol-rejected  ` +
        `${String(s.toolRejected).padStart(5)} tool-rejected`,
    );
  }
  const throttled = statuses[429] ?? 0;
  if (throttled > cases.length * 0.1) {
    console.log(
      `\nnote: ${throttled}/${cases.length} responses were 429 (rate limited). ` +
        `Coverage is reduced — lower --rps or raise RATE_LIMIT_RPM on the target.`,
    );
  }

  console.log("\nstatus codes:");
  for (const [s, n] of Object.entries(statuses).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  ${s}  ${n}`);
  }

  if (violations.length === 0) {
    console.log(`\nAll invariants held across ${cases.length} cases. seed=${SEED}`);
    return;
  }

  // Group violations so a systemic failure reports once, not 900 times.
  const grouped = new Map<string, Violation[]>();
  for (const v of violations) {
    const key = `${v.invariant}::${v.detail}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(v);
  }

  console.error(`\n${violations.length} invariant violation(s) in ${grouped.size} distinct group(s):\n`);
  for (const [key, vs] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const first = vs[0]!;
    console.error(`  [${first.invariant}] ${first.detail}  (x${vs.length})`);
    console.error(`     generator: ${first.generator}`);
    console.error(`     case:      ${first.label}`);
    console.error(`     status:    ${first.status}`);
    console.error(`     request:   ${first.body.slice(0, 300)}`);
    console.error(`     response:  ${first.responseSnippet.slice(0, 300)}`);
    console.error("");
  }
  console.error(`Replay with: npx tsx test/fuzz/run.ts --seed ${SEED} --cases ${TOTAL}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("fuzz runner crashed:", e);
  process.exit(2);
});
