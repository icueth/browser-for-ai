import { fail } from "../format/compact";
import type { ToolResult } from "../types";

export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
