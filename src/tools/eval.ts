import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok } from "../format/compact";
import { guard } from "./guard";
import { summarizeEvalResult } from "./delta";
import { boundedEval, DEFAULT_EVAL_TIMEOUT_MS, MAX_EVAL_TIMEOUT_MS } from "./evalx";

export function registerEvalTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_eval",
    {
      description:
        "Evaluate a JS expression in the page and return its value directly (no network/console delta). " +
        'Use this for a quick, standalone read (e.g. "document.title"). If you also want the ' +
        'network/console/url side-effects the expression may cause, use page_observe with {action:{kind:"eval"}} instead. ' +
        `Bounded: an expression that runs or waits longer than timeoutMs (default ${DEFAULT_EVAL_TIMEOUT_MS}ms) is stopped — ` +
        "a busy loop is terminated so the page stays usable; a never-settling promise is abandoned.",
      inputSchema: {
        expression: z.string(),
        sessionId: z.string().optional(),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(MAX_EVAL_TIMEOUT_MS)
          .optional()
          .describe(`time budget in ms (default ${DEFAULT_EVAL_TIMEOUT_MS}, max ${MAX_EVAL_TIMEOUT_MS})`),
      },
    },
    async ({ expression, sessionId, timeoutMs }, extra) =>
      guard(async () => {
        const page = mgr.pageFor(sessionId);
        const recorder = mgr.recorderFor(sessionId);
        const result = await boundedEval(recorder, page, expression, timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS, extra?.signal);
        return ok(summarizeEvalResult(result));
      }),
  );
}
