/**
 * Measures the `tools/list` payload and fails the build if it exceeds the
 * budget in SPEC.md §4.1.
 *
 * Rationale: every token in tools/list is charged to every request in every
 * session the user has open, whether or not they touch Nominal. It is the one
 * cost this server imposes on people who never call it, so it gets a hard cap
 * enforced by CI rather than a guideline.
 */
import { TOOL_DEFINITIONS } from "../src/transport/handler.js";
import { CATALOG_STATS } from "../src/tools/catalog.js";

const BUDGET = 3000;

/**
 * Approximate GPT/Claude-style BPE token count. Deliberately conservative:
 * it over-counts punctuation-dense JSON slightly, so passing here means
 * passing with a real tokenizer.
 */
function estimateTokens(s: string): number {
  const words = s.match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g) ?? [];
  let n = 0;
  for (const w of words) {
    if (/^[A-Za-z]+$/.test(w)) n += Math.max(1, Math.ceil(w.length / 4));
    else if (/^\d+$/.test(w)) n += Math.max(1, Math.ceil(w.length / 3));
    else n += 1;
  }
  return n;
}

const payload = JSON.stringify({ tools: TOOL_DEFINITIONS });
const total = estimateTokens(payload);

const rows = TOOL_DEFINITIONS.map((t) => ({
  name: t.name,
  tokens: estimateTokens(JSON.stringify(t)),
})).sort((a, b) => b.tokens - a.tokens);

console.log("tools/list token budget\n");
console.log(`  tools:           ${TOOL_DEFINITIONS.length}`);
console.log(`  bytes:           ${payload.length}`);
console.log(`  estimated tokens ${total} / ${BUDGET}`);
console.log(`  reachable ops:   ${CATALOG_STATS.total} (via nominal_api_search)\n`);

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  const bar = "█".repeat(Math.round((r.tokens / rows[0]!.tokens) * 28));
  console.log(`  ${r.name.padEnd(width)}  ${String(r.tokens).padStart(4)}  ${bar}`);
}

// What the naive alternative would have cost, for the record.
const naive = CATALOG_STATS.total * 350;
console.log(
  `\n  For comparison: exposing all ${CATALOG_STATS.total} operations as tools would cost` +
    ` roughly ${naive.toLocaleString()} tokens (~${Math.round(naive / total)}x this).`,
);

if (total > BUDGET) {
  console.error(`\nFAIL: tools/list is ${total} tokens, over the ${BUDGET} budget.`);
  console.error("Shorten a description, or move a tool behind nominal_api_search.");
  process.exit(1);
}
console.log(`\nOK: ${BUDGET - total} tokens under budget.`);
