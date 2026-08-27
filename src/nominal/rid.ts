/**
 * Nominal resource identifiers and the `nominal://` URI scheme.
 *
 * A Nominal RID looks like:
 *   ri.scout.gov-staging.run.f0b1...-...
 *   ri.catalog.gov.dataset.9c2e...
 *      ^  ^service ^instance   ^type ^locator
 */

export type EntityKind =
  | "asset"
  | "run"
  | "dataset"
  | "workbook"
  | "checklist"
  | "event"
  | "video"
  | "attachment"
  | "connection"
  | "channel"
  | "handle";

export const ENTITY_KINDS: EntityKind[] = [
  "asset",
  "run",
  "dataset",
  "workbook",
  "checklist",
  "event",
  "video",
  "attachment",
  "connection",
  "channel",
];

/** RID `type` segment -> our entity vocabulary. */
const RID_TYPE_TO_KIND: Record<string, EntityKind> = {
  asset: "asset",
  run: "run",
  dataset: "dataset",
  "data-source": "dataset",
  datasource: "dataset",
  notebook: "workbook",
  workbook: "workbook",
  checklist: "checklist",
  event: "event",
  video: "video",
  attachment: "attachment",
  connection: "connection",
};

export interface ParsedRid {
  rid: string;
  service: string;
  instance: string;
  type: string;
  locator: string;
  kind: EntityKind | null;
}

const RID_RE = /^ri\.([a-z0-9-]+)\.([a-z0-9-]*)\.([a-z0-9-]+)\.([A-Za-z0-9_.:-]+)$/;

export function parseRid(rid: string): ParsedRid | null {
  const m = RID_RE.exec(rid.trim());
  if (!m) return null;
  const [, service, instance, type, locator] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    rid: rid.trim(),
    service,
    instance,
    type,
    locator,
    kind: RID_TYPE_TO_KIND[type] ?? null,
  };
}

export function isRid(s: string): boolean {
  return RID_RE.test(s.trim());
}

/** A bare UUID is accepted where the API takes a dataset UUID rather than a RID. */
export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
}

export interface ParsedUri {
  kind: EntityKind;
  id: string;
  /** Present for `nominal://channel/{datasource}/{name}`. */
  channel?: string;
}

/**
 * Parse a `nominal://` URI. Accepts a bare RID too, so an agent that has an id
 * from a search result can pass it straight to `nominal_get` without knowing
 * the URI scheme exists.
 */
export function parseNominalUri(uri: string): ParsedUri | null {
  const raw = uri.trim();

  if (!raw.startsWith("nominal://")) {
    if (isRid(raw)) {
      const p = parseRid(raw);
      if (p?.kind) return { kind: p.kind, id: raw };
      return null;
    }
    return null;
  }

  const rest = raw.slice("nominal://".length);
  const parts = rest.split("/").filter((s) => s.length > 0);
  if (parts.length < 2) return null;

  const kind = parts[0] as EntityKind;
  if (kind === "channel") {
    if (parts.length < 3) return null;
    return {
      kind: "channel",
      id: decodeURIComponent(parts[1]!),
      channel: decodeURIComponent(parts.slice(2).join("/")),
    };
  }
  if (kind === "handle") return { kind: "handle", id: decodeURIComponent(parts[1]!) };

  if (!ENTITY_KINDS.includes(kind)) return null;
  return { kind, id: decodeURIComponent(parts[1]!) };
}

export function buildNominalUri(kind: EntityKind, id: string, channel?: string): string {
  if (kind === "channel" && channel) {
    return `nominal://channel/${encodeURIComponent(id)}/${encodeURIComponent(channel)}`;
  }
  return `nominal://${kind}/${encodeURIComponent(id)}`;
}
