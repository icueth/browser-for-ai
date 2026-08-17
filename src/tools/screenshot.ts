import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionManager } from "../session/manager";
import { fail } from "../format/compact";
import { targetFields, resolveTarget } from "./refs";

/** Registers the Phase 2 screenshot tool. Its success result carries image content, which
 *  `ToolResult` (text-only, see types.ts) can't express — so unlike every other interaction
 *  tool, this one does not route through `guard()`/`ok()`. It builds the image `CallToolResult`
 *  directly and falls back to the same `fail()` text result on error (still valid CallToolResult
 *  content, just a different member of the union). */
export function registerScreenshotTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_screenshot",
    {
      description:
        "Capture a PNG screenshot: of a single element (by ref from page_snapshot, or CSS selector), " +
        "or of the whole page (viewport by default, or the full scrollable page with fullPage:true). " +
        "Use sparingly — this is the only tool that returns image content.",
      inputSchema: {
        ...targetFields,
        sessionId: z.string().optional(),
        fullPage: z
          .boolean()
          .optional()
          .describe("capture the full scrollable page instead of just the viewport (ignored when ref/selector is given)"),
      },
    },
    async ({ ref, selector, sessionId, fullPage }): Promise<CallToolResult> => {
      try {
        const page = mgr.pageFor(sessionId);
        const data =
          ref || selector
            ? await (await resolveTarget(page, { ref, selector }, "page_screenshot")).screenshot({ encoding: "base64" })
            : await page.screenshot({ encoding: "base64", fullPage: !!fullPage });
        return { content: [{ type: "image", data, mimeType: "image/png" }] };
      } catch (err) {
        return fail(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
