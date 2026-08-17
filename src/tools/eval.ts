import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok } from "../format/compact";
import { guard } from "./guard";
import { summarizeEvalResult } from "./delta";

export function registerEvalTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_eval",
    {
      description:
        "Evaluate a JS expression in the page and return its value directly (no network/console delta). " +
        'Use this for a quick, standalone read (e.g. "document.title"). If you also want the ' +
        'network/console/url side-effects the expression may cause, use page_observe with {action:{kind:"eval"}} instead.',
      inputSchema: {
        expression: z.string(),
        sessionId: z.string().optional(),
      },
    },
    async ({ expression, sessionId }) =>
      guard(async () => {
        const page = mgr.pageFor(sessionId);
        const result = await page.evaluate(expression);
        return ok(summarizeEvalResult(result));
      }),
  );
}
