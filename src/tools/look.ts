import { z } from "zod";
import type { Page } from "puppeteer-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionManager } from "../session/manager";
import { fail } from "../format/compact";
import { collectSnapshot, formatLine, INTERACTIVE_SELECTOR } from "./snapshot";
import { captureCss, mappingNote, type CssCapture } from "./screenshot";

const DEFAULT_MARKS = 80;
const MARKS_ID = "__bfa_marks";

interface MarkStats {
  marked: string[];
  truncated: number; // on-screen but beyond `limit`
  offscreen: number; // outside the viewport (page_scroll to reach)
  hidden: number; // covered / clipped: a click at the badge would hit something else
  tiny: number;
}

/** In-page (page.evaluate, self-contained): badge + outline every ref'd element that is REALLY
 *  visible at its rect, in ref order, up to `max`. "Really visible" = a hit-test at the rect
 *  centre lands on the element (not a modal backdrop, not the header a collapsed menu sits under):
 *  a badge the model can't click through would send page_click to the occluder instead.
 *  The layer is promoted to the top layer (popover) so it paints above <dialog>/popovers, uses
 *  CSSOM styles (CSP style-src can't block them), and compensates html{zoom}. */
function drawMarks(opts: { id: string; max: number }): MarkStats {
  const old = document.getElementById(opts.id);
  if (old) old.remove();
  const z = parseFloat(getComputedStyle(document.documentElement).zoom as string) || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const els = Array.from(document.querySelectorAll("[data-bfa-ref]")) as HTMLElement[];
  els.sort(
    (a, b) => Number((a.getAttribute("data-bfa-ref") || "e0").slice(1)) - Number((b.getAttribute("data-bfa-ref") || "e0").slice(1)),
  );

  const stats: MarkStats = { marked: [], truncated: 0, offscreen: 0, hidden: 0, tiny: 0 };
  const visible: { el: HTMLElement; r: DOMRect; ref: string }[] = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) {
      stats.tiny++;
      continue;
    }
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) {
      stats.offscreen++;
      continue;
    }
    // hit-test the visible centre (clamped into the viewport)
    const cx = Math.min(Math.max((Math.max(r.left, 0) + Math.min(r.right, vw)) / 2, 0), vw - 1);
    const cy = Math.min(Math.max((Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2, 0), vh - 1);
    const hit = document.elementFromPoint(cx, cy);
    const ok =
      !!hit &&
      (hit === el || el.contains(hit) || hit.contains(el) || (!!hit.shadowRoot && hit.shadowRoot.contains(el)));
    if (!ok) {
      stats.hidden++;
      continue;
    }
    visible.push({ el, r, ref: el.getAttribute("data-bfa-ref") || "" });
  }
  const toDraw = visible.slice(0, opts.max);
  stats.truncated = visible.length - toDraw.length;

  const layer = document.createElement("div");
  layer.id = opts.id;
  layer.style.cssText =
    "position:fixed;inset:0;margin:0;border:0;padding:0;width:auto;height:auto;max-width:none;max-height:none;" +
    "background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;" +
    "font:bold 11px/14px ui-monospace,Menlo,monospace;color:#000;";
  // Top layer: a manual popover paints above open <dialog>s / other popovers (most recent on top).
  try {
    layer.setAttribute("popover", "manual");
  } catch {
    /* older engines: plain fixed layer */
  }
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  for (const { r, ref } of toDraw) {
    const n = ref.slice(1);
    const left = r.left / z;
    const top = r.top / z;
    const width = r.width / z;
    const height = r.height / z;
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;outline:2px solid rgba(255,0,128,.95);outline-offset:-1px;box-sizing:border-box;`;
    const tag = document.createElement("div");
    tag.textContent = n; // badge shows just the number; legend maps it to eN
    const tw = 8 * n.length + 8;
    const th = 14;
    let tx = Math.max(0, Math.min(left, vw / z - tw));
    let ty = top >= th ? top - th : Math.max(0, top);
    ty = Math.min(ty, vh / z - th);
    // nudge off already-placed badges (nested/identical rects) so every number stays readable
    for (let tries = 0; tries < 4; tries++) {
      const clash = placed.find((p) => tx < p.x + p.w && tx + tw > p.x && ty < p.y + p.h && ty + th > p.y);
      if (!clash) break;
      tx = clash.x + clash.w + 2;
      if (tx + tw > vw / z) {
        tx = Math.max(0, left);
        ty = Math.min(ty + th + 2, vh / z - th);
      }
    }
    placed.push({ x: tx, y: ty, w: tw, h: th });
    tag.style.cssText = `position:absolute;left:${tx}px;top:${ty}px;background:#ffd400;color:#000;border:1px solid #000;border-radius:3px;padding:0 3px;white-space:nowrap;`;
    layer.appendChild(box);
    layer.appendChild(tag);
    stats.marked.push(ref);
  }
  document.documentElement.appendChild(layer);
  try {
    (layer as HTMLElement & { showPopover?: () => void }).showPopover?.();
  } catch {
    /* fixed layer already visible */
  }
  return stats;
}

function removeMarks(id: string): void {
  const el = document.getElementById(id);
  if (el) el.remove();
}

export interface LookOptions {
  text?: string;
  role?: string;
  selector?: string;
  includeNonInteractive?: boolean;
  limit?: number;
  fullRes?: boolean;
}

/** The whole look sequence (refs → overlay → 1:1 capture → overlay removed) as a reusable unit —
 *  page_look and page_batch{look:true} both use it. Caller must hold the session's page lock. */
export async function captureLook(page: Page, o: LookOptions): Promise<{ text: string; image: CssCapture }> {
  const base = o.selector ?? (o.includeNonInteractive ? "*" : INTERACTIVE_SELECTOR);
  const deepest = !o.selector && !!o.includeNonInteractive;
  const items = await page.evaluate(collectSnapshot, {
    selector: base,
    text: o.text ?? null,
    role: o.role ?? null,
    deepest,
  });
  const max = o.limit ?? DEFAULT_MARKS;
  let stats: MarkStats = { marked: [], truncated: 0, offscreen: 0, hidden: 0, tiny: 0 };
  let cap: CssCapture | undefined;
  try {
    if (items.length > 0) stats = await page.evaluate(drawMarks, { id: MARKS_ID, max });
    cap = await captureCss(page, { fullRes: !!o.fullRes });
  } finally {
    // Never leave the overlay behind — even if the capture threw.
    await page.evaluate(removeMarks, MARKS_ID).catch(() => {});
  }
  const shot = cap!;
  const set = new Set(stats.marked);
  const legend = items.filter((i) => set.has(i.ref)).map(formatLine);
  const tail: string[] = [];
  if (stats.truncated) tail.push(`${stats.truncated} more on-screen not badged (raise limit)`);
  if (stats.offscreen) tail.push(`${stats.offscreen} off-screen (page_scroll / page_find to reach)`);
  if (stats.hidden) tail.push(`${stats.hidden} covered/clipped skipped (a click there would hit something else)`);
  if (stats.tiny) tail.push(`${stats.tiny} too small`);
  const head =
    `${legend.length} marked (badge N = ref eN) · ${mappingNote(shot)}` +
    (tail.length ? ` · ${tail.join(" · ")}` : "") +
    (items.length === 0 ? " · no matching elements — image only (page_screenshot semantics)" : "");
  return { text: [head, ...legend].join("\n"), image: shot };
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
        'page_click {"ref":"eN"} — precise, no coordinate math. Only elements that are really visible at their spot ' +
        "get a badge (covered/clipped ones are skipped and counted). The image is 1:1 with CSS px, so a raw point " +
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
        const { text: legend, image } = await mgr.withPageLock(sessionId, () =>
          captureLook(page, { text, role, selector, includeNonInteractive, limit, fullRes }),
        );
        return {
          content: [
            { type: "text", text: legend },
            { type: "image", data: image.data, mimeType: "image/png" },
          ],
        };
      } catch (err) {
        return fail(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
