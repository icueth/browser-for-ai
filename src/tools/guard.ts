import { fail } from "../format/compact";
import type { ToolResult } from "../types";

const TIMEOUT_RE = /timed out|timeout|Timed out/;

export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A CDP-level timeout almost always means the page's JS thread is pinned — point at the
    // escape hatches instead of leaving the agent to retry into the same wall.
    const hint = TIMEOUT_RE.test(msg) && !/browser_recover/.test(msg) ? " — the page may be frozen by a script: run browser_recover, or browser_close (bounded, force-kills an owned Chrome)" : "";
    return fail(`error: ${msg}${hint}`);
  }
}
