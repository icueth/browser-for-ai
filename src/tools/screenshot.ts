import { z } from "zod";
import type { Page } from "puppeteer-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionManager } from "../session/manager";
import { fail } from "../format/compact";
import { targetFields, resolveTarget } from "./refs";

/** Width/height of a PNG straight from its IHDR chunk — no image library needed. */
export function pngSize(b64: string): { width: number; height: number } {
  const buf = Buffer.from(b64, "base64");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A rectangle in CSS px, relative to the VIEWPORT (what elementHandle.boundingBox() returns). */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CssCapture {
  /** base64 PNG */
  data: string;
  /** image pixels */
  width: number;
  height: number;
  /** CSS pixels of the captured region */
  cssWidth: number;
  cssHeight: number;
  /** image px per CSS px — 1 when normalized (the goal), dpr when fullRes */
  scale: number;
  /** page scroll at capture time (CSS px) — turns a document-relative point into a viewport coord */
  scrollX: number;
  scrollY: number;
  /** fullPage only: the CSS height the capture was clamped to (Chromium / pixel-budget limit) */
  truncatedAt?: number;
}

/** Chromium refuses/blanks captures beyond ~16384 px, and a giant bitmap can take the whole browser down. */
const FULLPAGE_MAX_PX = 16384;
const FULLPAGE_PIXEL_BUDGET = 40_000_000;

/** What a capture's pixels are relative to — decides how the mapping note is phrased. */
export type CaptureKind = "viewport" | "element" | "fullPage";

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * Capture a screenshot whose pixels map 1:1 to CSS pixels — the SAME coordinate space that
 * page_click_at / page_tap_at / page_drag use — so a point read off the image can be clicked
 * directly. On a HiDPI display (devicePixelRatio 2, Retina) a plain screenshot is 2x the CSS size,
 * which silently breaks "look at the picture, click there". We ask CDP to scale the capture by
 * 1/dpr; if the result still isn't 1:1 (an environment whose capture base isn't dpr-driven), we
 * measure the real factor from a plain shot and re-capture with its inverse — self-healing rather
 * than assuming. fullRes:true keeps native device pixels instead (for fine detail).
 *
 * Coordinate contract (verified empirically against puppeteer): its `clip` is DOCUMENT-relative.
 * So the "current viewport" is {scrollX, scrollY, w, h} — NOT {0,0,w,h}, which on a scrolled page
 * captures the document top (or throws "0 height") — and a viewport-relative `region` must be
 * offset by the current scroll before use. fullPage captures the whole document from its origin,
 * so ITS pixels are document-relative (see mappingNote).
 */
export async function captureCss(
  page: Page,
  opts: { region?: CssRect; fullPage?: boolean; fullRes?: boolean } = {},
): Promise<CssCapture> {
  // A background tab of an attached (headful) Chrome doesn't paint — bring it forward first.
  await page.bringToFront().catch(() => {});
  const m = await page.evaluate(() => ({
    dpr: window.devicePixelRatio || 1,
    w: window.innerWidth,
    h: window.innerHeight,
    sx: window.scrollX,
    sy: window.scrollY,
    docW: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
    docH: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
  }));
  let truncatedAt: number | undefined;
  let region: CssRect;
  if (opts.region) {
    region = { x: opts.region.x + m.sx, y: opts.region.y + m.sy, width: opts.region.width, height: opts.region.height };
  } else if (opts.fullPage) {
    // Bound the raster: Chromium caps captures around 16384 px, and a multi-GB bitmap has crashed
    // the whole browser (in attach mode: the user's). Also honour a pixel budget.
    const width = Math.max(m.w, m.docW);
    const scale = opts.fullRes ? m.dpr : 1;
    const budgetH = Math.floor(FULLPAGE_PIXEL_BUDGET / (width * scale * scale));
    const height = Math.min(m.docH, FULLPAGE_MAX_PX, Math.max(m.h, budgetH));
    if (height < m.docH) truncatedAt = height;
    region = { x: 0, y: 0, width, height };
  } else {
    region = { x: m.sx, y: m.sy, width: m.w, height: m.h };
  }
  if (region.width < 1 || region.height < 1) throw new Error("nothing visible to capture (empty region)");

  // captureBeyondViewport MUST stay true: with false, puppeteer intersects the clip with the viewport and
  // rebuilds the rect WITHOUT `scale`, silently dropping the 1/dpr normalization (observed: 1600px, not 800).
  // With true, a viewport-sized or element clip renders identically to a plain/element screenshot (verified).
  const shoot = (scale: number) =>
    page.screenshot({ encoding: "base64", captureBeyondViewport: true, clip: { ...region, scale } });

  let data = await shoot(opts.fullRes ? 1 : 1 / m.dpr);
  let size = pngSize(data);
  if (!opts.fullRes && Math.abs(size.width - Math.round(region.width)) > 1) {
    // Self-heal: this environment's capture base isn't dpr-based — measure it and normalize.
    const probe = pngSize(await shoot(1));
    const factor = probe.width / region.width;
    if (factor > 0 && Math.abs(factor - 1) > 0.01) {
      data = await shoot(1 / factor);
      size = pngSize(data);
    }
  }
  return {
    data,
    width: size.width,
    height: size.height,
    cssWidth: Math.round(region.width),
    cssHeight: Math.round(region.height),
    scale: size.width / region.width,
    scrollX: m.sx,
    scrollY: m.sy,
    truncatedAt,
  };
}

/** Human line that tells the model exactly how image pixels map to click coordinates — phrased per
 *  what the pixels are relative to. Only a VIEWPORT capture is directly clickable: page_click_at takes
 *  viewport coords, so a fullPage image (document-relative) must be converted through scrollY, and an
 *  element crop through the element's origin. */
export function mappingNote(cap: CssCapture, kind: CaptureKind = "viewport"): string {
  const dims = `image ${cap.width}×${cap.height}px = css ${cap.cssWidth}×${cap.cssHeight}`;
  const oneToOne = cap.scale > 0.99 && cap.scale < 1.01;
  const s = fmt(cap.scale);
  const unscale = oneToOne ? "" : ` (image is scale ${s}: divide image coords by ${s} first)`;
  if (kind === "fullPage") {
    return (
      `${dims} — DOCUMENT-relative, NOT a click coordinate${unscale}. page_click_at takes VIEWPORT coords: ` +
      `x = image_x${oneToOne ? "" : "/" + s} − scrollX (${cap.scrollX} now), y = image_y${oneToOne ? "" : "/" + s} − scrollY (${cap.scrollY} now); ` +
      `if that point is outside the current viewport, page_scroll to it first — or use page_look / page_find to click by ref instead` +
      (cap.truncatedAt ? `; capture truncated at ${cap.truncatedAt}px of document height (Chromium/pixel-budget limit) — page_scroll and re-capture for the rest` : "")
    );
  }
  if (kind === "element") {
    return `${dims} — relative to the element crop${unscale}; see the origin note for the page coordinate`;
  }
  return oneToOne
    ? `${dims} (1:1 — a point in this image IS the page_click_at {x,y})`
    : `${dims} (scale ${s} — divide image coords by ${s} for page_click_at)`;
}

/** Registers page_screenshot. Its success result carries image content, which `ToolResult`
 *  (text-only) can't express — so it builds the CallToolResult directly and falls back to the
 *  same `fail()` text result on error. */
export function registerScreenshotTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_screenshot",
    {
      description:
        "Capture a PNG screenshot that is 1:1 with CSS pixels. The default (current viewport) shares the exact " +
        "coordinate space of page_click_at / page_tap_at / page_drag, so a point you read off the image can be " +
        "clicked directly — a text line states the mapping. fullPage:true captures the whole scrollable page " +
        "(document-relative: the note explains the scrollY conversion; prefer page_look/page_find to click). A single " +
        "element by ref/selector gets a crop plus its page origin. fullRes:true returns native device pixels (2x on " +
        "Retina) for fine detail. To see numbered click targets on the image, use page_look. Use sparingly — image " +
        "content is expensive.",
      inputSchema: {
        ...targetFields,
        sessionId: z.string().optional(),
        fullPage: z
          .boolean()
          .optional()
          .describe("capture the full scrollable page instead of just the viewport (ignored when ref/selector is given)"),
        fullRes: z.boolean().optional().describe("keep native device pixels (2x on HiDPI) instead of normalizing to CSS px"),
      },
    },
    async ({ ref, selector, sessionId, fullPage, fullRes }): Promise<CallToolResult> => {
      try {
        const page = mgr.pageFor(sessionId);
        return await mgr.withPageLock(sessionId, async (): Promise<CallToolResult> => {
          if (ref || selector) {
            const el = await resolveTarget(page, { ref, selector }, "page_screenshot");
            // Only scroll when the element isn't fully in view: an unconditional scroll would
            // silently move the page and stale every coordinate read off an earlier image.
            const inView = await el.isIntersectingViewport({ threshold: 1 }).catch(() => false);
            if (!inView) {
              await el.evaluate((e) => e.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" as ScrollBehavior }));
            }
            const box = await el.boundingBox(); // viewport-relative — exactly what page_click_at wants
            if (!box || box.width < 1 || box.height < 1) return fail("element has no visible box to capture");
            const cap = await captureCss(page, { region: box, fullRes: !!fullRes });
            const ox = Math.round(box.x);
            const oy = Math.round(box.y);
            const note =
              `element ${mappingNote(cap, "element")}; element origin at page (${ox}, ${oy}) → ` +
              `page_click_at x = ${ox} + ix/${fmt(cap.scale)}, y = ${oy} + iy/${fmt(cap.scale)}` +
              (inView ? "" : " (page was scrolled to bring it into view — coordinates from earlier images are stale)");
            return { content: [{ type: "image", data: cap.data, mimeType: "image/png" }, { type: "text", text: note }] };
          }
          const cap = await captureCss(page, { fullPage: !!fullPage, fullRes: !!fullRes });
          const note = mappingNote(cap, fullPage ? "fullPage" : "viewport");
          return { content: [{ type: "image", data: cap.data, mimeType: "image/png" }, { type: "text", text: note }] };
        });
      } catch (err) {
        return fail(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
