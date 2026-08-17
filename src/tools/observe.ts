import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok, fail } from "../format/compact";
import { guard } from "./guard";
import { withDelta, summarizeEvalResult } from "./delta";

export function registerObserveTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_observe",
    {
      description:
        "Run one page action (goto/reload/eval/wait) and report the compact delta it caused: any url change, new network requests, and new console entries. Use this instead of a raw navigate/eval call so you see an action's side-effects without extra tool calls.",
      inputSchema: {
        action: z.object({
          kind: z.enum(["goto", "reload", "eval", "wait"]),
          url: z.string().url().optional().describe('required when kind="goto"'),
          expression: z.string().optional().describe('required when kind="eval"; run via page.evaluate'),
        }),
        sessionId: z.string().optional(),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("settle time after the action before reading the delta, in ms (default 700)"),
      },
    },
    async ({ action, sessionId, waitMs }) =>
      guard(async () => {
        if (action.kind === "goto" && !action.url) {
          return fail('page_observe: action.kind="goto" requires action.url');
        }
        if (action.kind === "eval" && !action.expression) {
          return fail('page_observe: action.kind="eval" requires action.expression');
        }

        return ok(
          await withDelta(mgr, sessionId, waitMs, async (recorder, page) => {
            switch (action.kind) {
              case "goto":
                await mgr.goto(action.url!, sessionId);
                return;
              case "reload":
                await recorder.hardReload();
                return;
              case "eval":
                return { note: "eval → " + summarizeEvalResult(await page.evaluate(action.expression!)) };
              case "wait":
                return;
            }
          }),
        );
      }),
  );
}
