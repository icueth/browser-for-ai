import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { saveState, restoreState, type StateBlob } from "../session/state";
import { ok, fail } from "../format/compact";
import { guard } from "./guard";

const STATE_DIR = join(homedir(), ".bfa", "state");

/** Restricts a user-supplied save name to a safe filename component — no path separators,
 *  no traversal (`..`), no characters that would need shell/OS escaping. */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function statePath(name: string): string {
  return join(STATE_DIR, `${sanitizeName(name)}.json`);
}

export function registerPersistTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "session_save",
    {
      description:
        "Save the active (or given) session's cookies + localStorage/sessionStorage to ~/.bfa/state/<name>.json, for later restore with session_restore.",
      inputSchema: { sessionId: z.string().optional(), name: z.string() },
    },
    async ({ sessionId, name }) =>
      guard(async () => {
        const page = mgr.pageFor(sessionId);
        const blob = await saveState(page);
        const safe = sanitizeName(name);
        mkdirSync(STATE_DIR, { recursive: true });
        // 0o600 (owner read/write only): the blob contains httpOnly session cookies -- default
        // perms would leave it group/world-readable on a shared machine.
        writeFileSync(statePath(name), JSON.stringify(blob), { mode: 0o600 });
        const storageKeys = Object.keys(blob.local).length + Object.keys(blob.session).length;
        const cookieWord = blob.cookies.length === 1 ? "cookie" : "cookies";
        const keyWord = storageKeys === 1 ? "key" : "keys";
        return ok(
          `saved ${blob.cookies.length} ${cookieWord}, ${storageKeys} storage ${keyWord} to "${safe}"`,
        );
      }),
  );

  server.registerTool(
    "session_restore",
    {
      description:
        "Restore cookies + localStorage/sessionStorage previously saved with session_save into the active (or given) session.",
      inputSchema: { sessionId: z.string().optional(), name: z.string() },
    },
    async ({ sessionId, name }) =>
      guard(async () => {
        const safe = sanitizeName(name);
        const path = statePath(name);
        if (!existsSync(path)) return fail(`no saved state "${safe}"`);
        const blob = JSON.parse(readFileSync(path, "utf8")) as StateBlob;
        const page = mgr.pageFor(sessionId);
        const applied = await restoreState(page, blob);
        const cookieWord = applied.cookies === 1 ? "cookie" : "cookies";
        return ok(
          `restored ${applied.cookies} ${cookieWord}, ${applied.local} local, ${applied.session} session for ${blob.origin}`,
        );
      }),
  );
}
