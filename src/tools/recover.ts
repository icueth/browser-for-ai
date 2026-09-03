import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok } from "../format/compact";
import { guard } from "./guard";

async function probe(mgr: SessionManager, sessionId: string | undefined, ms: number): Promise<boolean> {
  const page = mgr.pageFor(sessionId);
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      page.evaluate(() => 1 + 1).then(
        (v) => v === 2,
        () => false,
      ),
      new Promise<boolean>((r) => {
        t = setTimeout(() => r(false), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Registers browser_recover — the escape hatch for a page whose JS thread is pinned (a runaway
 *  script, an eval that never returned): terminate the running script, and if the page re-spins,
 *  switch its scripts off so it becomes inspectable/closable again. */
export function registerRecoverTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "browser_recover",
    {
      description:
        "Unfreeze a page whose JavaScript is pinned (tools timing out, tab unresponsive). Step 1 terminates the " +
        "running script (Runtime.terminateExecution); if the page immediately re-spins, step 2 turns the page's " +
        "own scripts OFF so it can be read, screenshotted and closed (call again with scripts:true to turn them " +
        "back on). Reports which step worked. If nothing helps, browser_close is bounded and force-kills an owned Chrome.",
      inputSchema: {
        sessionId: z.string().optional(),
        scripts: z
          .boolean()
          .optional()
          .describe("true = re-enable page scripts after a recovery that disabled them; false = disable them outright"),
      },
    },
    async ({ sessionId, scripts }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        if (scripts === true) {
          await recorder.setScriptsEnabled(true);
          return ok(
            (await probe(mgr, sessionId, 2500))
              ? "page scripts re-enabled; page responsive"
              : "page scripts re-enabled, but the page is not responding again — run browser_recover once more or browser_close",
          );
        }
        if (scripts === false) {
          await recorder.disableScriptsHard();
          return ok(
            (await probe(mgr, sessionId, 2500))
              ? "page scripts disabled; page responsive (browser_recover {scripts:true} to re-enable)"
              : "page scripts disabled, but the page is still not responding — browser_close the session",
          );
        }
        await recorder.terminateExecution();
        if (await probe(mgr, sessionId, 2500)) return ok("recovered: the running script was terminated; page responsive");
        // It re-spun (a page-owned setInterval/loop): park the thread with the debugger, switch
        // scripts off there, kill the paused task, resume — the DevTools recipe for a hung tab.
        await recorder.disableScriptsHard();
        if (await probe(mgr, sessionId, 2500)) {
          return ok(
            "recovered by disabling the page's scripts (it re-spun after termination) — page is readable/closable now; browser_recover {scripts:true} re-enables JS",
          );
        }
        // Not a pinned thread but a stale main-frame / CDP reference ("Attempted to use detached
        // Frame")? Re-attach the recorder with a FRESH session on a live tab and re-probe. (Bounded
        // internally, so a wedged renderer can't turn this into a 30 s stall.)
        await mgr.reattach(sessionId).catch(() => {});
        if (await probe(mgr, sessionId, 2500)) return ok("recovered: re-attached to the live tab (a stale frame/session reference was reset); page responsive");
        // Last resort short of relaunch: open a CLEAN tab in the same session and drive it, so the
        // caller can page_goto again without browser_close + browser_launch.
        try {
          await mgr.freshTab(sessionId);
          if (await probe(mgr, sessionId, 2500)) {
            return ok("the wedged tab could not be revived — switched this session to a fresh blank tab; page_goto your URL to continue (no relaunch needed)");
          }
        } catch {
          // fall through to the close advice
        }
        return ok("still unresponsive after terminate + scripts-off + re-attach + fresh tab — browser_close this session (bounded; an owned Chrome is force-killed if it won't exit)");
      }),
  );
}
