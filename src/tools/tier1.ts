/**
 * Tier-1 tools: the always-loaded surface.
 *
 * Budget: the whole `tools/list` payload must stay under 3,000 tokens, because
 * every token here is charged to every request in every session the user has,
 * whether or not they touch Nominal. `npm run budget` enforces it in CI.
 *
 * Authoring rules (from CLAUDE.md, and they are load-bearing):
 *   - name for the agent's mental model, not the API's
 *   - one job per tool; a description needing "or" is two tools
 *   - errors say what to call instead
 *   - ambiguity is a return value, never a guess
 */
import { NominalClient, NominalError } from "../nominal/client.js";
import { hasScope } from "../auth/token.js";
import {
  clampLimit,
  decimate,
  signHandle,
  summarize,
  verifyHandle,
  MAX_DECIMATED_POINTS,
  MAX_SEARCH_LIMIT,
  HANDLE_TTL_SECONDS,
} from "../limits/budget.js";
import { buildNominalUri, isRid, isUuid, parseNominalUri, parseRid } from "../nominal/rid.js";
import type { RequestContext, ToolDefinition } from "../protocol/types.js";

export interface ToolHandlerArgs {
  args: Record<string, unknown>;
  ctx: RequestContext;
  client: NominalClient;
  handleSecret: string;
}

export type ToolHandler = (a: ToolHandlerArgs) => Promise<unknown>;

/** Thrown for caller-fixable problems; surfaced as `isError: true`, not JSON-RPC. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ToolError(`'${name}' is required and must be a non-empty string.`);
  }
  return v.trim();
}

function optString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError(`'${name}' must be a string.`);
  return v.trim() || undefined;
}

function requireWrite(ctx: RequestContext): void {
  if (!ctx.auth || !hasScope(ctx.auth, "nominal:write")) {
    throw new ToolError(
      "This operation needs the 'nominal:write' scope; this connection is read-only. Reconnect and grant write access.",
    );
  }
}

/** ISO-8601 -> Nominal's { seconds, nanos } UTC timestamp. */
function toUtcTimestamp(iso: string, field: string): { seconds: number; nanos: number } {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new ToolError(
      `'${field}' must be an ISO-8601 timestamp such as 2026-03-01T14:00:00Z; received ${JSON.stringify(iso)}.`,
    );
  }
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 };
}

function fromUtcTimestamp(ts: unknown): string | null {
  if (!ts || typeof ts !== "object") return null;
  const t = ts as { seconds?: number | string; nanos?: number };
  const sec = typeof t.seconds === "string" ? Number(t.seconds) : t.seconds;
  if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000 + Math.floor((t.nanos ?? 0) / 1e6)).toISOString();
}

// ===========================================================================
// nominal_search
// ===========================================================================

const SEARCH_KINDS = ["asset", "run", "dataset", "workbook", "checklist", "event", "video"] as const;
type SearchKind = (typeof SEARCH_KINDS)[number];

const searchTargets: Record<
  SearchKind,
  { path: string; build: (q: string, limit: number, cursor?: string) => unknown; extract: (r: any) => any[] }
> = {
  asset: {
    path: "/scout/v1/search-assets",
    build: (q, limit, cursor) => ({
      sort: { isDescending: true, field: "CREATED_AT" },
      pageSize: limit,
      nextPageToken: cursor ?? null,
      query: q ? { type: "searchText", searchText: q } : { type: "archived", archived: false },
    }),
    extract: (r) => r?.results ?? [],
  },
  run: {
    path: "/scout/v1/search-runs",
    build: (q, limit, cursor) => ({
      sort: { isDescending: true, field: "START_TIME" },
      pageSize: limit,
      nextPageToken: cursor ?? null,
      query: q ? { type: "searchText", searchText: q } : { type: "archived", archived: false },
    }),
    extract: (r) => r?.results ?? [],
  },
  dataset: {
    path: "/catalog/v1/search-datasets-v2",
    build: (q, limit, cursor) => ({
      sort: { isDescending: true, field: "CREATED_AT" },
      pageSize: limit,
      nextPageToken: cursor ?? null,
      query: q ? { type: "searchText", searchText: q } : { type: "archived", archived: false },
    }),
    extract: (r) => r?.results ?? [],
  },
  workbook: {
    path: "/scout/v2/notebook/search",
    build: (q, limit, cursor) => ({
      sort: { isDescending: true, field: "CREATED_AT" },
      pageSize: limit,
      nextPageToken: cursor ?? null,
      query: q ? { type: "searchText", searchText: q } : { type: "archived", archived: false },
    }),
    extract: (r) => r?.results ?? [],
  },
  checklist: {
    path: "/scout/v1/checklists/search",
    build: (q, limit, cursor) => ({
      sort: { isDescending: true, field: "CREATED_AT" },
      pageSize: limit,
      nextPageToken: cursor ?? null,
      query: q ? { type: "searchText", searchText: q } : { type: "archived", archived: false },
    }),
    extract: (r) => r?.values ?? r?.results ?? [],
  },
  event: {
    path: "/event/v1/search-events",
    build: (q, limit, cursor) => ({
      sort: { isDescending: true, field: "START_TIME" },
      pageSize: limit,
      nextPageToken: cursor ?? null,
      query: q ? { type: "searchText", searchText: q } : { type: "archived", archived: false },
    }),
    extract: (r) => r?.results ?? [],
  },
  video: {
    path: "/video/v1/videos/search",
    build: (q, limit, cursor) => ({
      sort: { isDescending: true, field: "CREATED_AT" },
      pageSize: limit,
      nextPageToken: cursor ?? null,
      query: q ? { type: "searchText", searchText: q } : { type: "archived", archived: false },
    }),
    extract: (r) => r?.results ?? [],
  },
};

/** Compact an API entity down to what an agent needs to decide what to do next. */
function compact(kind: SearchKind, e: any): Record<string, unknown> {
  const rid = e?.rid ?? e?.runRid ?? e?.assetRid ?? e?.datasetRid ?? e?.id ?? null;
  const out: Record<string, unknown> = {
    kind,
    rid,
    uri: rid ? buildNominalUri(kind === "video" ? "video" : (kind as any), rid) : null,
    name: e?.title ?? e?.name ?? e?.displayName ?? null,
  };
  if (e?.description) out["description"] = String(e.description).slice(0, 240);
  const start = fromUtcTimestamp(e?.startTime);
  const end = fromUtcTimestamp(e?.endTime);
  if (start) out["start_time"] = start;
  if (end) out["end_time"] = end;
  if (e?.runNumber !== undefined) out["run_number"] = e.runNumber;
  if (Array.isArray(e?.labels) && e.labels.length) out["labels"] = e.labels.slice(0, 12);
  if (e?.assetRid) out["asset_rid"] = e.assetRid;
  if (e?.createdAt) out["created_at"] = e.createdAt;
  return out;
}

export const searchTool: ToolHandler = async ({ args, ctx, client }) => {
  const query = optString(args, "query") ?? "";
  const kindArg = args["kind"];
  const { value: limit, notice } = clampLimit(args["limit"], MAX_SEARCH_LIMIT, 10);
  if (notice) ctx.notices.push(notice);
  const cursor = optString(args, "cursor");

  let kinds: SearchKind[];
  if (kindArg === undefined || kindArg === null || kindArg === "all") {
    kinds = ["asset", "run", "dataset", "event"];
  } else if (typeof kindArg === "string") {
    if (!SEARCH_KINDS.includes(kindArg as SearchKind)) {
      throw new ToolError(
        `Unknown kind ${JSON.stringify(String(kindArg).slice(0, 60))}. Use one of: ${SEARCH_KINDS.join(", ")}, or "all".`,
      );
    }
    kinds = [kindArg as SearchKind];
  } else {
    throw new ToolError(`'kind' must be a string. Use one of: ${SEARCH_KINDS.join(", ")}, or "all".`);
  }

  if (cursor && kinds.length > 1) {
    throw new ToolError("'cursor' can only be used with a single 'kind'. Set kind explicitly to page.");
  }

  const perKind = kinds.length > 1 ? Math.max(3, Math.floor(limit / kinds.length)) : limit;

  const settled = await Promise.allSettled(
    kinds.map(async (k) => {
      const t = searchTargets[k];
      const res = await client.call<any>({
        method: "POST",
        path: t.path,
        body: t.build(query, perKind, cursor),
      });
      return { kind: k, res };
    }),
  );

  const results: Record<string, unknown>[] = [];
  const unavailable: Record<string, string> = {};
  let nextCursor: string | null = null;

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]!;
    const k = kinds[i]!;
    if (s.status === "rejected") {
      const e = s.reason;
      // A kind the user can't see shouldn't fail the whole search.
      unavailable[k] = e instanceof NominalError ? e.message : String(e);
      continue;
    }
    const items = searchTargets[k].extract(s.value.res);
    for (const item of items) results.push(compact(k, item));
    if (kinds.length === 1) nextCursor = s.value.res?.nextPageToken ?? null;
  }

  return {
    query: query || null,
    kinds_searched: kinds,
    count: results.length,
    results,
    ...(nextCursor ? { cursor: nextCursor } : {}),
    ...(Object.keys(unavailable).length ? { unavailable } : {}),
  };
};

// ===========================================================================
// nominal_get
// ===========================================================================

export const getTool: ToolHandler = async ({ args, client, ctx, handleSecret }) => {
  const raw = requireString(args, "uri");
  const parsed = parseNominalUri(raw);

  if (!parsed) {
    if (isUuid(raw)) {
      const ds = await client.call<any>({
        method: "GET",
        path: `/catalog/v1/datasets/${encodeURIComponent(raw)}`,
      });
      return { kind: "dataset", uri: buildNominalUri("dataset", raw), entity: ds };
    }
    throw new ToolError(
      `Could not interpret ${JSON.stringify(raw)}. Pass a nominal:// URI (e.g. nominal://run/ri.scout...), a bare RID, or a dataset UUID.`,
      { hint: "Use nominal_search to find the RID first." },
    );
  }

  switch (parsed.kind) {
    case "run": {
      const run = await client.call<any>({
        method: "GET",
        path: `/scout/v1/run/${encodeURIComponent(parsed.id)}`,
      });
      return {
        kind: "run",
        uri: buildNominalUri("run", parsed.id),
        rid: parsed.id,
        name: run?.title ?? null,
        description: run?.description ?? null,
        start_time: fromUtcTimestamp(run?.startTime),
        end_time: fromUtcTimestamp(run?.endTime),
        run_number: run?.runNumber ?? null,
        labels: run?.labels ?? [],
        properties: run?.properties ?? {},
        asset_rids: run?.assets ?? [],
        data_sources: Object.keys(run?.dataSources ?? {}),
        next: "Use nominal_describe_channels with this uri to see available channels.",
      };
    }
    case "asset": {
      const map = await client.call<any>({
        method: "POST",
        path: "/scout/v1/asset/multiple",
        body: [parsed.id],
      });
      const asset = map?.[parsed.id];
      if (!asset) throw new ToolError(`No asset found for ${parsed.id}.`);
      return {
        kind: "asset",
        uri: buildNominalUri("asset", parsed.id),
        rid: parsed.id,
        name: asset?.title ?? asset?.name ?? null,
        description: asset?.description ?? null,
        labels: asset?.labels ?? [],
        properties: asset?.properties ?? {},
        next: "Use nominal_list_runs with this uri to see its test runs.",
      };
    }
    case "dataset": {
      const id = parsed.id;
      const uuid = isRid(id) ? (parseRid(id)?.locator ?? id) : id;
      const ds = await client.call<any>({
        method: "GET",
        path: `/catalog/v1/datasets/${encodeURIComponent(uuid)}`,
      });
      return { kind: "dataset", uri: buildNominalUri("dataset", id), rid: id, entity: ds };
    }
    case "event": {
      const res = await client.call<any>({
        method: "POST",
        path: "/event/v1/get-events",
        body: { uuids: [parsed.id] },
      });
      return { kind: "event", uri: buildNominalUri("event", parsed.id), entity: res };
    }
    case "handle": {
      const payload = await verifyHandle(parsed.id, handleSecret, client.subject);
      return {
        kind: "handle",
        handle_kind: payload.kind,
        query: payload.query,
        expires_at: new Date(payload.exp * 1000).toISOString(),
        note: "Pass this handle back to the tool that produced it to continue.",
      };
    }
    default:
      throw new ToolError(
        `nominal_get does not resolve '${parsed.kind}' yet. Use nominal_api_search to find a direct operation for it.`,
      );
  }
};

// ===========================================================================
// nominal_list_runs
// ===========================================================================

export const listRunsTool: ToolHandler = async ({ args, ctx, client }) => {
  const assetUri = optString(args, "asset");
  const { value: limit, notice } = clampLimit(args["limit"], 100, 25);
  if (notice) ctx.notices.push(notice);
  const since = optString(args, "since");
  const until = optString(args, "until");
  const cursor = optString(args, "cursor");

  const clauses: unknown[] = [];
  if (assetUri) {
    const parsed = parseNominalUri(assetUri);
    if (!parsed || parsed.kind !== "asset") {
      throw new ToolError(
        `'asset' must be an asset URI or RID (nominal://asset/ri.scout...). Received ${JSON.stringify(assetUri)}.`,
      );
    }
    clauses.push({ type: "asset", asset: parsed.id });
  }
  if (since) {
    clauses.push({ type: "startTimeInclusive", startTimeInclusive: toUtcTimestamp(since, "since") });
  }
  if (until) {
    clauses.push({ type: "endTimeInclusive", endTimeInclusive: toUtcTimestamp(until, "until") });
  }
  const search = optString(args, "query");
  if (search) clauses.push({ type: "searchText", searchText: search });

  const query =
    clauses.length === 0
      ? { type: "archived", archived: false }
      : clauses.length === 1
        ? clauses[0]
        : { type: "and", and: clauses };

  const res = await client.call<any>({
    method: "POST",
    path: "/scout/v1/search-runs",
    body: {
      sort: { isDescending: true, field: "START_TIME" },
      pageSize: limit,
      nextPageToken: cursor ?? null,
      query,
    },
  });

  const runs = (res?.results ?? []).map((r: any) => compact("run", r));
  return {
    count: runs.length,
    runs,
    ...(res?.nextPageToken ? { cursor: res.nextPageToken } : {}),
  };
};

// ===========================================================================
// nominal_describe_channels
// ===========================================================================

export const describeChannelsTool: ToolHandler = async ({ args, ctx, client }) => {
  const uri = requireString(args, "uri");
  const parsed = parseNominalUri(uri);
  if (!parsed || (parsed.kind !== "run" && parsed.kind !== "dataset")) {
    throw new ToolError(
      `'uri' must be a run or dataset URI. Received ${JSON.stringify(uri)}. Use nominal_search to find one.`,
    );
  }
  const { value: limit, notice } = clampLimit(args["limit"], 200, 50);
  if (notice) ctx.notices.push(notice);
  const filter = optString(args, "filter");

  // Resolve a run to the data sources it references.
  let dataSourceRids: string[];
  if (parsed.kind === "run") {
    const run = await client.call<any>({
      method: "GET",
      path: `/scout/v1/run/${encodeURIComponent(parsed.id)}`,
    });
    const ds = run?.dataSources ?? {};
    dataSourceRids = Object.values(ds)
      .map((d: any) => d?.dataSource?.dataset ?? d?.dataSource?.datasource ?? d?.dataSource ?? null)
      .filter((x: any): x is string => typeof x === "string");
    if (dataSourceRids.length === 0) {
      return {
        uri,
        channels: [],
        count: 0,
        note: "This run has no attached data sources, so it has no channels.",
      };
    }
  } else {
    dataSourceRids = [parsed.id];
  }

  const res = await client.call<any>({
    method: "POST",
    path: "/data-source/v1/data-sources/search-channels",
    body: {
      dataSources: dataSourceRids,
      exactMatch: [],
      fuzzySearchText: filter ?? "",
      previouslyReturnedChannels: [],
      pageSize: limit,
    },
  });

  const results = res?.results ?? [];
  const channels = results.slice(0, limit).map((c: any) => ({
    name: c?.name ?? c?.channel ?? null,
    data_source: c?.dataSource ?? null,
    unit: c?.unit?.symbol ?? c?.unit ?? null,
    type: c?.dataType ?? c?.type ?? null,
    ...(c?.tags && Object.keys(c.tags).length ? { tags: c.tags } : {}),
    uri:
      c?.dataSource && c?.name
        ? buildNominalUri("channel", c.dataSource, c.name)
        : null,
  }));

  return {
    uri,
    data_sources: dataSourceRids,
    count: channels.length,
    ...(results.length > limit ? { more_available: true } : {}),
    channels,
    next: "Use nominal_query_channels with these channel names to get statistics over a time window.",
  };
};

// ===========================================================================
// nominal_query_channels
// ===========================================================================

/**
 * Returns statistics plus at most 200 decimated points. It never returns raw
 * rows: a single channel in a long run is millions of samples, and the useful
 * signal for an agent is the shape plus the extremes.
 */
export const queryChannelsTool: ToolHandler = async ({ args, ctx, client, handleSecret }) => {
  const uri = requireString(args, "uri");
  const parsed = parseNominalUri(uri);
  if (!parsed || (parsed.kind !== "run" && parsed.kind !== "dataset")) {
    throw new ToolError(`'uri' must be a run or dataset URI. Received ${JSON.stringify(uri)}.`);
  }

  const rawChannels = args["channels"];
  if (!Array.isArray(rawChannels) || rawChannels.length === 0) {
    throw new ToolError(
      "'channels' must be a non-empty array of channel names. Use nominal_describe_channels to list them.",
    );
  }
  if (rawChannels.length > 10) {
    throw new ToolError(
      `'channels' is capped at 10 per call; received ${rawChannels.length}. Split the request.`,
    );
  }
  const channels = rawChannels.map((c, i) => {
    if (typeof c !== "string" || !c.trim()) {
      throw new ToolError(`channels[${i}] must be a non-empty string.`);
    }
    return c.trim();
  });

  const start = optString(args, "start");
  const end = optString(args, "end");
  const buckets = Math.min(
    MAX_DECIMATED_POINTS,
    Math.max(10, Number(args["points"] ?? MAX_DECIMATED_POINTS) || MAX_DECIMATED_POINTS),
  );

  // Resolve the data source for the run.
  let dataSource: string;
  if (parsed.kind === "run") {
    const run = await client.call<any>({
      method: "GET",
      path: `/scout/v1/run/${encodeURIComponent(parsed.id)}`,
    });
    const ds = Object.values(run?.dataSources ?? {})
      .map((d: any) => d?.dataSource?.dataset ?? d?.dataSource ?? null)
      .filter((x: any): x is string => typeof x === "string");
    if (!ds[0]) throw new ToolError("This run has no attached data source to query.");
    dataSource = ds[0];
    if (!start && run?.startTime) ctx.notices.push("No 'start' given; using the run's own start time.");
  } else {
    dataSource = parsed.id;
  }

  const startTs = start ? toUtcTimestamp(start, "start") : undefined;
  const endTs = end ? toUtcTimestamp(end, "end") : undefined;
  if (startTs && endTs && startTs.seconds > endTs.seconds) {
    throw new ToolError("'start' must be before 'end'.");
  }

  const series = await Promise.allSettled(
    channels.map(async (name) => {
      const res = await client.call<any>({
        method: "POST",
        path: "/compute/v2/compute",
        body: {
          context: { variables: {} },
          request: {
            type: "numericSeries",
            numericSeries: {
              type: "channel",
              channel: { dataSourceRid: dataSource, channelName: name },
            },
          },
          ...(startTs ? { startTime: startTs } : {}),
          ...(endTs ? { endTime: endTs } : {}),
        },
      });
      const points: Array<{ t: string; v: number | null }> = (
        res?.numericSeries?.points ??
        res?.points ??
        []
      ).map((p: any) => ({
        t: fromUtcTimestamp(p?.timestamp) ?? String(p?.timestamp ?? ""),
        v: typeof p?.value === "number" ? p.value : null,
      }));
      return { name, points };
    }),
  );

  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < series.length; i++) {
    const s = series[i]!;
    const name = channels[i]!;
    if (s.status === "rejected") {
      const e = s.reason;
      out.push({
        channel: name,
        error: e instanceof NominalError ? e.message : String(e),
      });
      continue;
    }
    const { points } = s.value;
    out.push({
      channel: name,
      unit: null,
      stats: summarize(points),
      decimated: decimate(points, buckets),
      decimation: `min/max/mean into <= ${buckets} buckets`,
    });
  }

  const handle = await signHandle(
    {
      kind: "channel_query",
      subject: client.subject,
      query: { uri, channels, start: start ?? null, end: end ?? null, dataSource },
      exp: Math.floor(Date.now() / 1000) + HANDLE_TTL_SECONDS,
    },
    handleSecret,
  );

  return {
    uri,
    data_source: dataSource,
    window: { start: start ?? null, end: end ?? null },
    series: out,
    handle,
    note: "Raw samples are never returned. Use nominal_export with this handle for the full series.",
  };
};

// ===========================================================================
// nominal_compute
// ===========================================================================

export const computeTool: ToolHandler = async ({ args, client }) => {
  const uri = requireString(args, "uri");
  const channel = requireString(args, "channel");
  const op = requireString(args, "operation");
  const allowed = ["min", "max", "mean", "sum", "count", "stddev", "integral", "derivative"];
  if (!allowed.includes(op)) {
    throw new ToolError(`Unknown operation ${JSON.stringify(op)}. Use one of: ${allowed.join(", ")}.`);
  }
  const parsed = parseNominalUri(uri);
  if (!parsed) throw new ToolError(`'uri' must be a run or dataset URI. Received ${JSON.stringify(uri)}.`);

  let dataSource = parsed.id;
  if (parsed.kind === "run") {
    const run = await client.call<any>({
      method: "GET",
      path: `/scout/v1/run/${encodeURIComponent(parsed.id)}`,
    });
    const ds = Object.values(run?.dataSources ?? {})
      .map((d: any) => d?.dataSource?.dataset ?? d?.dataSource ?? null)
      .filter((x: any): x is string => typeof x === "string");
    if (!ds[0]) throw new ToolError("This run has no attached data source to compute over.");
    dataSource = ds[0];
  }

  const start = optString(args, "start");
  const end = optString(args, "end");

  const res = await client.call<any>({
    method: "POST",
    path: "/compute/v2/compute",
    body: {
      context: { variables: {} },
      request: {
        type: "summarize",
        summarize: {
          input: {
            type: "numericSeries",
            numericSeries: {
              type: "channel",
              channel: { dataSourceRid: dataSource, channelName: channel },
            },
          },
          operation: op.toUpperCase(),
        },
      },
      ...(start ? { startTime: toUtcTimestamp(start, "start") } : {}),
      ...(end ? { endTime: toUtcTimestamp(end, "end") } : {}),
    },
  });

  return {
    uri,
    channel,
    operation: op,
    window: { start: start ?? null, end: end ?? null },
    result: res,
    note: "Computed server-side; no sample data left Nominal.",
  };
};

// ===========================================================================
// nominal_export
// ===========================================================================

export const exportTool: ToolHandler = async ({ args, ctx, client, handleSecret }) => {
  requireWrite(ctx); // presigned-link generation is a mutating op in the API
  const handleArg = optString(args, "handle");
  let uri = optString(args, "uri");
  let channels = Array.isArray(args["channels"]) ? (args["channels"] as string[]) : undefined;
  let start = optString(args, "start");
  let end = optString(args, "end");
  let dataSource: string | undefined;

  if (handleArg) {
    const payload = await verifyHandle(handleArg, handleSecret, client.subject);
    const q = payload.query as Record<string, any>;
    uri = q["uri"];
    channels = q["channels"];
    start = q["start"] ?? undefined;
    end = q["end"] ?? undefined;
    dataSource = q["dataSource"];
  }

  if (!uri || !channels?.length) {
    throw new ToolError(
      "Provide either a 'handle' from nominal_query_channels, or a 'uri' plus 'channels'.",
    );
  }

  if (!dataSource) {
    const parsed = parseNominalUri(uri);
    if (!parsed) throw new ToolError(`'uri' is not a valid Nominal URI: ${uri}`);
    dataSource = parsed.id;
    if (parsed.kind === "run") {
      const run = await client.call<any>({
        method: "GET",
        path: `/scout/v1/run/${encodeURIComponent(parsed.id)}`,
      });
      const ds = Object.values(run?.dataSources ?? {})
        .map((d: any) => d?.dataSource?.dataset ?? d?.dataSource ?? null)
        .filter((x: any): x is string => typeof x === "string");
      if (!ds[0]) throw new ToolError("This run has no attached data source to export.");
      dataSource = ds[0];
    }
  }

  const res = await client.call<any>({
    method: "POST",
    path: "/export/v1/generateExportPresignedLink",
    body: {
      channels: channels.map((c) => ({ dataSourceRid: dataSource, channelName: c })),
      format: optString(args, "format") === "parquet" ? "PARQUET" : "CSV",
      ...(start ? { startTime: toUtcTimestamp(start, "start") } : {}),
      ...(end ? { endTime: toUtcTimestamp(end, "end") } : {}),
    },
  });

  return {
    uri,
    channels,
    format: optString(args, "format") ?? "csv",
    download: res,
    note: "Presigned URL — fetch it outside the model context. It expires; regenerate if it 403s.",
  };
};

// ===========================================================================
// nominal_write
// ===========================================================================

export const writeTool: ToolHandler = async ({ args, ctx, client }) => {
  requireWrite(ctx);
  const kind = requireString(args, "kind");

  switch (kind) {
    case "event": {
      const name = requireString(args, "name");
      const start = requireString(args, "start");
      const end = optString(args, "end");
      const body: Record<string, unknown> = {
        name,
        timestamp: toUtcTimestamp(start, "start"),
        ...(end ? { duration: { seconds: Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1000)), nanos: 0 } } : {}),
        type: optString(args, "type") ?? "INFO",
        assetRids: Array.isArray(args["assets"]) ? args["assets"] : [],
        labels: Array.isArray(args["labels"]) ? args["labels"] : [],
        properties: (args["properties"] as Record<string, string>) ?? {},
      };
      const res = await client.call<any>({ method: "POST", path: "/event/v1/events", body });
      return { created: "event", name, entity: res };
    }
    case "comment": {
      const target = requireString(args, "target");
      const text = requireString(args, "text");
      const parsed = parseNominalUri(target);
      if (!parsed) throw new ToolError(`'target' must be a nominal:// URI or RID. Received ${target}.`);
      const res = await client.call<any>({
        method: "POST",
        path: "/comments/v1/comments",
        body: { resourceRid: parsed.id, content: text.slice(0, 10000) },
      });
      return { created: "comment", target, entity: res };
    }
    case "run_metadata": {
      const target = requireString(args, "target");
      const parsed = parseNominalUri(target);
      if (!parsed || parsed.kind !== "run") {
        throw new ToolError(`'target' must be a run URI for kind='run_metadata'. Received ${target}.`);
      }
      const body: Record<string, unknown> = {};
      const title = optString(args, "name");
      const description = optString(args, "text");
      if (title) body["title"] = title;
      if (description) body["description"] = description;
      if (Array.isArray(args["labels"])) body["labels"] = args["labels"];
      if (args["properties"]) body["properties"] = args["properties"];
      if (Object.keys(body).length === 0) {
        throw new ToolError("Nothing to update. Provide at least one of: name, text, labels, properties.");
      }
      const res = await client.call<any>({
        method: "PUT",
        path: `/scout/v1/run/${encodeURIComponent(parsed.id)}`,
        body,
      });
      return { updated: "run", target, entity: res };
    }
    default:
      throw new ToolError(
        `Unknown kind ${JSON.stringify(kind)}. Use 'event', 'comment', or 'run_metadata'. For anything else use nominal_api_search to find the operation, then nominal_api_call.`,
      );
  }
};

// ===========================================================================
// Definitions
// ===========================================================================

export const TIER1_TOOLS: Array<{ def: ToolDefinition; handler: ToolHandler }> = [
  {
    def: {
      name: "nominal_search",
      description:
        "Search Nominal by keyword. Returns compact summaries, each with a nominal:// uri. Start here when you have a name but no id.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free text. Omit to list recent items." },
          kind: {
            type: "string",
            enum: [...SEARCH_KINDS, "all"],
            description: "Default: assets, runs, datasets, events.",
          },
          limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT, default: 10 },
          cursor: { type: "string", description: "Page token; needs one 'kind'." },
        },
        additionalProperties: false,
      },
    },
    handler: searchTool,
  },
  {
    def: {
      name: "nominal_get",
      description:
        "Resolve a nominal:// uri, bare RID, or dataset UUID to full details. Use after nominal_search to inspect one thing.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          uri: {
            type: "string",
            description: "e.g. nominal://run/ri.scout.gov.run.abc" ,
          },
        },
        required: ["uri"],
        additionalProperties: false,
      },
    },
    handler: getTool,
  },
  {
    def: {
      name: "nominal_list_runs",
      description:
        "List runs newest first, optionally filtered by asset and time window. Use for 'the last run' or 'runs since Tuesday'.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          asset: { type: "string", description: "Asset uri or RID." },
          since: { type: "string", description: "ISO-8601 lower bound." },
          until: { type: "string", description: "ISO-8601 upper bound." },
          query: { type: "string", description: "Free-text filter on name." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          cursor: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    handler: listRunsTool,
  },
  {
    def: {
      name: "nominal_describe_channels",
      description:
        "List telemetry channels on a run or dataset with unit, type and tags. Call before nominal_query_channels so you use real names.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          uri: { type: "string", description: "Run or dataset uri." },
          filter: { type: "string", description: "Fuzzy name filter." },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
        required: ["uri"],
        additionalProperties: false,
      },
    },
    handler: describeChannelsTool,
  },
  {
    def: {
      name: "nominal_query_channels",
      description:
        "Statistics plus a decimated trace for up to 10 channels over a time window. Never returns raw samples; gives a handle for bulk export.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          uri: { type: "string", description: "Run or dataset uri." },
          channels: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 10,
            description: "From nominal_describe_channels.",
          },
          start: { type: "string", description: "ISO-8601 start; defaults to run start." },
          end: { type: "string", description: "ISO-8601 end; defaults to run end." },
          points: { type: "integer", minimum: 10, maximum: MAX_DECIMATED_POINTS, default: MAX_DECIMATED_POINTS },
        },
        required: ["uri", "channels"],
        additionalProperties: false,
      },
    },
    handler: queryChannelsTool,
  },
  {
    def: {
      name: "nominal_compute",
      description:
        "One aggregate over a channel, computed server-side. Use instead of pulling data when you only need the number.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          uri: { type: "string", description: "Run or dataset uri." },
          channel: { type: "string" },
          operation: {
            type: "string",
            enum: ["min", "max", "mean", "sum", "count", "stddev", "integral", "derivative"],
          },
          start: { type: "string", description: "ISO-8601 start." },
          end: { type: "string", description: "ISO-8601 end." },
        },
        required: ["uri", "channel", "operation"],
        additionalProperties: false,
      },
    },
    handler: computeTool,
  },
  {
    def: {
      name: "nominal_export",
      description:
        "Presigned download URL for full-resolution channel data, from a nominal_query_channels handle or a uri plus channels. Never loads it into context.",
      annotations: { destructiveHint: false },
      inputSchema: {
        type: "object",
        properties: {
          handle: { type: "string", description: "From nominal_query_channels." },
          uri: { type: "string", description: "Used if no handle." },
          channels: { type: "array", items: { type: "string" } },
          start: { type: "string" },
          end: { type: "string" },
          format: { type: "string", enum: ["csv", "parquet"], default: "csv" },
        },
        additionalProperties: false,
      },
    },
    handler: exportTool,
  },
  {
    def: {
      name: "nominal_write",
      description:
        "Create an event, add a comment, or update run metadata. Needs nominal:write. Any other write: use nominal_api_call.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["event", "comment", "run_metadata"],
            description: "event: name+start. comment: target+text. run_metadata: target.",
          },
          name: { type: "string" },
          text: { type: "string" },
          target: { type: "string", description: "uri/RID written to." },
          start: { type: "string", description: "ISO-8601." },
          end: { type: "string", description: "ISO-8601." },
          type: { type: "string", description: "INFO, FLAG, ERROR or SUCCESS." },
          assets: { type: "array", items: { type: "string" } },
          labels: { type: "array", items: { type: "string" } },
          properties: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["kind"],
        additionalProperties: false,
      },
    },
    handler: writeTool,
  },
];
