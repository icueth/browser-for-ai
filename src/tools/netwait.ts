import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import type { NetEntry } from "../recorder/types";
import { ok, fail } from "../format/compact";
import { guard } from "./guard";

const DEFAULT_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matches(
  e: NetEntry,
  urlIncludes: string | undefined,
  method: string | undefined,
  status: number | undefined,
  requireFinished: boolean | undefined,
): boolean {
  if (urlIncludes && !e.url.includes(urlIncludes)) return false;
  if (method && e.method.toUpperCase() !== method.toUpperCase()) return false;
  if (status !== undefined && e.status !== status) return false;
  if (requireFinished && !e.finished) return false;
  return true;
}

function describeCriteria(
  urlIncludes: string | undefined,
  method: string | undefined,
  status: number | undefined,
  requireFinished: boolean | undefined,
): string {
  const parts = [
    urlIncludes ? `urlIncludes="${urlIncludes}"` : null,
    method ? `method=${method}` : null,
    status !== undefined ? `status=${status}` : null,
    requireFinished ? "requireFinished" : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" ") : "(any request)";
}

export function registerNetWaitTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "net_wait",
    {
      description:
        "Poll captured network requests for the first one matching the given criteria, up to timeoutMs (default 10000ms). Use instead of a fixed sleep to make driving deterministic — wait for the request rather than guessing at timing.",
      inputSchema: {
        sessionId: z.string().optional(),
        urlIncludes: z.string().optional().describe("substring match against the request url"),
        method: z.string().optional().describe("e.g. GET, POST"),
        status: z.number().int().optional(),
        timeoutMs: z.number().int().positive().max(300000).optional().describe("max time to wait in ms (default 10000, max 300000 = 5 min for slow first-load CDN assets)"),
        requireFinished: z.boolean().optional().describe("only match once the request has finished (default false)"),
        includeExisting: z
          .boolean()
          .optional()
          .describe("also match requests recorded BEFORE your last action (default false: only requests since the last page_goto/click/eval/… count, so an old polling call can't satisfy the wait)"),
      },
    },
    async ({ sessionId, urlIncludes, method, status, timeoutMs, requireFinished, includeExisting }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + timeout;
        // Scope to requests started since the last action (set by withDelta / goto): a match from an
        // earlier page — a lobby's polling loop, a previous login — must not resolve this wait.
        const afterSeq = includeExisting ? undefined : recorder.lastActionMark;

        for (;;) {
          // Return the NEWEST match, not the oldest: on a repeated wait during asset loading, .find()
          // kept echoing the page's own index.html (the earliest since-nav request) instead of the
          // request that just arrived. findLast reflects the tab's latest matching activity.
          const rows = recorder.network.list({ afterSeq });
          let hit: (typeof rows)[number] | undefined;
          for (let i = rows.length - 1; i >= 0; i--) {
            if (matches(rows[i]!, urlIncludes, method, status, requireFinished)) {
              hit = rows[i];
              break;
            }
          }
          if (hit) {
            const statusLabel = hit.failed ? "FAIL" : String(hit.status ?? (hit.finished ? "-" : "…"));
            return ok(`${hit.method} ${statusLabel} ${hit.url}`);
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return fail(`net_wait: no match for ${describeCriteria(urlIncludes, method, status, requireFinished)} in ${timeout}ms${includeExisting ? "" : " (since your last action; pass includeExisting:true to search the whole buffer)"}`);
          }
          await sleep(Math.min(POLL_INTERVAL_MS, remaining));
        }
      }),
  );
}
