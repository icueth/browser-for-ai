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
        timeoutMs: z.number().int().positive().optional().describe("max time to wait in ms (default 10000)"),
        requireFinished: z.boolean().optional().describe("only match once the request has finished (default false)"),
      },
    },
    async ({ sessionId, urlIncludes, method, status, timeoutMs, requireFinished }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + timeout;

        for (;;) {
          const hit = recorder.network.list().find((e) => matches(e, urlIncludes, method, status, requireFinished));
          if (hit) {
            const statusLabel = hit.failed ? "FAIL" : String(hit.status ?? (hit.finished ? "-" : "…"));
            return ok(`${hit.method} ${statusLabel} ${hit.url}`);
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return fail(`net_wait: no match for ${describeCriteria(urlIncludes, method, status, requireFinished)} in ${timeout}ms`);
          }
          await sleep(Math.min(POLL_INTERVAL_MS, remaining));
        }
      }),
  );
}
