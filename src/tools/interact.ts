import { z } from "zod";
import type { ElementHandle } from "puppeteer-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import { ok } from "../format/compact";
import { guard } from "./guard";
import { withDelta } from "./delta";
import { targetFields, resolveTarget, describeTarget } from "./refs";
import type { Target } from "./refs";

/** Splits a "Control+Shift+A"-style key combo into (modifiers, key). A bare key like "Enter"
 *  yields no modifiers. */
function parseKeyCombo(keys: string): { modifiers: string[]; key: string } {
  const parts = keys.split("+");
  const key = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1);
  return { modifiers, key };
}

/** Registers Phase 2 page-interaction tools. Task 2.3 registers click+type; later tasks
 *  (2.4/2.5) extend this same function with fill/select/key/hover/scroll. */
export function registerInteractTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_click",
    {
      description:
        "Click an element (by ref from page_snapshot, or CSS selector) and report the network/console/url delta it caused.",
      inputSchema: {
        ...targetFields,
        sessionId: z.string().optional(),
        waitMs: z.number().int().nonnegative().optional().describe("settle time after the click before reporting the delta (default 700ms)"),
      },
    },
    async ({ ref, selector, sessionId, waitMs }) =>
      guard(async () =>
        ok(
          await withDelta(mgr, sessionId, waitMs, async (_rec, page) => {
            const el = await resolveTarget(page, { ref, selector }, "page_click");
            await el.click();
            return { note: `clicked ${describeTarget({ ref, selector })}` };
          }),
        ),
      ),
  );

  server.registerTool(
    "page_type",
    {
      description:
        "Type text into an element (by ref from page_snapshot, or CSS selector) and report the network/console/url delta it caused. Set clear:true to select-all+backspace the field first.",
      inputSchema: {
        ...targetFields,
        text: z.string(),
        sessionId: z.string().optional(),
        waitMs: z.number().int().nonnegative().optional().describe("settle time after typing before reporting the delta (default 700ms)"),
        clear: z.boolean().optional().describe("clear the field (select-all + backspace) before typing"),
      },
    },
    async ({ ref, selector, text, sessionId, waitMs, clear }) =>
      guard(async () =>
        ok(
          await withDelta(mgr, sessionId, waitMs, async (_rec, page) => {
            const el = await resolveTarget(page, { ref, selector }, "page_type");
            if (clear) {
              await el.click({ clickCount: 3 });
              await page.keyboard.press("Backspace");
            }
            await el.type(text);
            return { note: `typed ${text.length} chars into ${describeTarget({ ref, selector })}` };
          }),
        ),
      ),
  );

  server.registerTool(
    "page_fill",
    {
      description:
        "Clear and fill multiple form fields (each by ref from page_snapshot, or CSS selector) in one call, and report the network/console/url delta it caused.",
      inputSchema: {
        fields: z.array(
          z.object({
            ref: z.string().optional(),
            selector: z.string().optional(),
            value: z.string(),
          }),
        ),
        sessionId: z.string().optional(),
        waitMs: z.number().int().nonnegative().optional().describe("settle time after filling before reporting the delta (default 700ms)"),
      },
    },
    async ({ fields, sessionId, waitMs }) =>
      guard(async () =>
        ok(
          await withDelta(mgr, sessionId, waitMs, async (_rec, page) => {
            for (const field of fields) {
              const el = await resolveTarget(page, { ref: field.ref, selector: field.selector }, "page_fill");
              await el.click({ clickCount: 3 });
              await page.keyboard.press("Backspace");
              await el.type(field.value);
            }
            return { note: `filled ${fields.length} fields` };
          }),
        ),
      ),
  );

  server.registerTool(
    "page_select",
    {
      description:
        "Select an option (by value) in a <select> element (by ref from page_snapshot, or CSS selector) and report the network/console/url delta it caused.",
      inputSchema: {
        ...targetFields,
        value: z.string(),
        sessionId: z.string().optional(),
        waitMs: z.number().int().nonnegative().optional().describe("settle time after selecting before reporting the delta (default 700ms)"),
      },
    },
    async ({ ref, selector, value, sessionId, waitMs }) =>
      guard(async () =>
        ok(
          await withDelta(mgr, sessionId, waitMs, async (_rec, page) => {
            const el = await resolveTarget(page, { ref, selector }, "page_select");
            await (el as ElementHandle<HTMLSelectElement>).select(value);
            return { note: `selected "${value}" in ${describeTarget({ ref, selector })}` };
          }),
        ),
      ),
  );

  server.registerTool(
    "page_key",
    {
      description:
        'Press a key or key combo (e.g. "Enter", "Control+A") and report the network/console/url delta it caused.',
      inputSchema: {
        keys: z.string(),
        sessionId: z.string().optional(),
        waitMs: z.number().int().nonnegative().optional().describe("settle time after the key press before reporting the delta (default 700ms)"),
      },
    },
    async ({ keys, sessionId, waitMs }) =>
      guard(async () =>
        ok(
          await withDelta(mgr, sessionId, waitMs, async (_rec, page) => {
            const { modifiers, key } = parseKeyCombo(keys);
            try {
              for (const m of modifiers) await page.keyboard.down(m as Parameters<typeof page.keyboard.down>[0]);
              await page.keyboard.press(key as Parameters<typeof page.keyboard.press>[0]);
            } finally {
              // Release in finally (and from a copy, not the live array) so a throw mid-down
              // or on the press itself can never leave a modifier stuck "down" for the rest of
              // the session — releasing a modifier that was never pressed is a harmless no-op.
              for (const m of [...modifiers].reverse()) await page.keyboard.up(m as Parameters<typeof page.keyboard.up>[0]);
            }
            return { note: `pressed ${keys}` };
          }),
        ),
      ),
  );

  server.registerTool(
    "page_hover",
    {
      description:
        "Hover an element (by ref from page_snapshot, or CSS selector) and report the network/console/url delta it caused.",
      inputSchema: {
        ...targetFields,
        sessionId: z.string().optional(),
        waitMs: z.number().int().nonnegative().optional().describe("settle time after the hover before reporting the delta (default 700ms)"),
      },
    },
    async ({ ref, selector, sessionId, waitMs }) =>
      guard(async () =>
        ok(
          await withDelta(mgr, sessionId, waitMs, async (_rec, page) => {
            const el = await resolveTarget(page, { ref, selector }, "page_hover");
            await el.hover();
            return { note: `hovered ${describeTarget({ ref, selector })}` };
          }),
        ),
      ),
  );

  server.registerTool(
    "page_scroll",
    {
      description:
        "Scroll the page: with a ref/selector, scrolls that element into view; otherwise scrolls the window vertically by dy pixels (default 600). Reports the network/console/url delta it caused.",
      inputSchema: {
        ...targetFields,
        dy: z.number().optional().describe("vertical pixels to scroll the window by, when no ref/selector is given (default 600)"),
        sessionId: z.string().optional(),
        waitMs: z.number().int().nonnegative().optional().describe("settle time after scrolling before reporting the delta (default 700ms)"),
      },
    },
    async ({ ref, selector, dy, sessionId, waitMs }) =>
      guard(async () =>
        ok(
          await withDelta(mgr, sessionId, waitMs, async (_rec, page) => {
            const target: Target = { ref, selector };
            if (target.ref || target.selector) {
              const el = await resolveTarget(page, target, "page_scroll");
              await el.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }));
              return { note: `scrolled ${describeTarget(target)} into view` };
            }
            const amount = dy ?? 600;
            await page.evaluate((y) => window.scrollBy(0, y), amount);
            return { note: `scrolled by ${amount}px` };
          }),
        ),
      ),
  );
}
