/**
 * Resources under the `nominal://` scheme.
 *
 * Deliberately template-first. A flat `resources/list` over an org's runs is
 * exactly the unbounded read the design rules forbid, so `resources/list`
 * returns only a small, bounded set (the server's own capability documents plus
 * the user's recent runs), and everything else is reachable through templates.
 */
import { NominalClient } from "../nominal/client.js";
import { buildNominalUri, parseNominalUri } from "../nominal/rid.js";
import { CATALOG_STATS } from "../tools/catalog.js";
import { resourceNotFound } from "../protocol/errors.js";
import type {
  RequestContext,
  ResourceContents,
  ResourceDefinition,
  ResourceTemplateDefinition,
} from "../protocol/types.js";

export const RESOURCE_TEMPLATES: ResourceTemplateDefinition[] = [
  {
    uriTemplate: "nominal://asset/{rid}",
    name: "asset",
    title: "Nominal asset",
    description: "A piece of hardware under test, with its labels and properties.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "nominal://run/{rid}",
    name: "run",
    title: "Nominal test run",
    description: "One test run: time bounds, attached data sources, labels.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "nominal://dataset/{rid}",
    name: "dataset",
    title: "Nominal dataset",
    description: "A dataset and its ingest state.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "nominal://channel/{datasource}/{channel}",
    name: "channel",
    title: "Telemetry channel",
    description: "Metadata for one channel. Data is never inlined; use nominal_query_channels.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "nominal://event/{rid}",
    name: "event",
    title: "Nominal event",
    description: "An event or annotation on a run or asset.",
    mimeType: "application/json",
  },
];

/** Static, user-independent resources describing the server itself. */
const STATIC_RESOURCES: ResourceDefinition[] = [
  {
    uri: "nominal://server/capabilities",
    name: "server-capabilities",
    title: "Server capabilities",
    description: "What this MCP server exposes, including the API operation catalog summary.",
    mimeType: "application/json",
  },
];

export async function listResources(
  ctx: RequestContext,
  client: NominalClient | null,
): Promise<ResourceDefinition[]> {
  const out: ResourceDefinition[] = [...STATIC_RESOURCES];
  if (!client) return out;

  // Bounded by construction: at most 10 recent runs, never the whole org.
  try {
    const res = await client.call<any>({
      method: "POST",
      path: "/scout/v1/search-runs",
      body: {
        sort: { isDescending: true, field: "START_TIME" },
        pageSize: 10,
        nextPageToken: null,
        query: { type: "archived", archived: false },
      },
      timeoutMs: 8000,
    });
    for (const r of res?.results ?? []) {
      if (!r?.rid) continue;
      out.push({
        uri: buildNominalUri("run", r.rid),
        name: r.title ?? r.rid,
        title: r.title ?? undefined,
        description: "Recent test run",
        mimeType: "application/json",
      });
    }
  } catch {
    // A failure to enumerate recent runs must not break resources/list.
    ctx.notices.push("Could not list recent runs; showing server resources only.");
  }
  return out;
}

export async function readResource(
  uri: string,
  ctx: RequestContext,
  client: NominalClient | null,
): Promise<ResourceContents> {
  if (uri === "nominal://server/capabilities") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          server: "nominal-mcp",
          protocol_versions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"],
          api_operations: CATALOG_STATS,
          limits: {
            max_result_bytes: 65536,
            max_limit: 500,
            max_decimated_points: 200,
            channels_per_query: 10,
          },
        },
        null,
        2,
      ),
    };
  }

  const parsed = parseNominalUri(uri);
  if (!parsed) throw resourceNotFound(uri, ctx.era);
  if (!client) throw resourceNotFound(uri, ctx.era);

  switch (parsed.kind) {
    case "run": {
      const run = await client.call<any>({
        method: "GET",
        path: `/scout/v1/run/${encodeURIComponent(parsed.id)}`,
      });
      return { uri, mimeType: "application/json", text: JSON.stringify(run, null, 2) };
    }
    case "asset": {
      const map = await client.call<any>({
        method: "POST",
        path: "/scout/v1/asset/multiple",
        body: [parsed.id],
      });
      const asset = map?.[parsed.id];
      if (!asset) throw resourceNotFound(uri, ctx.era);
      return { uri, mimeType: "application/json", text: JSON.stringify(asset, null, 2) };
    }
    case "dataset": {
      const ds = await client.call<any>({
        method: "GET",
        path: `/catalog/v1/datasets/${encodeURIComponent(parsed.id)}`,
      });
      return { uri, mimeType: "application/json", text: JSON.stringify(ds, null, 2) };
    }
    case "event": {
      const ev = await client.call<any>({
        method: "POST",
        path: "/event/v1/get-events",
        body: { uuids: [parsed.id] },
      });
      return { uri, mimeType: "application/json", text: JSON.stringify(ev, null, 2) };
    }
    case "channel": {
      const meta = await client.call<any>({
        method: "POST",
        path: "/timeseries/channel-metadata/v1/channel-metadata/batch-get",
        body: {
          requests: [{ dataSourceRid: parsed.id, channelName: parsed.channel }],
        },
      });
      return { uri, mimeType: "application/json", text: JSON.stringify(meta, null, 2) };
    }
    default:
      throw resourceNotFound(uri, ctx.era);
  }
}

/** Argument autocomplete for resource templates. */
export async function completeResourceArgument(
  templateUri: string,
  argName: string,
  value: string,
  client: NominalClient | null,
): Promise<string[]> {
  if (!client || argName !== "rid") return [];
  const kind = templateUri.includes("://run/")
    ? "run"
    : templateUri.includes("://asset/")
      ? "asset"
      : null;
  if (!kind) return [];

  try {
    const path = kind === "run" ? "/scout/v1/search-runs" : "/scout/v1/search-assets";
    const res = await client.call<any>({
      method: "POST",
      path,
      body: {
        sort: { isDescending: true, field: kind === "run" ? "START_TIME" : "CREATED_AT" },
        pageSize: 20,
        nextPageToken: null,
        query: value ? { type: "searchText", searchText: value } : { type: "archived", archived: false },
      },
      timeoutMs: 6000,
    });
    return (res?.results ?? [])
      .map((r: any) => r?.rid)
      .filter((r: unknown): r is string => typeof r === "string")
      .slice(0, 20);
  } catch {
    return [];
  }
}
