import { realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionManager, sweepStaleTempDirs } from "./session/manager";
import { registerBrowserTools } from "./tools/browser";
import { registerPageTools } from "./tools/page";
import { registerNetTools } from "./tools/net";
import { registerNetWaitTools } from "./tools/netwait";
import { registerInterceptTools } from "./tools/intercept";
import { registerConsoleTools } from "./tools/console";
import { registerObserveTools } from "./tools/observe";
import { registerCacheTools } from "./tools/cache";
import { registerSnapshotTools } from "./tools/snapshot";
import { registerInteractTools } from "./tools/interact";
import { registerEvalTools } from "./tools/eval";
import { registerScreenshotTools } from "./tools/screenshot";
import { registerFlowTools } from "./tools/flow";
import { registerMouseTools } from "./tools/mouse";
import { registerPersistTools } from "./tools/persist";
import { registerUploadTools } from "./tools/upload";
import { registerEmulateTools } from "./tools/emulate";
import { registerFindTools } from "./tools/find";
import { registerReadTools } from "./tools/read";

const BFA_INSTRUCTIONS = [
  "browser-for-ai drives a real Chrome over CDP for deep inspection and API-flow reverse-engineering.",
  "",
  "Choosing how to open the browser (browser_launch):",
  '• Most tasks → mode:"fresh" (add incognito:true for a clean slate). A throwaway Chrome, no setup — use for',
  "  reverse-engineering a public flow or any site that does not need your existing login.",
  '• Need real logins / a human-looking browser (navigator.webdriver=false, real profile & fingerprint) →',
  '  mode:"attach", port:9222, AFTER the user starts Chrome with `bin/bfa-chrome 9222` (Chrome 136+ needs a',
  "  non-default profile, which bfa-chrome uses). You cannot attach to an already-open normal Chrome — no debug port.",
  "",
  "Typical loop: page_goto → read with net_*/console_*/page_snapshot → act with page_click/type/fill/upload →",
  "reverse an API with flow_mark → flow_synthesize (curl/ts/go/python) → flow_replay to verify. net_get and",
  "flow_export show the COMPLETE on-the-wire headers (Cookie + custom signing headers); a failing flow_replay",
  "usually means a computed header (e.g. a signature) still needs reproducing in your own code.",
].join("\n");

export function createServer(): { server: McpServer; mgr: SessionManager } {
  const server = new McpServer({ name: "browser-for-ai", version: "0.1.0" }, { instructions: BFA_INSTRUCTIONS });
  const mgr = new SessionManager();
  registerBrowserTools(server, mgr);
  registerPageTools(server, mgr);
  registerNetTools(server, mgr);
  registerNetWaitTools(server, mgr);
  registerInterceptTools(server, mgr);
  registerConsoleTools(server, mgr);
  registerObserveTools(server, mgr);
  registerCacheTools(server, mgr);
  registerSnapshotTools(server, mgr);
  registerInteractTools(server, mgr);
  registerEvalTools(server, mgr);
  registerScreenshotTools(server, mgr);
  registerFlowTools(server, mgr);
  registerMouseTools(server, mgr);
  registerPersistTools(server, mgr);
  registerUploadTools(server, mgr);
  registerEmulateTools(server, mgr);
  registerFindTools(server, mgr);
  registerReadTools(server, mgr);
  return { server, mgr };
}

async function main(): Promise<void> {
  // SIGKILL and crashes always defeat in-process cleanup, so reclaim earlier runs' leftovers.
  sweepStaleTempDirs();

  const { server, mgr } = createServer();

  // Idempotent: signals, stdin EOF and transport close can all fire, sometimes together.
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await mgr.shutdown();
    } catch {
      // never let a teardown failure stop the process from exiting
    }
    // Do NOT process.exit() here. stdin EOF arrives while responses to already-buffered
    // requests are still in flight, and exiting synchronously truncates them. Closing the
    // browsers above releases the CDP sockets that were holding the event loop open, so the
    // process now ends on its own once stdout has drained. The unref'd timer is the backstop
    // for anything still holding the loop — it cannot itself keep the process alive.
    setTimeout(() => process.exit(0), 500).unref();
  };

  // We opt out of puppeteer's signal handlers at launch (manager.ts) precisely so these win.
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  // The MCP stdio transport never listens for stdin EOF, and puppeteer's live CDP socket keeps
  // the event loop alive — without these the server outlives a host that just closes the pipe.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  server.server.onclose = shutdown;

  // Last resort: `exit` handlers must be synchronous, so this can only unlink dirs — but it
  // catches the paths where async shutdown never got to run.
  process.on("exit", () => {
    for (const dir of mgr.tempDirs()) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only auto-start when run as the process entry, not when imported by tests.
// `import.meta.url` is realpath'd and percent-encoded by Node; `process.argv[1]` is neither.
// Comparing them raw silently no-ops the server whenever it is invoked through a symlink
// (npm bin / npx / npm link) or from a path containing a space.
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isProcessEntry()) {
  main().catch((err) => {
    console.error("[browser-for-ai] fatal:", err);
    process.exit(1);
  });
}
