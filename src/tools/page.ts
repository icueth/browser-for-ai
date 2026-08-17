import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok } from "../format/compact";
import { guard } from "./guard";

export function registerPageTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_goto",
    {
      description: "Navigate the active (or given) session to a URL.",
      inputSchema: { url: z.string().url(), sessionId: z.string().optional() },
    },
    async ({ url, sessionId }) =>
      guard(async () => {
        const info = await mgr.goto(url, sessionId);
        return ok(`${info.sessionId} → ${info.url} · "${info.title ?? ""}"`);
      }),
  );

  server.registerTool(
    "page_state",
    {
      description: "Report current page state: url, title, readyState, viewport.",
      inputSchema: { sessionId: z.string().optional() },
    },
    async ({ sessionId }) =>
      guard(async () => {
        const st = await mgr.state(sessionId);
        const vp = st.viewport ? `${st.viewport.width}x${st.viewport.height}` : "default";
        return ok(
          `session ${st.sessionId} (${st.mode})\nurl: ${st.url}\ntitle: ${st.title ?? ""}\nreadyState: ${st.readyState}\nviewport: ${vp}`,
        );
      }),
  );
}
