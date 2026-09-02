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
        "Clear browsing state before a run that must start clean. scope \"origin\" clears the current origin's storage " +
        "(cookies, local/sessionStorage, IndexedDB, CacheStorage, service workers). scope \"all\" ALSO wipes the profile-wide " +
        "HTTP cache and ALL cookies — the default for a fresh (throwaway) session, but in attach mode that is the user's real " +
        "profile, so there the default is \"origin\" and \"all\" must be asked for explicitly. Every step is time-bounded.",
      inputSchema: {
        sessionId: z.string().optional(),
        scope: z
          .enum(["all", "origin"])
          .optional()
          .describe('default: "all" for fresh sessions, "origin" for attach sessions'),
      },
    },
    async ({ sessionId, scope }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const page = mgr.pageFor(sessionId);
        const origin = safeOrigin(page);
        const profileWide = scope ? scope === "all" : mgr.modeOf(sessionId) === "fresh";
        await recorder.clearCache(origin, profileWide);
        return ok(
          profileWide
            ? `cleared profile-wide cache+cookies, and all storage for ${origin}`
            : `cleared cookies+storage for ${origin} (origin-scoped; pass scope:"all" for the whole profile)`,
        );
      }),
  );

  server.registerTool(
    "browser_hard_reload",
    {
      description:
        "Reload the page bypassing cache (like a hard refresh / Cmd+Shift+R). A beforeunload prompt is accepted so the reload really happens. Reports the reloaded page's url and title.",
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
