/**
 * Data-volume controls.
 *
 * The governing constraint: a single test run can be gigabytes of time series,
 * and the agent's context window is shared with everything else it is doing.
 * No tool returns a dataset. Reads return a summary plus a handle; bulk data
 * moves by presigned URL or is reduced server-side.
 */
import { hmacSign, hmacVerify } from "../util/encoding.js";

/** Serialized bytes a single tool result may occupy. */
export const MAX_RESULT_BYTES = 64 * 1024;
/** Decimated points returned by a channel query. */
export const MAX_DECIMATED_POINTS = 200;
/** Server-enforced ceiling on any `limit` argument. */
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 25;
export const MAX_SEARCH_LIMIT = 50;
/** Handle lifetime. */
export const HANDLE_TTL_SECONDS = 3600;

/**
 * Clamp a caller-supplied limit. Never rejects — clamping plus an explicit
 * notice teaches the agent the bound, where a 400 just costs a turn.
 */
export function clampLimit(
  requested: unknown,
  max: number = MAX_LIMIT,
  fallback: number = DEFAULT_LIMIT,
): { value: number; notice?: string } {
  if (requested === undefined || requested === null) return { value: fallback };
  const n = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isFinite(n)) {
    return { value: fallback, notice: `limit was not a number; using ${fallback}` };
  }
  const floored = Math.floor(n);
  if (floored < 1) return { value: 1, notice: `limit must be >= 1; clamped from ${floored} to 1` };
  if (floored > max) {
    return { value: max, notice: `limit clamped from ${floored} to the server maximum of ${max}` };
  }
  return { value: floored };
}

export interface HandlePayload {
  kind: string;
  subject: string;
  query: Record<string, unknown>;
  cursor?: string;
  exp: number;
}

/**
 * Handles are HMAC-signed and self-describing, so no server-side state is
 * needed and a handle from one user cannot be redeemed by another. Per
 * SEP-2567 they are ordinary tool arguments, not a session.
 */
export async function signHandle(payload: HandlePayload, secret: string): Promise<string> {
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sig = await hmacSign(secret, body);
  return `h1.${body}.${sig}`;
}

export class HandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandleError";
  }
}

export async function verifyHandle(
  handle: string,
  secret: string,
  subject: string,
): Promise<HandlePayload> {
  const parts = handle.split(".");
  if (parts.length !== 3 || parts[0] !== "h1") {
    throw new HandleError("Handle is malformed. Handles look like 'h1.<data>.<sig>'.");
  }
  const [, body, sig] = parts as [string, string, string];
  if (!(await hmacVerify(secret, body, sig))) {
    throw new HandleError("Handle signature is invalid.");
  }
  let payload: HandlePayload;
  try {
    const pad = body.length % 4 === 0 ? "" : "=".repeat(4 - (body.length % 4));
    payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/") + pad));
  } catch {
    throw new HandleError("Handle payload is corrupt.");
  }
  if (payload.exp * 1000 <= Date.now()) {
    throw new HandleError("Handle has expired. Re-run the query that produced it.");
  }
  // A handle is bound to the user who created it.
  if (payload.subject !== subject) {
    throw new HandleError("Handle was issued to a different user.");
  }
  return payload;
}

export interface SeriesStats {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  stddev: number | null;
  nulls: number;
  first_timestamp: string | null;
  last_timestamp: string | null;
}

export function summarize(points: Array<{ t: string; v: number | null }>): SeriesStats {
  const vals = points.map((p) => p.v).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const nulls = points.length - vals.length;
  if (vals.length === 0) {
    return {
      count: points.length,
      min: null,
      max: null,
      mean: null,
      stddev: null,
      nulls,
      first_timestamp: points[0]?.t ?? null,
      last_timestamp: points[points.length - 1]?.t ?? null,
    };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / vals.length;
  let sq = 0;
  for (const v of vals) sq += (v - mean) ** 2;
  return {
    count: points.length,
    min,
    max,
    mean,
    stddev: vals.length > 1 ? Math.sqrt(sq / (vals.length - 1)) : 0,
    nulls,
    first_timestamp: points[0]?.t ?? null,
    last_timestamp: points[points.length - 1]?.t ?? null,
  };
}

/**
 * Min/max/mean decimation into at most `buckets` buckets. Min and max are kept
 * per bucket rather than only the mean, because the spikes are usually the
 * reason an engineer is looking at the channel at all.
 */
export function decimate(
  points: Array<{ t: string; v: number | null }>,
  buckets = MAX_DECIMATED_POINTS,
): Array<{ t: string; min: number | null; max: number | null; mean: number | null; n: number }> {
  if (points.length === 0) return [];
  if (points.length <= buckets) {
    return points.map((p) => ({ t: p.t, min: p.v, max: p.v, mean: p.v, n: 1 }));
  }
  const size = points.length / buckets;
  const out: Array<{ t: string; min: number | null; max: number | null; mean: number | null; n: number }> = [];
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * size);
    const end = Math.min(points.length, Math.floor((i + 1) * size));
    if (end <= start) continue;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      const v = points[j]?.v;
      if (typeof v === "number" && Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        n++;
      }
    }
    out.push({
      t: points[start]!.t,
      min: n ? min : null,
      max: n ? max : null,
      mean: n ? sum / n : null,
      n: end - start,
    });
  }
  return out;
}

/**
 * Last line of defence: if a result is still over budget after tool-level
 * shaping, replace the offending payload with a description of it rather than
 * truncating into invalid JSON.
 */
export function enforceResultBudget(
  value: unknown,
  max = MAX_RESULT_BYTES,
): { value: unknown; truncated: boolean; bytes: number } {
  const s = JSON.stringify(value) ?? "null";
  if (s.length <= max) return { value, truncated: false, bytes: s.length };

  if (Array.isArray(value)) {
    // Binary search the largest prefix that fits, so we keep whole elements.
    let lo = 0;
    let hi = value.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((JSON.stringify(value.slice(0, mid)) ?? "").length <= max - 200) lo = mid;
      else hi = mid - 1;
    }
    return {
      value: {
        truncated: true,
        returned: lo,
        total: value.length,
        note: `Result exceeded ${max} bytes. Showing the first ${lo} of ${value.length} items. Narrow the query or page with 'cursor'.`,
        items: value.slice(0, lo),
      },
      truncated: true,
      bytes: s.length,
    };
  }

  return {
    value: {
      truncated: true,
      note: `Result exceeded ${max} bytes (${s.length}). Narrow the query, or use nominal_export for bulk data.`,
      preview: s.slice(0, 1000),
    },
    truncated: true,
    bytes: s.length,
  };
}
