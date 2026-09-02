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
}

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
 * offset by the current scroll before use. fullPage captures the whole document from its origin.
 */
export async function captureCss(
  page: Page,
  opts: { region?: CssRect; fullPage?: boolean; fullRes?: boolean } = {},
): Promise<CssCapture> {
  const m = await page.evaluate(() => ({
    dpr: window.devicePixelRatio || 1,
    w: window.innerWidth,
    h: window.innerHeight,
    sx: window.scrollX,
    sy: window.scrollY,
    docH: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
  }));
  const region: CssRect = opts.region
    ? { x: opts.region.x + m.sx, y: opts.region.y + m.sy, width: opts.region.width, height: opts.region.height }
    : opts.fullPage
      ? { x: 0, y: 0, width: m.w, height: m.docH }
      : { x: m.sx, y: m.sy, width: m.w, height: m.h };
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
  };
}

/** Human line that tells the model exactly how image pixels map to click coordinates. */
export function mappingNote(cap: CssCapture): string {
  return cap.scale > 0.99 && cap.scale < 1.01
    ? `image ${cap.width}×${cap.height}px = css ${cap.cssWidth}×${cap.cssHeight} (1:1 — a point in this image IS the page_click_at {x,y})`
    : `image ${cap.width}×${cap.height}px = css ${cap.cssWidth}×${cap.cssHeight} (scale ${fmt(cap.scale)} — divide image coords by ${fmt(cap.scale)} for page_click_at)`;
}

/** Registers page_screenshot. Its success result carries image content, which `ToolResult`
 *  (text-only) can't express — so it builds the CallToolResult directly and falls back to the
 *  same `fail()` text result on error. */
export function registerScreenshotTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_screenshot",
    {
      description:
        "Capture a PNG screenshot that is 1:1 with CSS pixels — the same coordinate space as " +
        "page_click_at / page_tap_at / page_drag — so a point you read off the image can be clicked directly " +
        "(a text line states the mapping). Current viewport by default; fullPage:true for the full scrollable page; " +
        "or a single element by ref/selector (the text line gives the element's page offset). fullRes:true returns " +
        "native device pixels (2x on Retina) when you need fine detail. To see numbered click targets on the " +
        "image, use page_look instead. Use sparingly — image content is expensive.",
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
        if (ref || selector) {
          const el = await resolveTarget(page, { ref, selector }, "page_screenshot");
          await el.evaluate((e) => e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior }));
          const box = await el.boundingBox(); // viewport-relative — exactly what page_click_at wants
          if (!box || box.width < 1 || box.height < 1) return fail("element has no visible box to capture");
          const cap = await captureCss(page, { region: box, fullRes: !!fullRes });
          const ox = Math.round(box.x);
          const oy = Math.round(box.y);
          const note =
            `element ${mappingNote(cap)}; element origin at page (${ox}, ${oy}) → ` +
            `page_click_at x = ${ox} + ix/${fmt(cap.scale)}, y = ${oy} + iy/${fmt(cap.scale)}`;
          return { content: [{ type: "image", data: cap.data, mimeType: "image/png" }, { type: "text", text: note }] };
        }
        const cap = await captureCss(page, { fullPage: !!fullPage, fullRes: !!fullRes });
        return { content: [{ type: "image", data: cap.data, mimeType: "image/png" }, { type: "text", text: mappingNote(cap) }] };
      } catch (err) {
        return fail(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
