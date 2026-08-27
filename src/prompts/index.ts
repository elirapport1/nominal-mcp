/**
 * Prompts: short, named workflows.
 *
 * These exist because they measurably improve trajectory. An agent given
 * "investigate the anomaly" picks tools ad hoc; an agent given the same task
 * with the tool order named tends to describe channels before querying them,
 * which is the single most common trajectory failure.
 *
 * Prompt text is authored here and never interpolates tenant data — only the
 * user's own arguments, which the host collected.
 */
import type { PromptDefinition, PromptMessage } from "../protocol/types.js";

interface PromptImpl {
  def: PromptDefinition;
  build: (args: Record<string, string>) => PromptMessage[];
}

const user = (text: string): PromptMessage => ({
  role: "user",
  content: { type: "text", text },
});

export const PROMPTS: PromptImpl[] = [
  {
    def: {
      name: "investigate_anomaly",
      title: "Investigate an anomaly",
      description:
        "Structured investigation of anomalous behaviour in a test run, ending in a written finding.",
      arguments: [
        { name: "run", description: "Run uri or RID.", required: true },
        { name: "symptom", description: "What looked wrong, in the engineer's words.", required: true },
      ],
    },
    build: (a) => [
      user(
        `Investigate a possible anomaly in Nominal test run ${a["run"]}.

Reported symptom: ${a["symptom"]}

Work in this order:
1. nominal_get on the run — confirm its time bounds and attached data sources.
2. nominal_describe_channels — find the channels relevant to the symptom. Use the real
   channel names; do not guess them.
3. nominal_query_channels over the run window — read the stats and the decimated trace,
   and look for where the shape departs from the rest of the run.
4. Narrow to the interesting sub-window and query again at higher resolution.
5. nominal_compute for any exact figure you want to quote.

Report: what you found, the channels and time window that show it, and what you could not
determine. If the data does not support a conclusion, say so — do not infer a cause from a
correlation you have not checked.`,
      ),
    ],
  },
  {
    def: {
      name: "compare_runs",
      title: "Compare two runs",
      description: "Compare the same channels across two runs and report the differences.",
      arguments: [
        { name: "run_a", description: "First run uri or RID.", required: true },
        { name: "run_b", description: "Second run uri or RID.", required: true },
        { name: "channels", description: "Comma-separated channel names, if known.", required: false },
      ],
    },
    build: (a) => [
      user(
        `Compare Nominal runs ${a["run_a"]} and ${a["run_b"]}.
${a["channels"] ? `Focus on these channels: ${a["channels"]}` : "Use nominal_describe_channels on both runs and compare the channels they share."}

For each channel, pull stats from both runs with nominal_query_channels and report min/max/mean
side by side, flagging any channel whose mean differs by more than 5% or whose extremes differ in
sign. Note explicitly any channel present in one run but not the other — that difference is often
the actual finding.`,
      ),
    ],
  },
  {
    def: {
      name: "summarize_run",
      title: "Summarize a run",
      description: "One-paragraph summary of a run plus its notable channels.",
      arguments: [{ name: "run", description: "Run uri or RID.", required: true }],
    },
    build: (a) => [
      user(
        `Summarize Nominal test run ${a["run"]}.

Use nominal_get for metadata and nominal_describe_channels for what was recorded. Sample the
handful of channels that look most load-bearing with nominal_query_channels. Produce: what was
tested, when, for how long, what was instrumented, and anything in the data that a reviewer
should look at. Keep it to one paragraph plus a short bullet list.`,
      ),
    ],
  },
  {
    def: {
      name: "preflight_check",
      title: "Pre-test readiness check",
      description: "Check an asset's recent history before the next test.",
      arguments: [{ name: "asset", description: "Asset uri or RID.", required: true }],
    },
    build: (a) => [
      user(
        `Run a pre-test readiness review for Nominal asset ${a["asset"]}.

1. nominal_get on the asset.
2. nominal_list_runs for its last 10 runs.
3. nominal_search for events on this asset with kind="event" — look for flags and errors.
4. For the most recent run, describe and spot-check the primary channels.

Report whether anything in the recent history should block the next test, and name the specific
run or event behind each concern.`,
      ),
    ],
  },
];

export const PROMPTS_BY_NAME = new Map(PROMPTS.map((p) => [p.def.name, p]));

export function getPromptMessages(
  name: string,
  args: Record<string, string>,
): { description: string; messages: PromptMessage[] } {
  const p = PROMPTS_BY_NAME.get(name);
  if (!p) throw new Error(`Unknown prompt: ${name}`);
  for (const arg of p.def.arguments ?? []) {
    if (arg.required && !args[arg.name]) {
      throw new Error(`Prompt '${name}' requires argument '${arg.name}'.`);
    }
  }
  return { description: p.def.description, messages: p.build(args) };
}
