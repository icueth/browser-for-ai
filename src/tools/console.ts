import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import type { ConsoleEntry } from "../recorder/types";
import { ok, truncate } from "../format/compact";
import { guard } from "./guard";

const DEFAULT_LIST_LIMIT = 100;

function sourceLoc(e: ConsoleEntry): string {
  if (!e.url) return "";
  return e.line !== undefined ? ` (${e.url}:${e.line})` : ` (${e.url})`;
}

function consoleLine(e: ConsoleEntry): string {
  const count = e.count > 1 ? ` ×${e.count}` : "";
  const level = e.level.toUpperCase();
  let line = `${level}${count}  ${e.text}${sourceLoc(e)}`;
  if (e.stack) {
    const firstStackLine = e.stack.split("\n")[0]!;
    line += `\n  ${truncate(firstStackLine, 300)}`;
  }
  return line;
}

export function consoleLines(rows: ConsoleEntry[]): string {
  if (rows.length === 0) return "(none)";
  return rows.map(consoleLine).join("\n");
}

export function registerConsoleTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "console_list",
    {
      description: "List captured console entries for a session, most-recent-last. Filterable by level/pattern; capped by `limit` (default 100) — never silently truncated.",
      inputSchema: {
        sessionId: z.string().optional(),
        level: z.string().optional().describe("e.g. log, info, warning, error"),
        pattern: z.string().optional().describe("case-insensitive substring/regex match against entry text"),
        limit: z.number().int().positive().optional().describe("max rows to return (default 100)"),
      },
    },
    async ({ sessionId, level, pattern, limit }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        // CDP stores console.warn under the "warning" level; accept "warn" as an alias.
        const normLevel = level === "warn" ? "warning" : level;
        const all = recorder.console.list({ level: normLevel, pattern });
        if (all.length === 0) return ok("no console entries recorded");
        const max = limit ?? DEFAULT_LIST_LIMIT;
        // list() is chronological; keep the TAIL so the newest rows survive the cap.
        const shown = all.slice(-max);
        let text = consoleLines(shown);
        if (shown.length < all.length) {
          text += `\nshowing last ${shown.length} of ${all.length} (raise limit for more)`;
        }
        return ok(text);
      }),
  );

  server.registerTool(
    "console_errors",
    {
      description: "List console errors and warnings for a session, most-recent-last, including the first line of the stack trace when present.",
      inputSchema: { sessionId: z.string().optional() },
    },
    async ({ sessionId }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        return ok(consoleLines(recorder.console.errors()));
      }),
  );
}
