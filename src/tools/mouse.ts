import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok } from "../format/compact";
import { guard } from "./guard";
import { withDelta } from "./delta";

/** Registers Phase 3 coordinate-based mouse tools — for canvas/WebGL surfaces (e.g. games)
 *  that expose no DOM element for page_click/page_hover's ref/selector targeting. */
export function registerMouseTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_click_at",
    {
      description:
        "Click at a raw viewport coordinate (no DOM target needed — for canvas/WebGL surfaces) and report the network/console/url delta it caused.",
      inputSchema: {
        x: z.number(),
        y: z.number(),
        sessionId: z.string().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        clicks: z.number().int().optional().describe("click count (e.g. 2 for double-click, default 1)"),
        waitMs: z.number().int().nonnegative().optional().describe("settle time after the click before reporting the delta (default 700ms)"),
      },
    },
    async ({ x, y, sessionId, button, clicks, waitMs }) =>
      guard(async () =>
        ok(
          await withDelta(mgr, sessionId, waitMs, async (_rec, page) => {
            await page.mouse.click(x, y, { button: button ?? "left", clickCount: clicks ?? 1 });
            return { note: `clicked at (${x}, ${y})` };
          }),
        ),
      ),
  );

  server.registerTool(
    "page_tap_at",
    {
      description:
        "Touch-TAP at a raw viewport coordinate (dispatches touchstart→touchend, for canvas/WebGL games that listen for touch rather than mouse) and report the network/console/url delta it caused. Requires the session viewport to have hasTouch:true (set it via browser_launch {viewport:{...,hasTouch:true}} or page_set_viewport). If a game ignores page_click_at, try this.",
      inputSchema: {
        x: z.number(),
        y: z.number(),
        sessionId: z.string().optional(),
        waitMs: z.number().int().nonnegative().optional().describe("settle time after the tap before reporting the delta (default 700ms)"),
      },
    },
    async ({ x, y, sessionId, waitMs }) =>
      guard(async () =>
        ok(
          await withDelta(mgr, sessionId, waitMs, async (_rec, page) => {
            await page.touchscreen.tap(x, y);
            return { note: `tapped at (${x}, ${y})` };
          }),
        ),
      ),
  );

  server.registerTool(
    "page_drag",
    {
      description:
        "Drag the mouse from one raw viewport coordinate to another (mousedown → move → mouseup, no DOM target needed) and report the network/console/url delta it caused.",
      inputSchema: {
        fromX: z.number(),
        fromY: z.number(),
        toX: z.number(),
        toY: z.number(),
        sessionId: z.string().optional(),
        waitMs: z.number().int().nonnegative().optional().describe("settle time after the drag before reporting the delta (default 700ms)"),
      },
    },
    async ({ fromX, fromY, toX, toY, sessionId, waitMs }) =>
      guard(async () =>
        ok(
          await withDelta(mgr, sessionId, waitMs, async (_rec, page) => {
            await page.mouse.move(fromX, fromY);
            await page.mouse.down();
            await page.mouse.move(toX, toY, { steps: 8 });
            await page.mouse.up();
            return { note: `dragged (${fromX},${fromY})→(${toX},${toY})` };
          }),
        ),
      ),
  );
}
