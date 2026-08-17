import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import type { NetEntry } from "../recorder/types";
import { ok, fail, table, truncate } from "../format/compact";
import { netTable, netDetail, wsTable, slowTable } from "../format/net";
import { guard } from "./guard";

const DEFAULT_LIST_LIMIT = 50;

function failuresTable(rows: NetEntry[]): string {
  if (rows.length === 0) return "(none)";
  const body = rows.map((e) => [
    e.method,
    e.failed ? "FAIL" : String(e.status ?? "-"),
    e.resourceType,
    e.failed ? (e.errorText ?? e.blockedReason ?? "-") : "-",
    truncate(e.url, 100),
  ]);
  return table(["method", "status", "type", "error", "url"], body);
}

export function registerNetTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "net_list",
    {
      description: "List captured network requests for a session, most-recent-last. Filterable; capped by `limit` (default 50) — never silently truncated.",
      inputSchema: {
        sessionId: z.string().optional(),
        urlIncludes: z.string().optional().describe("substring match against the request url"),
        method: z.string().optional().describe("e.g. GET, POST"),
        type: z.string().optional().describe("resourceType, e.g. XHR, Fetch, Document, Script"),
        status: z.number().int().optional(),
        onlyXhr: z.boolean().optional().describe("restrict to XHR/Fetch requests"),
        limit: z.number().int().positive().optional().describe("max rows to return (default 50)"),
      },
    },
    async ({ sessionId, urlIncludes, method, type, status, onlyXhr, limit }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const all = recorder.network.list({ urlIncludes, method, type, status, onlyXhr });
        if (all.length === 0) return ok("no requests recorded");
        const max = limit ?? DEFAULT_LIST_LIMIT;
        // list() is chronological; keep the TAIL so the newest rows survive the cap.
        const shown = all.slice(-max);
        let text = netTable(shown);
        if (shown.length < all.length) {
          text += `\nshowing last ${shown.length} of ${all.length} (raise limit for more)`;
        }
        return ok(text);
      }),
  );

  server.registerTool(
    "net_get",
    {
      description: "Fetch one network request in full: headers, request body, response status/headers/body. Identify it by id (from net_list) or a url substring.",
      inputSchema: {
        id: z.string().optional(),
        url: z.string().optional().describe("substring match against the request url"),
        sessionId: z.string().optional(),
      },
    },
    async ({ id, url, sessionId }) =>
      guard(async () => {
        if (!id && !url) return fail("net_get requires either id or url");
        const recorder = mgr.recorderFor(sessionId);
        const entry = recorder.network.get(id ?? url!);
        if (!entry) return fail(`no matching request for "${id ?? url}"`);
        const reqBody = entry.hasPostData ? await recorder.postDataOf(entry.id) : null;
        // Skip the body fetch for a failed request: netDetail renders the failure
        // branch and discards any body, so the CDP call would be pure waste.
        const resBody = !entry.failed && entry.status !== undefined ? await recorder.bodyOf(entry.id) : null;
        return ok(netDetail(entry, reqBody, resBody));
      }),
  );

  server.registerTool(
    "net_failures",
    {
      description: "List failed network requests (4xx/5xx status or CDP-level failure) with error detail.",
      inputSchema: { sessionId: z.string().optional() },
    },
    async ({ sessionId }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        return ok(failuresTable(recorder.network.failures()));
      }),
  );

  server.registerTool(
    "net_pending",
    {
      description: "List network requests still in flight (candidates for a hang) as of now.",
      inputSchema: { sessionId: z.string().optional() },
    },
    async ({ sessionId }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        return ok(netTable(recorder.network.pending(recorder.seqNow())));
      }),
  );

  server.registerTool(
    "net_slow",
    {
      description: "List finished network requests slower than a threshold (default 1000ms), slowest first. Capped by `limit` (default 50) — never silently truncated.",
      inputSchema: {
        sessionId: z.string().optional(),
        thresholdMs: z.number().nonnegative().optional().describe("minimum duration in ms to include (default 1000)"),
        limit: z.number().int().positive().optional().describe("max rows to return (default 50)"),
      },
    },
    async ({ sessionId, thresholdMs, limit }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const threshold = thresholdMs ?? 1000;
        const slow = recorder.network
          .list()
          .filter((e) => e.finished && e.durationMs !== undefined && e.durationMs >= threshold)
          .sort((a, b) => b.durationMs! - a.durationMs!);
        if (slow.length === 0) return ok(`no finished requests >= ${threshold}ms`);
        const max = limit ?? DEFAULT_LIST_LIMIT;
        const shown = slow.slice(0, max);
        let text = slowTable(shown);
        if (shown.length < slow.length) {
          text += `\nshowing ${shown.length} of ${slow.length} (raise limit for more)`;
        }
        return ok(text);
      }),
  );

  server.registerTool(
    "net_ws",
    {
      description: "List WebSocket connections with frame counts and a few recent frames.",
      inputSchema: { sessionId: z.string().optional() },
    },
    async ({ sessionId }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        return ok(wsTable(recorder.network.wsList()));
      }),
  );
}
