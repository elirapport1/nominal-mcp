/**
 * Thin HTTPS client for the Nominal Conjure API.
 *
 * Every call carries the *end user's* credential. There is no service account
 * and no shared key: if Nominal would deny the user, it denies the tool.
 */
import { assertAllowedHost, type AuthContext } from "../auth/token.js";
import { withRetry } from "../util/concurrency.js";

export interface NominalCallOptions {
  method: string;
  path: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** Response is a file/stream — return metadata, never bytes. */
  binary?: boolean;
}

export class NominalError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly nominalCode?: string,
    readonly retryAfter?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "NominalError";
  }

  /** Whether the agent should retry rather than change its approach. */
  get retryable(): boolean {
    return this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // hard ceiling before we even parse

export class NominalClient {
  private readonly base: string;

  constructor(private readonly auth: AuthContext) {
    // Re-validated on every construction: a token could predate a policy change.
    assertAllowedHost(auth.baseUrl);
    this.base = auth.baseUrl.replace(/\/+$/, "");
  }

  get subject(): string {
    return this.auth.subject;
  }

  async call<T = unknown>(opts: NominalCallOptions): Promise<T> {
    // Only retry calls that cannot have side effects. A write that appears to
    // fail may already have landed, and replaying it could duplicate an event.
    const safe =
      opts.method === "GET" || (opts.method === "POST" && this.isQueryLike(opts.path));
    if (!safe) return this.callOnce<T>(opts);
    return withRetry(() => this.callOnce<T>(opts), {
      retryable: (e) => e instanceof NominalError && e.retryable,
    });
  }

  /**
   * Conjure uses POST for queries as well as writes, so the verb alone cannot
   * say whether a call is safe. These path shapes are read-only by convention
   * across the API surface.
   */
  private isQueryLike(path: string): boolean {
    return /\/(search|get|batch-get|list|multiple|count|histogram|aggregate)([-/]|$)/i.test(path);
  }

  private async callOnce<T = unknown>(opts: NominalCallOptions): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.auth.credential}`,
      Accept: "application/json",
      "User-Agent": "nominal-mcp/1.0 (+https://github.com/elirapport1/nominal-mcp)",
    };
    let body: string | undefined;
    if (opts.body !== undefined && opts.method !== "GET" && opts.method !== "DELETE") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method,
        headers,
        body,
        redirect: "error", // never follow a redirect while holding a credential
        signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/abort|timeout/i.test(msg)) {
        throw new NominalError(504, `Nominal request timed out after ${opts.timeoutMs ?? 25_000}ms`);
      }
      throw new NominalError(502, `Could not reach Nominal: ${msg}`);
    }

    if (!res.ok) throw await this.toError(res);

    if (opts.binary) {
      return {
        content_type: res.headers.get("content-type"),
        content_length: Number(res.headers.get("content-length") ?? 0),
        note: "Binary payload not returned inline. Use nominal_export for a presigned URL.",
      } as T;
    }

    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_RESPONSE_BYTES) {
      throw new NominalError(
        413,
        `Nominal returned ${len} bytes, over the ${MAX_RESPONSE_BYTES} byte ceiling. Narrow the request.`,
      );
    }

    const text = await res.text();
    if (text.length === 0) return undefined as T;
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new NominalError(413, `Nominal response too large (${text.length} bytes). Narrow the request.`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NominalError(502, "Nominal returned a non-JSON response");
    }
  }

  private buildUrl(path: string, query?: Record<string, string | string[] | undefined>): string {
    // Path comes from the generated catalog, never from user input directly.
    // Belt and braces: reject anything that could escape the base.
    if (path.includes("..") || path.includes("//") || !path.startsWith("/")) {
      throw new NominalError(400, `Refusing to build a request for unsafe path: ${path}`);
    }
    const url = new URL(this.base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
        else url.searchParams.set(k, v);
      }
    }
    // A catalog path template must never change the host.
    if (!url.href.startsWith(new URL(this.base).origin)) {
      throw new NominalError(400, "Refusing cross-origin Nominal request");
    }
    return url.toString();
  }

  private async toError(res: Response): Promise<NominalError> {
    let detail: unknown;
    let message = `Nominal returned ${res.status}`;
    let code: string | undefined;
    try {
      const text = (await res.text()).slice(0, 4000);
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        detail = parsed;
        code = typeof parsed["errorCode"] === "string" ? parsed["errorCode"] : undefined;
        const name = typeof parsed["errorName"] === "string" ? parsed["errorName"] : undefined;
        if (name) message = `Nominal error ${res.status}: ${name}`;
      } catch {
        detail = text;
        if (text) message = `Nominal error ${res.status}: ${text.slice(0, 200)}`;
      }
    } catch {
      /* body unreadable; status alone is the signal */
    }

    // Make the common failures actionable instead of opaque.
    if (res.status === 401) {
      message =
        "Nominal rejected the credential (401). The API key may have been revoked or may not cover this workspace.";
    } else if (res.status === 403) {
      message =
        "Nominal denied access to this resource (403). Your account does not have permission for it.";
    } else if (res.status === 404) {
      message = "Nominal has no such resource (404). Check the RID.";
    }

    const retryAfter = Number(res.headers.get("retry-after") ?? "0") || undefined;
    return new NominalError(res.status, message, code, retryAfter, detail);
  }
}
