import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import type { Rule } from "../recorder/intercept";
import { ok, table, truncate } from "../format/compact";
import { guard } from "./guard";

function rulesTable(rules: Rule[]): string {
  if (rules.length === 0) return "(no rules)";
  const body = rules.map((r) => [
    String(r.id),
    r.action,
    truncate(r.urlPattern, 80),
    r.action === "mock" ? String(r.status ?? 200) : "-",
  ]);
  return table(["id", "action", "urlPattern", "status"], body);
}

export function registerInterceptTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "net_intercept_add",
    {
      description:
        "Add a network intercept rule via CDP Fetch: block a request, mock its response, or modify its headers. Matches when urlPattern is a substring of the request url; the first matching rule wins. Enables interception lazily on first use.",
      inputSchema: {
        sessionId: z.string().optional(),
        urlPattern: z.string().describe("substring match against the request url"),
        action: z.enum(["block", "mock", "modify"]),
        status: z.number().int().optional().describe("mock: response status code (default 200)"),
        body: z.string().optional().describe("mock: response body"),
        contentType: z.string().optional().describe("mock: response content-type (default application/json)"),
        setHeaders: z.record(z.string(), z.string()).optional().describe("modify: headers to set/override on the outgoing request"),
      },
    },
    async ({ sessionId, urlPattern, action, status, body, contentType, setHeaders }) =>
      guard(async () => {
        const interceptor = mgr.interceptorFor(sessionId);
        await interceptor.enable();
        const rule = interceptor.add({ urlPattern, action, status, body, contentType, setHeaders });
        return ok(`rule #${rule.id} added: ${action} ${urlPattern}`);
      }),
  );

  server.registerTool(
    "net_intercept_list",
    {
      description: "List active network intercept rules for a session.",
      inputSchema: { sessionId: z.string().optional() },
    },
    async ({ sessionId }) =>
      guard(async () => {
        const interceptor = mgr.interceptorFor(sessionId);
        return ok(rulesTable(interceptor.list()));
      }),
  );

  server.registerTool(
    "net_intercept_clear",
    {
      description: "Clear all network intercept rules for a session (interception stays enabled; requests simply stop matching).",
      inputSchema: { sessionId: z.string().optional() },
    },
    async ({ sessionId }) =>
      guard(async () => {
        const interceptor = mgr.interceptorFor(sessionId);
        const n = interceptor.list().length;
        interceptor.clear();
        return ok(`cleared ${n} rules`);
      }),
  );
}
