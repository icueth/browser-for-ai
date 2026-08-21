import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok, fail } from "../format/compact";
import { guard } from "./guard";
import { collectSnapshot, formatLine, INTERACTIVE_SELECTOR } from "./snapshot";

const DEFAULT_LIMIT = 30;

/** Registers page_find — the "just get me the ref(s)" shortcut over page_snapshot. Instead of
 *  listing every interactive element for the agent to scan, it filters by visible text, ARIA role,
 *  and/or CSS, and returns only the matches (each with a data-bfa-ref usable by page_click/type/…). */
export function registerFindTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_find",
    {
      description:
        "Find elements on the page by visible TEXT, ARIA ROLE, and/or a CSS SELECTOR, returning each " +
        "match with a stable ref (e1, e2, ...) for page_click/page_type/etc — the targeted alternative to " +
        "page_snapshot's full listing. Give at least one of text/role/selector; they AND together. Searches " +
        "interactive elements by default; set includeNonInteractive:true to search all elements (e.g. to find " +
        "a heading or price by text). Refs from a prior snapshot/find are invalidated by this call.",
      inputSchema: {
        sessionId: z.string().optional(),
        text: z
          .string()
          .optional()
          .describe("case-insensitive substring to match against an element's visible/accessible text"),
        role: z
          .string()
          .optional()
          .describe("ARIA role to match, explicit or implicit — e.g. button, link, textbox, checkbox, combobox"),
        selector: z.string().optional().describe("raw CSS selector to match (escape hatch; narrows the search base)"),
        includeNonInteractive: z
          .boolean()
          .optional()
          .describe("also search non-interactive elements (default: interactive only). Ignored when selector is given"),
        limit: z.number().int().positive().optional().describe("max matches to return (default 30)"),
      },
    },
    async ({ sessionId, text, role, selector, includeNonInteractive, limit }) =>
      guard(async () => {
        if (!text && !role && !selector) {
          return fail("page_find needs at least one of text/role/selector — use page_snapshot to list everything");
        }
        const page = mgr.pageFor(sessionId);
        // Base node set: an explicit selector wins; otherwise interactive-only, or every element
        // when includeNonInteractive. "deepest" only makes sense for the broad content search —
        // it drops wrapper elements so a text match returns the innermost node.
        const base = selector ?? (includeNonInteractive ? "*" : INTERACTIVE_SELECTOR);
        const deepest = !selector && !!includeNonInteractive;

        const items = await page.evaluate(collectSnapshot, {
          selector: base,
          text: text ?? null,
          role: role ?? null,
          deepest,
        });

        const cap = limit ?? DEFAULT_LIMIT;
        const shown = items.slice(0, cap);
        const lines = shown.map(formatLine);
        if (shown.length < items.length) {
          lines.push(`showing ${shown.length} of ${items.length} matches (raise limit for more)`);
        }
        return ok(lines.length > 0 ? lines.join("\n") : "(no matches)");
      }),
  );
}
