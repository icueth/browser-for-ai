import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionManager } from "../session/manager";
import { fail } from "../format/compact";
import { collectSnapshot, formatLine, INTERACTIVE_SELECTOR } from "./snapshot";
import { captureCss, mappingNote, type CssCapture } from "./screenshot";

const DEFAULT_MARKS = 80;
const MARKS_ID = "__bfa_marks";

/** In-page (page.evaluate, self-contained): draw a numbered badge + outline over every ref'd
 *  element inside the viewport, in ref order, up to `max`. Returns the refs actually marked.
 *  The layer is pointer-events:none and lives in a fixed overlay so it never affects layout. */
function drawMarks(opts: { id: string; max: number }): string[] {
  const old = document.getElementById(opts.id);
  if (old) old.remove();
  const layer = document.createElement("div");
  layer.id = opts.id;
  layer.setAttribute(
    "style",
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:bold 11px/14px ui-monospace,Menlo,monospace;",
  );
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const els = Array.from(document.querySelectorAll("[data-bfa-ref]")) as HTMLElement[];
  els.sort(
    (a, b) => Number((a.getAttribute("data-bfa-ref") || "e0").slice(1)) - Number((b.getAttribute("data-bfa-ref") || "e0").slice(1)),
  );
  const marked: string[] = [];
  for (const el of els) {
    if (marked.length >= opts.max) break;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) continue;
    if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
    const ref = el.getAttribute("data-bfa-ref") || "";
    const box = document.createElement("div");
    box.setAttribute(
      "style",
      `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid rgba(255,0,128,.95);outline-offset:-1px;box-sizing:border-box;`,
    );
    const tag = document.createElement("div");
    tag.textContent = ref.slice(1); // badge shows just the number; legend maps it to eN
    const tx = Math.max(0, Math.min(r.left, vw - 24));
    const ty = r.top >= 14 ? r.top - 14 : r.top;
    tag.setAttribute(
      "style",
      `position:absolute;left:${tx}px;top:${ty}px;background:#ffd400;color:#000;border:1px solid #000;border-radius:3px;padding:0 3px;white-space:nowrap;`,
    );
    layer.appendChild(box);
    layer.appendChild(tag);
    marked.push(ref);
  }
  document.documentElement.appendChild(layer);
  return marked;
}

function removeMarks(id: string): void {
  const el = document.getElementById(id);
  if (el) el.remove();
}

/** Registers page_look — "see it, then click it". A Set-of-Mark screenshot: every interactive
 *  element gets a numbered badge in the picture and a matching legend line, so the model reads the
 *  image, picks a number, and clicks that ref precisely — no coordinate arithmetic, no guessing. */
export function registerLookTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_look",
    {
      description:
        "SEE the page the way you'd click it: a screenshot with a numbered badge drawn on each interactive " +
        "element (Set-of-Mark) plus a legend mapping badge N → ref eN. Read the picture, pick a number, then " +
        'page_click {"ref":"eN"} — precise, no coordinate math. The image is 1:1 with CSS px, so a raw point ' +
        "can also be clicked with page_click_at. Optional text/role/selector mark only matching elements (like " +
        "page_find); includeNonInteractive marks any element. The overlay is removed after capture. Refs from a " +
        "prior snapshot/find are invalidated by this call.",
      inputSchema: {
        sessionId: z.string().optional(),
        text: z.string().optional().describe("only mark elements whose visible/accessible text contains this (case-insensitive)"),
        role: z.string().optional().describe("only mark this ARIA role (explicit or implicit), e.g. button, link, textbox"),
        selector: z.string().optional().describe("only mark elements matching this CSS selector"),
        includeNonInteractive: z.boolean().optional().describe("mark any element, not just interactive ones (ignored when selector is given)"),
        limit: z.number().int().positive().optional().describe("max badges to draw, in ref order (default 80)"),
        fullRes: z.boolean().optional().describe("keep native device pixels (2x on HiDPI) instead of normalizing to CSS px"),
      },
    },
    async ({ sessionId, text, role, selector, includeNonInteractive, limit, fullRes }): Promise<CallToolResult> => {
      try {
        const page = mgr.pageFor(sessionId);
        const base = selector ?? (includeNonInteractive ? "*" : INTERACTIVE_SELECTOR);
        const deepest = !selector && !!includeNonInteractive;
        const items = await page.evaluate(collectSnapshot, {
          selector: base,
          text: text ?? null,
          role: role ?? null,
          deepest,
        });
        if (items.length === 0) return { content: [{ type: "text", text: "(no matching elements to mark)" }] };

        const max = limit ?? DEFAULT_MARKS;
        let marked: string[] = [];
        let cap: CssCapture | undefined;
        try {
          marked = await page.evaluate(drawMarks, { id: MARKS_ID, max });
          cap = await captureCss(page, { fullRes: !!fullRes });
        } finally {
          // Never leave the overlay behind — even if the capture threw.
          await page.evaluate(removeMarks, MARKS_ID).catch(() => {});
        }
        const shot = cap!;
        const set = new Set(marked);
        const legend = items.filter((i) => set.has(i.ref)).map(formatLine);
        const unmarked = items.length - legend.length;
        const head =
          `${legend.length} marked (badge N = ref eN) · ${mappingNote(shot)}` +
          (unmarked > 0 ? ` · ${unmarked} more off-screen/tiny not marked (page_scroll or page_find to reach them)` : "");
        return {
          content: [
            { type: "text", text: [head, ...legend].join("\n") },
            { type: "image", data: shot.data, mimeType: "image/png" },
          ],
        };
      } catch (err) {
        return fail(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
