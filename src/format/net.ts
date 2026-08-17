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

/** Render EVERY header as `name: value`. net_get is the full drill-down view: unlike the
 *  compact net_list table, it must NOT hide custom/signing headers (x-api-key, x-signature,
 *  agent, time, …) — those are exactly what you need to reproduce a signed request, and an
 *  allowlist here silently makes synthesized clients look like they only send Authorization. */
function allHeaders(headers: Record<string, string> | undefined): string {
  const entries = headers ? Object.entries(headers) : [];
  if (entries.length === 0) return "  (none)";
  return entries.map(([k, v]) => `  ${k}: ${truncate(v, 2000)}`).join("\n");
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
  lines.push(allHeaders(e.requestHeaders));
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
    lines.push(allHeaders(e.responseHeaders));
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
