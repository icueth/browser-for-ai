import { z } from "zod";
import type { ElementHandle, Page } from "puppeteer-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionManager } from "../session/manager";
import type { Recorder } from "../recorder/recorder";
import { fail } from "../format/compact";
import { withDelta, settle } from "./delta";
import { resolveTarget } from "./refs";
import { collectSnapshot, INTERACTIVE_SELECTOR } from "./snapshot";
import { captureLook } from "./look";
import { waitFor } from "./waitfor";

const ACTIONS = ["click", "type", "fill", "select", "key", "hover", "scroll", "click_at", "goto", "wait", "wait_for"] as const;
const MAX_STEPS = 40;
const DEFAULT_STEP_SETTLE_MS = 300;

const stepSchema = z.object({
  action: z.enum(ACTIONS),
  ref: z.string().optional().describe("target by ref from page_snapshot/page_find/page_look (valid only until the DOM changes)"),
  selector: z.string().optional().describe("target by CSS selector"),
  text: z.string().optional().describe("target the first interactive element whose visible text contains this (case-insensitive) — the robust choice inside a batch; for wait_for: the text to wait for"),
  value: z.string().optional().describe("type/fill: the text to enter; select: the option value"),
  keys: z.string().optional().describe('key: e.g. "Enter", "Control+A"'),
  x: z.number().optional().describe("click_at: viewport x (CSS px)"),
  y: z.number().optional().describe("click_at: viewport y (CSS px)"),
  dy: z.number().optional().describe("scroll: pixels to scroll the window when no target is given (default 600)"),
  url: z.string().optional().describe("goto: the URL; wait_for: substring the URL must contain"),
  ms: z.number().int().positive().max(10_000).optional().describe("wait: how long to sleep; wait_for: networkIdleMs"),
  timeoutMs: z.number().int().positive().max(60_000).optional().describe("wait_for: give up after (default 10000)"),
});
type Step = z.infer<typeof stepSchema>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveStepTarget(page: Page, s: Step, tool: string): Promise<ElementHandle<Element>> {
  if (s.text && !s.ref && !s.selector) {
    // "the element whose text says X" — the same matcher page_find uses, first match wins.
    const items = await page.evaluate(collectSnapshot, { selector: INTERACTIVE_SELECTOR, text: s.text, role: null, deepest: false });
    const first = items[0];
    if (!first) throw new Error(`${tool}: no interactive element with text containing "${s.text}"`);
    return resolveTarget(page, { ref: first.ref }, tool);
  }
  return resolveTarget(page, { ref: s.ref, selector: s.selector }, tool);
}

function parseKeyCombo(keys: string): { modifiers: string[]; key: string } {
  const parts = keys.split("+");
  return { modifiers: parts.slice(0, -1), key: parts[parts.length - 1]! };
}

async function runStep(mgr: SessionManager, sessionId: string | undefined, recorder: Recorder, page: Page, s: Step, i: number): Promise<string> {
  const tool = `page_batch #${i + 1} ${s.action}`;
  const targetDesc = s.ref ? `ref "${s.ref}"` : s.selector ? `selector "${s.selector}"` : s.text ? `text "${s.text}"` : "";
  switch (s.action) {
    case "click": {
      const el = await resolveStepTarget(page, s, tool);
      await el.click();
      return `clicked ${targetDesc}`;
    }
    case "type": {
      if (s.value === undefined) throw new Error(`${tool}: needs value`);
      const el = await resolveStepTarget(page, s, tool);
      await el.type(s.value);
      return `typed ${s.value.length} chars into ${targetDesc}`;
    }
    case "fill": {
      if (s.value === undefined) throw new Error(`${tool}: needs value`);
      const el = await resolveStepTarget(page, s, tool);
      await el.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      await el.type(s.value);
      return `filled ${targetDesc}`;
    }
    case "select": {
      if (s.value === undefined) throw new Error(`${tool}: needs value`);
      const el = await resolveStepTarget(page, s, tool);
      await (el as ElementHandle<HTMLSelectElement>).select(s.value);
      return `selected "${s.value}" in ${targetDesc}`;
    }
    case "key": {
      if (!s.keys) throw new Error(`${tool}: needs keys`);
      const { modifiers, key } = parseKeyCombo(s.keys);
      try {
        for (const m of modifiers) await page.keyboard.down(m as Parameters<typeof page.keyboard.down>[0]);
        await page.keyboard.press(key as Parameters<typeof page.keyboard.press>[0]);
      } finally {
        for (const m of [...modifiers].reverse()) await page.keyboard.up(m as Parameters<typeof page.keyboard.up>[0]);
      }
      return `pressed ${s.keys}`;
    }
    case "hover": {
      const el = await resolveStepTarget(page, s, tool);
      await el.hover();
      return `hovered ${targetDesc}`;
    }
    case "scroll": {
      if (s.ref || s.selector || s.text) {
        const el = await resolveStepTarget(page, s, tool);
        await el.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }));
        return `scrolled ${targetDesc} into view`;
      }
      const amount = s.dy ?? 600;
      await page.evaluate((y) => window.scrollBy(0, y), amount);
      return `scrolled by ${amount}px`;
    }
    case "click_at": {
      if (s.x === undefined || s.y === undefined) throw new Error(`${tool}: needs x and y`);
      const { w, h } = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      if (s.x < 0 || s.y < 0 || s.x > w || s.y > h) throw new Error(`${tool}: (${s.x}, ${s.y}) is outside the ${w}×${h} viewport`);
      await page.mouse.click(s.x, s.y);
      return `clicked at (${s.x}, ${s.y})`;
    }
    case "goto": {
      if (!s.url) throw new Error(`${tool}: needs url`);
      await mgr.goto(s.url, sessionId);
      return `went to ${s.url}`;
    }
    case "wait": {
      await sleep(s.ms ?? 500);
      return `waited ${s.ms ?? 500}ms`;
    }
    case "wait_for": {
      return await waitFor(recorder, page, { selector: s.selector, text: s.text, url: s.url, networkIdleMs: s.ms }, s.timeoutMs ?? 10_000);
    }
  }
}

/** Registers page_batch — many actions in ONE round-trip. The single biggest lever against
 *  "click → wait → look → click" latency: each step settles briefly (quiet detection), the whole
 *  sequence reports one combined network/console/url delta, and `look:true` appends a page_look
 *  so the model sees the result and its next click targets in the same reply. */
export function registerBatchTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_batch",
    {
      description:
        "Run a SEQUENCE of actions in one call (click / type / fill / select / key / hover / scroll / click_at / goto / " +
        "wait / wait_for), settling briefly between steps, and report ONE combined network/console/url delta at the end — " +
        "far faster than one tool call per step. Target steps by selector, by text (\"the button that says Login\"), or " +
        "by ref (refs are only valid until the DOM changes, so prefer selector/text inside a batch). Stops at the first " +
        "failing step unless stopOnError:false. Set look:true to get a page_look (badged 1:1 screenshot + legend) of the " +
        "final state in the same reply, so you can pick the next target immediately.",
      inputSchema: {
        sessionId: z.string().optional(),
        steps: z.array(stepSchema).min(1).max(MAX_STEPS),
        stopOnError: z.boolean().optional().describe("stop at the first failing step (default true)"),
        stepSettleMs: z.number().int().nonnegative().max(5000).optional().describe(`quiet-wait cap between steps (default ${DEFAULT_STEP_SETTLE_MS}ms)`),
        waitMs: z.number().int().nonnegative().optional().describe("final settle cap before reporting the delta (default 700ms)"),
        look: z.boolean().optional().describe("append a page_look of the final state (badged screenshot + legend)"),
        lookLimit: z.number().int().positive().optional().describe("max badges for the final look (default 80)"),
      },
    },
    async ({ sessionId, steps, stopOnError, stepSettleMs, waitMs, look, lookLimit }): Promise<CallToolResult> => {
      try {
        const notes: string[] = [];
        let failedAt = -1;
        const delta = await withDelta(mgr, sessionId, waitMs, async (recorder, page) => {
          for (let i = 0; i < steps.length; i++) {
            const s = steps[i]!;
            const stepMark = recorder.seqNow();
            try {
              const done = await runStep(mgr, sessionId, recorder, page, s, i);
              notes.push(`#${i + 1} ${s.action} ✓ ${done}`);
            } catch (err) {
              notes.push(`#${i + 1} ${s.action} ✗ ${err instanceof Error ? err.message : String(err)}`);
              if (stopOnError !== false) {
                failedAt = i;
                notes.push(`stopped after step ${i + 1} (${steps.length - i - 1} not run)`);
                break;
              }
            }
            if (i < steps.length - 1) await settle(recorder, stepMark, stepSettleMs ?? DEFAULT_STEP_SETTLE_MS);
          }
          return { note: notes.join("\n") };
        });
        const content: CallToolResult["content"] = [{ type: "text", text: delta }];
        if (look) {
          const page = mgr.pageFor(sessionId);
          const { text, image } = await mgr.withPageLock(sessionId, () => captureLook(page, { limit: lookLimit }));
          content.push({ type: "text", text: `\n--- look ---\n${text}` }, { type: "image", data: image.data, mimeType: "image/png" });
        }
        return failedAt >= 0 ? { content, isError: true } : { content };
      } catch (err) {
        return fail(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
