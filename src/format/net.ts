import type { NetEntry, WsEntry } from "../recorder/types";
import { table, truncate } from "./compact";

function humanSize(bytes?: number): string {
  if (bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function statusOf(e: NetEntry): string {
  if (e.failed) return "FAIL";
  if (e.status !== undefined) return String(e.status);
  return e.finished ? "-" : "…";
}

export function netRow(e: NetEntry): string[] {
  return [e.method, statusOf(e), e.resourceType, humanSize(e.encodedDataLength), truncate(e.url, 100)];
}

export function netTable(entries: NetEntry[]): string {
  if (entries.length === 0) return "(none)";
  return table(["method", "status", "type", "size", "url"], entries.map(netRow));
}

export function slowRow(e: NetEntry): string[] {
  return [e.method, statusOf(e), `${Math.round(e.durationMs ?? 0)}ms`, truncate(e.url, 100)];
}

export function slowTable(entries: NetEntry[]): string {
  if (entries.length === 0) return "(none)";
  return table(["method", "status", "ms", "url"], entries.map(slowRow));
}

const KEY_REQUEST_HEADERS = ["content-type", "accept", "authorization", "cookie", "user-agent", "origin", "referer"];
const KEY_RESPONSE_HEADERS = ["content-type", "content-length", "cache-control", "set-cookie", "location"];

function pickHeaders(headers: Record<string, string> | undefined, keys: string[]): string {
  if (!headers) return "  (none)";
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const lines = keys.flatMap((k) => {
    const v = lower.get(k);
    return v === undefined ? [] : [`  ${k}: ${v}`];
  });
  return lines.length > 0 ? lines.join("\n") : "  (none of the key headers present)";
}

export function netDetail(
  e: NetEntry,
  reqBody: string | null,
  resBody: { body: string; base64: boolean } | null,
): string {
  const lines: string[] = [];
  if (e.redirects?.length) {
    for (const r of e.redirects) lines.push(`  ↳ ${r.status} ${r.url}`);
  }
  lines.push(`${e.method} ${e.url}`);
  lines.push(`type: ${e.resourceType}${e.fromCache ? " (from cache)" : ""}`);
  if (e.durationMs !== undefined) lines.push(`duration: ${Math.round(e.durationMs)}ms`);
  lines.push("");
  lines.push("request headers:");
  lines.push(pickHeaders(e.requestHeaders, KEY_REQUEST_HEADERS));
  if (e.hasPostData) {
    lines.push("");
    lines.push("request body:");
    lines.push(reqBody !== null ? truncate(reqBody, 4000) : "(unavailable)");
  }
  lines.push("");
  if (e.failed) {
    lines.push(`FAILED: ${e.errorText ?? e.blockedReason ?? "unknown error"}`);
  } else if (e.status !== undefined) {
    lines.push(`response: ${e.status} ${e.statusText ?? ""} ${e.mimeType ?? ""}`.trim());
    lines.push("response headers:");
    lines.push(pickHeaders(e.responseHeaders, KEY_RESPONSE_HEADERS));
    lines.push("");
    lines.push("response body:");
    if (resBody === null) {
      lines.push("(unavailable)");
    } else if (resBody.base64) {
      lines.push(`(base64-encoded, ${resBody.body.length} chars) ${truncate(resBody.body, 200)}`);
    } else {
      lines.push(truncate(resBody.body, 4000));
    }
  } else {
    lines.push(e.finished ? "response: (no data)" : "response: pending");
  }
  return lines.join("\n");
}

export function wsTable(list: WsEntry[]): string {
  if (list.length === 0) return "no websocket connections";
  return list
    .map((w) => {
      const header = `${w.url} — ${w.frames.length} frame(s)${w.closed ? ", closed" : ""}`;
      const recent = w.frames
        .slice(-5)
        .map((f) => `  ${f.dir}: ${truncate(f.payload, 200)}`);
      return [header, ...recent].join("\n");
    })
    .join("\n\n");
}
