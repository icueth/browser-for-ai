import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Page } from "puppeteer-core";
import type { SessionManager } from "../session/manager";
import { ok } from "../format/compact";
import { guard } from "./guard";

function safeOrigin(page: Page): string {
  try {
    return new URL(page.url()).origin;
  } catch {
    return page.url();
  }
}

export function registerCacheTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "browser_clear_cache",
    {
      description:
        "Clear browser cache, cookies, and storage (localStorage/sessionStorage/IndexedDB/etc) for a session. Use before a test run that must start from a clean state.",
      inputSchema: {
        sessionId: z.string().optional(),
        scope: z
          .enum(["all", "origin"])
          .optional()
          .describe('"all" (default) clears cache+cookies and the current origin\'s storage; "origin" scopes storage clearing explicitly to the current page origin'),
      },
    },
    async ({ sessionId, scope }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const page = mgr.pageFor(sessionId);
        const origin = safeOrigin(page);
        await recorder.clearCache(scope === "origin" ? origin : undefined);
        return ok(`cleared cache+cookies+storage for ${origin}`);
      }),
  );

  server.registerTool(
    "browser_hard_reload",
    {
      description:
        "Reload the page bypassing cache (like a hard refresh / Cmd+Shift+R). Reports the reloaded page's url and title.",
      inputSchema: { sessionId: z.string().optional() },
    },
    async ({ sessionId }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const page = mgr.pageFor(sessionId);
        await recorder.hardReload();
        // Give the reloaded document a moment to settle before reading url/title back.
        await new Promise((r) => setTimeout(r, 500));
        let title: string | null = null;
        try {
          title = await page.title();
        } catch {
          title = null;
        }
        return ok(`reloaded → ${page.url()} · "${title ?? ""}"`);
      }),
  );
}
