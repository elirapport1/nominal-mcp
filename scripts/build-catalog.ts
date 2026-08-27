/**
 * Builds the shipped operation catalog from the raw Conjure extraction.
 *
 * Input:  src/nominal/catalog.raw.json  (467 endpoints, extracted from the
 *         `nominal-api` PyPI package by scripts/extract-catalog.py)
 * Output: src/nominal/catalog.json      (classified, compacted, policy-tagged)
 *
 * The raw file is gitignored; the built file is committed so CI and the Worker
 * never need Python.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, "../src/nominal/catalog.raw.json");
const OUT = join(here, "../src/nominal/catalog.json");

interface RawOp {
  service: string;
  op: string;
  method: string;
  path: string;
  path_params: Record<string, string>;
  query_params: Record<string, string>;
  body_arg: string | null;
  args: string[];
  arg_types: Record<string, string>;
  returns: string;
  binary: boolean;
}

/** Operations that a user-delegated agent token must never reach. */
const INTERNAL_PATTERNS: RegExp[] = [
  /\/internal\//,
  /-internal\/v\d/,
  /\bInternal[A-Za-z]*Service$/,
  /^secrets\/internal/,
];
const INTERNAL_OPS = new Set([
  "authorization.InternalApiKeyService.get_access_token_from_api_key_value",
  "authorization.InternalSandboxTokenService.issue_sandbox_token",
  "secrets_api.InternalSecretService.get_decrypted",
  "authorization.AuthorizationService.create_api_key",
  "authorization.AuthorizationService.revoke_api_key",
  "authorization.AuthorizationService.get_access_token",
  "authorization.AuthorizationService.refresh_access_token",
  "authorization.AuthorizationService.list_api_keys_in_org",
  "authorization.AuthorizationService.list_user_api_keys",
  "authorization.AuthorizationService.set_user_org",
  "usercreation_api.InternalUserCreationService.ensure_database_user_exists",
  "usage_internal.InternalUsageMetadataService.set_usage_dataset_for_workspace",
]);

/**
 * Verbs that indicate a state change. Matched against the operation name with
 * any `batch_` prefix stripped, so `batch_cancel_ingest_jobs` classifies the
 * same as `cancel_ingest_job` — an earlier anchored regex missed exactly that
 * case and left a mutation marked read-only.
 *
 * Applied regardless of HTTP verb: Nominal has at least one GET whose name
 * implies creation (`create_slack_webhook`, an OAuth redirect handler), and
 * requiring write scope for it is the safe direction to be wrong in.
 */
const MUTATING_WORDS =
  /^(create|update|delete|archive|unarchive|set|add|remove|write|ingest|reingest|rerun|commit|merge|lock|unlock|duplicate|register|revoke|cancel|abort|complete|initiate|upload|persist|clear|index|mark|save|execute|stop|reload|start|end|generate|rotate|send|test|populate|submit|issue|change|pin|unpin|edit|perform|kill|apply|move|copy|restore|reset|enable|disable|attach|detach|link|unlink|publish|import|export)/;

/**
 * Operations whose names read like queries but which change state.
 * `ensure_*` creates the resource when it is absent; `sign_part` mints a
 * credential for an in-progress multipart upload.
 */
const FORCE_MUTATING = new Set([
  "storage_datasource_api.NominalDataSourceService.ensure_dataset_for_data_source",
  "upload_api.UploadService.sign_part",
]);

/** Strips batch_/internal wrappers so the real verb is what gets matched. */
function normalizeOpName(op: string): string {
  return op.replace(/^(batch_|bulk_|try_)+/, "");
}

/** Coarse domain grouping, used to bias search and to give the agent a hint. */
function domainOf(service: string, path: string): string {
  const s = service.toLowerCase();
  const p = path.toLowerCase();
  if (/video/.test(s) || /video/.test(p)) return "video";
  if (/asset/.test(s)) return "assets";
  if (/run/.test(s)) return "runs";
  if (/catalog|dataset/.test(s)) return "datasets";
  if (/channel|timeseries|tag_api|datasource/.test(s)) return "channels";
  if (/compute/.test(s)) return "compute";
  if (/check|datareview/.test(s)) return "checks";
  if (/notebook|template|savedviews|layout|chart|theme/.test(s)) return "workbooks";
  if (/event/.test(s)) return "events";
  if (/ingest|upload|storage_writer/.test(s)) return "ingest";
  if (/attachment|comment/.test(s)) return "attachments";
  if (/auth|secret|workspace|usercreation/.test(s)) return "admin";
  if (/connection|integration/.test(s)) return "connections";
  if (/version/.test(s)) return "versioning";
  return "other";
}

/** Human-readable summary generated from the operation name. */
function summarize(op: string, service: string): string {
  const subject = service.split(".").pop()!.replace(/Service$/, "");
  const words = op.replace(/_/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} — ${subject}`;
}

const raw = JSON.parse(readFileSync(RAW, "utf8")) as RawOp[];

const ops = raw.map((r) => {
  const id = `${r.service}.${r.op}`;
  const isInternal =
    INTERNAL_OPS.has(id) ||
    INTERNAL_PATTERNS.some((re) => re.test(r.path) || re.test(r.service));
  const mutating =
    MUTATING_WORDS.test(normalizeOpName(r.op)) || FORCE_MUTATING.has(id);

  // Args, minus the ones the transport binds itself.
  const argNames = r.args.filter((a) => a !== "auth_header");

  return {
    id,
    op: r.op,
    service: r.service,
    method: r.method,
    path: r.path,
    pathParams: Object.keys(r.path_params),
    queryParams: Object.keys(r.query_params),
    bodyArg: r.body_arg && r.body_arg !== "None" ? r.body_arg : null,
    args: argNames,
    argTypes: Object.fromEntries(
      Object.entries(r.arg_types).map(([k, v]) => [k, simplifyType(v)]),
    ),
    binary: r.binary,
    policy: isInternal ? "internal" : mutating ? "mutating" : "read",
    domain: domainOf(r.service, r.path),
    summary: summarize(r.op, r.service),
    // Pre-computed lowercase search haystack — keeps the hot path allocation-free.
    hay: `${r.op} ${r.service} ${r.path} ${argNames.join(" ")}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " "),
  };
});

function simplifyType(t: string): string {
  return t
    .replace(/<class '(.+?)'>/, "$1")
    .replace(/typing\./g, "")
    .replace(/nominal_api\.?[a-z_]*\./g, "")
    .replace(/\bstr\b/g, "string")
    .replace(/\bbool\b/g, "boolean")
    .replace(/\bint\b/g, "integer")
    .trim();
}

ops.sort((a, b) => a.id.localeCompare(b.id));

const byPolicy = ops.reduce<Record<string, number>>((acc, o) => {
  acc[o.policy] = (acc[o.policy] ?? 0) + 1;
  return acc;
}, {});
const byDomain = ops.reduce<Record<string, number>>((acc, o) => {
  acc[o.domain] = (acc[o.domain] ?? 0) + 1;
  return acc;
}, {});

writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedFrom: "nominal-api (PyPI)",
      operationCount: ops.length,
      byPolicy,
      byDomain,
      operations: ops,
    },
    null,
    0,
  ),
);

console.log(`catalog: ${ops.length} operations -> ${OUT}`);
console.log("  by policy:", byPolicy);
console.log("  by domain:", byDomain);
const bytes = readFileSync(OUT).length;
console.log(`  size: ${(bytes / 1024).toFixed(1)} KB`);
