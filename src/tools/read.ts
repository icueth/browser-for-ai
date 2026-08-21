import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok } from "../format/compact";
import { guard } from "./guard";

/** Runs inside the page (page.evaluate) — self-contained. Extracts readable text from the chosen
 *  root (an explicit selector, else <main>/<article>, else <body>), and — when a query is given —
 *  keeps only the non-empty lines that contain it (case-insensitive). */
function extractText(opts: { selector: string | null; query: string | null }): string {
  const root = opts.selector
    ? document.querySelector(opts.selector)
    : document.querySelector("main") || document.querySelector("article") || document.body;
  if (!root) return "";
  const full = (root as HTMLElement).innerText || root.textContent || "";
  if (!opts.query) return full;
  const q = opts.query.toLowerCase();
  return full
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.toLowerCase().includes(q))
    .join("\n");
}

/** Registers page_read — read/search the page's CONTENT (as opposed to page_find, which locates
 *  clickable elements). Good for "does the page say X", pulling article/price/table text, or
 *  grepping a long page for the lines that mention a term. */
export function registerReadTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_read",
    {
      description:
        "Read the page's visible TEXT content (defaults to <main>/<article>, else the whole body), " +
        "optionally scoped to a CSS `selector` and/or filtered with `query` to only the lines that contain " +
        "it (case-insensitive). Use this to search/read page DATA — content, prices, table text, 'does the " +
        "page mention X'. To locate a clickable element instead, use page_find.",
      inputSchema: {
        sessionId: z.string().optional(),
        selector: z.string().optional().describe("CSS selector to read text from (default: <main>/<article>/<body>)"),
        query: z
          .string()
          .optional()
          .describe("case-insensitive term; return only the lines that contain it (default: the full text)"),
        maxChars: z.number().int().positive().optional().describe("truncate the returned text to this many chars (default 4000)"),
      },
    },
    async ({ sessionId, selector, query, maxChars }) =>
      guard(async () => {
        const page = mgr.pageFor(sessionId);
        const raw = await page.evaluate(extractText, { selector: selector ?? null, query: query ?? null });
        if (!raw.trim()) {
          return ok(query ? `(no lines matching "${query}")` : "(no text)");
        }
        const cap = maxChars ?? 4000;
        if (raw.length > cap) {
          return ok(`${raw.slice(0, cap)}\n… (${raw.length} chars total; raise maxChars for more)`);
        }
        return ok(raw);
      }),
  );
}
