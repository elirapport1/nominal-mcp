#!/usr/bin/env node
/**
 * nominal-mcp — stdio bridge.
 *
 * Speaks MCP over stdio and forwards each request to the remote HTTP endpoint.
 * Two reasons this exists rather than only offering the hosted URL:
 *
 *   1. Clients that only support stdio can still use the server.
 *   2. Per the auth spec, stdio implementations SHOULD read credentials from
 *      the environment rather than run an OAuth flow. Someone who already has
 *      a Nominal API key can skip the browser entirely.
 *
 * The key is read once from the environment, sent only to the configured
 * endpoint over TLS, and never written to disk or logged.
 *
 * Usage:
 *   NOMINAL_API_KEY=<key> npx nominal-mcp
 *   NOMINAL_API_KEY=<key> NOMINAL_MCP_URL=https://your-worker/mcp npx nominal-mcp
 *
 * Environment:
 *   NOMINAL_API_KEY   required — your Nominal API key (Settings -> API keys)
 *   NOMINAL_MCP_URL   optional — MCP endpoint (default: the public deployment)
 *   NOMINAL_BASE_URL  optional — Nominal API base (default: api.gov.nominal.io)
 *   NOMINAL_MCP_DEBUG optional — set to 1 to log protocol traffic to stderr
 */

import { createInterface } from "node:readline";
import process from "node:process";

const DEFAULT_URL = "https://nominal-mcp.elirapport.workers.dev/mcp";

const API_KEY = process.env.NOMINAL_API_KEY;
const URL_ = (process.env.NOMINAL_MCP_URL || DEFAULT_URL).trim();
const DEBUG = process.env.NOMINAL_MCP_DEBUG === "1";

/** stderr only — stdout is the protocol channel and must stay clean. */
function log(...args) {
  if (DEBUG) process.stderr.write(`[nominal-mcp] ${args.join(" ")}\n`);
}

function fatal(message) {
  process.stderr.write(`[nominal-mcp] ${message}\n`);
  process.exit(1);
}

if (!API_KEY) {
  fatal(
    "NOMINAL_API_KEY is not set.\n" +
      "  Get a key from the Nominal app under Settings -> API keys, then:\n" +
      "    NOMINAL_API_KEY=<key> npx nominal-mcp\n" +
      "  Or connect over HTTP instead and authenticate in a browser:\n" +
      `    claude mcp add --transport http nominal ${DEFAULT_URL}`,
  );
}

let endpoint;
try {
  endpoint = new URL(URL_);
} catch {
  fatal(`NOMINAL_MCP_URL is not a valid URL: ${URL_}`);
}
if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
  fatal("NOMINAL_MCP_URL must use https (http is allowed only for localhost).");
}

/** Mirror the body fields the transport requires as headers. */
function protocolHeaders(msg) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${API_KEY}`,
    "user-agent": "nominal-mcp-stdio/1.0",
  };

  const version =
    msg?.params?._meta?.["io.modelcontextprotocol/protocolVersion"] ??
    msg?.params?.protocolVersion ??
    "2025-06-18";
  headers["mcp-protocol-version"] = version;

  if (typeof msg?.method === "string") headers["mcp-method"] = msg.method;

  const name = msg?.params?.name ?? msg?.params?.uri;
  if (typeof name === "string") {
    // Header values must be ISO-8859-1; encode anything else per the spec.
    // eslint-disable-next-line no-control-regex
    headers["mcp-name"] = /^[\x20-\x7e]*$/.test(name)
      ? name
      : `=?B?${Buffer.from(name, "utf8").toString("base64")}?=`;
  }
  return headers;
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function errorFor(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function forward(msg) {
  const isNotification = msg.id === undefined || msg.id === null;

  let res;
  try {
    res = await fetch(endpoint.toString(), {
      method: "POST",
      headers: protocolHeaders(msg),
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    const detail = e?.name === "TimeoutError" ? "request timed out" : e?.message ?? String(e);
    log("transport error:", detail);
    if (!isNotification) {
      send(errorFor(msg.id, -32603, `Could not reach the Nominal MCP endpoint: ${detail}`));
    }
    return;
  }

  // 202 = accepted notification, no body.
  if (res.status === 202 || res.status === 204) return;

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    await pipeEventStream(res, msg, isNotification);
    return;
  }

  const text = await res.text();
  if (!text) {
    if (!isNotification) send(errorFor(msg.id, -32603, `Empty response (HTTP ${res.status})`));
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    log("non-JSON response:", text.slice(0, 200));
    if (!isNotification) {
      send(errorFor(msg.id, -32603, `Endpoint returned a non-JSON response (HTTP ${res.status})`));
    }
    return;
  }

  if (res.status === 401) {
    const hint =
      "The Nominal API key was rejected. Check NOMINAL_API_KEY, and that it is valid for this workspace.";
    if (!isNotification) send(errorFor(msg.id, -32603, hint));
    return;
  }

  if (!isNotification) send(parsed);
}

/** Relay notifications and the final response from an SSE response stream. */
async function pipeEventStream(res, msg, isNotification) {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (line.startsWith(":")) continue; // keep-alive comment
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (!isNotification || parsed.method) send(parsed);
        } catch {
          log("unparseable SSE data:", data.slice(0, 120));
        }
      }
    }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Requests are forwarded concurrently, but responses are written with a single
// synchronous write each, so interleaving cannot corrupt a message.
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log("dropping unparseable line from client");
    send(errorFor(null, -32700, "Parse error"));
    return;
  }
  log("->", msg.method ?? "(response)");
  forward(msg).catch((e) => {
    log("forward failed:", e?.message ?? String(e));
    if (msg.id !== undefined && msg.id !== null) {
      send(errorFor(msg.id, -32603, "Internal bridge error"));
    }
  });
});

rl.on("close", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

log(`bridge ready -> ${endpoint.origin}${endpoint.pathname}`);
