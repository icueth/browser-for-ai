import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionManager } from "../session/manager";
import { fail } from "../format/compact";
import { guard } from "./guard";
import { summarizeEvalResult, withDelta } from "./delta";
import { boundedEval, DEFAULT_EVAL_TIMEOUT_MS, MAX_EVAL_TIMEOUT_MS } from "./evalx";
import { captureCss, mappingNote } from "./screenshot";

export function registerEvalTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_eval",
    {
      description:
        "Evaluate a JS expression in the page and return its value. Run code and see the result in ONE call: " +
        "set delta:true to also get the network/console/url side-effects it caused, and screenshot:true to get a " +
        "viewport image of the resulting page (1:1 with page_click_at / page_tap_at coordinates). With both off it " +
        'is a quick standalone read (e.g. "document.title"). ' +
        `Bounded: an expression that runs or waits longer than timeoutMs (default ${DEFAULT_EVAL_TIMEOUT_MS}ms) is stopped — ` +
        "a busy loop is terminated so the page stays usable; a never-settling promise is abandoned.",
      inputSchema: {
        expression: z.string(),
        sessionId: z.string().optional(),
        delta: z.boolean().optional().describe("also report the network/console/url delta the expression caused (default false)"),
        screenshot: z.boolean().optional().describe("also return a viewport screenshot of the resulting page (default false)"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(MAX_EVAL_TIMEOUT_MS)
          .optional()
          .describe(`time budget in ms (default ${DEFAULT_EVAL_TIMEOUT_MS}, max ${MAX_EVAL_TIMEOUT_MS})`),
      },
    },
    async ({ expression, sessionId, delta, screenshot, timeoutMs }, extra): Promise<CallToolResult> => {
      try {
        const budget = timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
        // delta:true routes through withDelta (which also heals a detached frame + retries); the eval
        // result becomes the delta's header note. delta:false is the plain, cheapest path.
        let text: string;
        if (delta) {
          text = await withDelta(mgr, sessionId, undefined, async (recorder, page) => ({
            note: summarizeEvalResult(await boundedEval(recorder, page, expression, budget, extra?.signal)),
          }));
        } else {
          const page = mgr.pageFor(sessionId);
          const recorder = mgr.recorderFor(sessionId);
          text = summarizeEvalResult(await boundedEval(recorder, page, expression, budget, extra?.signal));
        }
        const content: CallToolResult["content"] = [{ type: "text", text }];
        if (screenshot) {
          // Capture AFTER the eval (and its settle) so the image shows the resulting page, under the
          // page lock so it can't race a concurrent look/screenshot.
          const cap = await mgr.withPageLock(sessionId, () => captureCss(mgr.pageFor(sessionId), {}));
          content.push(
            { type: "image", data: cap.data, mimeType: "image/png" },
            { type: "text", text: mappingNote(cap, "viewport") },
          );
        }
        return { content };
      } catch (err) {
        return fail(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
