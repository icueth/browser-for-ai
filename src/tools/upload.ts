import { existsSync } from "node:fs";
import { z } from "zod";
import type { ElementHandle } from "puppeteer-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok } from "../format/compact";
import { guard } from "./guard";
import { withDelta } from "./delta";
import { targetFields, resolveTarget, describeTarget } from "./refs";

/** Registers page_upload — the one interaction a plain page_type can't do: attaching files to a
 *  file <input>. Puppeteer sets them directly on the element (no OS picker), which is why the
 *  paths must be readable by this process. Routes through withDelta so an auto-submitting form's
 *  upload request shows up in the same call. */
export function registerUploadTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_upload",
    {
      description:
        "Attach file(s) to a file <input> (by ref from page_snapshot, or CSS selector) — the equivalent " +
        "of choosing files in the OS picker, but set directly on the element. Give ABSOLUTE paths readable " +
        "by this process. Reports the network/console/url delta any resulting upload caused.",
      inputSchema: {
        ...targetFields,
        files: z.array(z.string()).min(1).describe("absolute path(s) to the file(s) to attach"),
        sessionId: z.string().optional(),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("settle time after attaching before reporting the delta (default 700ms)"),
      },
    },
    async ({ ref, selector, files, sessionId, waitMs }) =>
      guard(async () => {
        // Fail early with a clear message rather than letting uploadFile throw a cryptic ENOENT
        // deep inside the CDP round-trip.
        const missing = files.filter((f) => !existsSync(f));
        if (missing.length) throw new Error(`file(s) not found: ${missing.join(", ")}`);
        return ok(
          await withDelta(mgr, sessionId, waitMs, async (_rec, page) => {
            const el = await resolveTarget(page, { ref, selector }, "page_upload");
            await (el as ElementHandle<HTMLInputElement>).uploadFile(...files);
            return { note: `attached ${files.length} file(s) to ${describeTarget({ ref, selector })}` };
          }),
        );
      }),
  );
}
