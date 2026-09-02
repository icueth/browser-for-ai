import { z } from "zod";
import type { Page } from "puppeteer-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import type { Recorder } from "../recorder/recorder";
import { ok } from "../format/compact";
import { guard } from "./guard";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const POLL_MS = 100;
// A request still in flight blocks "network idle" only while it is younger than this: anything older
// is treated as a long-lived stream (long-poll, SSE, a hung call) rather than a response worth waiting for.
const INFLIGHT_MAX_AGE_MS = 5_000;

export interface WaitCondition {
  selector?: string;
  text?: string;
  url?: string;
  networkIdleMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function describeCondition(c: WaitCondition): string {
  const parts = [
    c.selector ? `selector "${c.selector}"` : null,
    c.text ? `text "${c.text}"` : null,
    c.url ? `url containing "${c.url}"` : null,
    c.networkIdleMs ? `network idle ${c.networkIdleMs}ms` : null,
  ].filter((p): p is string => p !== null);
  return parts.join(" | ");
}

/** True while a request started since the last action is still awaiting its response (and is young
 *  enough to plausibly get one). seqNow() only moves when requests START, so without this a form
 *  submit would read as "idle" the instant it was sent, before its response landed. */
function recentInFlight(recorder: Recorder, now: number): boolean {
  return recorder.network.sinceSeq(recorder.lastActionMark).some((e) => {
    if (e.finished || e.failed) return false;
    const age = e.wallStart !== undefined ? now - e.wallStart * 1000 : 0;
    return age < INFLIGHT_MAX_AGE_MS;
  });
}

/** Poll until ANY of the conditions holds; resolves to a one-line description of what matched
 *  (with elapsed ms), rejects on timeout. Shared by page_wait_for and page_batch's wait_for step. */
export async function waitFor(recorder: Recorder, page: Page, c: WaitCondition, timeoutMs: number): Promise<string> {
  if (!c.selector && !c.text && !c.url && !c.networkIdleMs) {
    throw new Error("wait_for needs at least one of selector / text / url / networkIdleMs");
  }
  const start = Date.now();
  const deadline = start + timeoutMs;
  let lastSeq = recorder.seqNow();
  let lastChange = start;
  for (;;) {
    const now = Date.now();
    if (c.url && page.url().includes(c.url)) return `url matched "${c.url}" after ${now - start}ms`;
    if (c.selector) {
      let el: Awaited<ReturnType<Page["$"]>> = null;
      try {
        el = await page.$(c.selector);
      } catch (err) {
        // A malformed selector fails identically on every poll — surface it now instead of after a full timeout.
        // (Anything else — e.g. the execution context being torn down by a navigation — is "not there yet".)
        if (/not a valid selector|SyntaxError/i.test(String(err))) throw new Error(`wait_for: "${c.selector}" is not a valid CSS selector`);
      }
      if (el) {
        await el.dispose().catch(() => {});
        return `selector "${c.selector}" appeared after ${now - start}ms`;
      }
    }
    if (c.text) {
      const t = c.text;
      // innerText = rendered text only: an inline <script> JSON payload that merely CONTAINS the words
      // must not count as "appeared" (textContent would).
      const hit = await page.evaluate((needle) => (document.body?.innerText ?? "").includes(needle), t).catch(() => false);
      if (hit) return `text "${c.text}" appeared after ${now - start}ms`;
    }
    if (c.networkIdleMs) {
      const seq = recorder.seqNow();
      if (seq !== lastSeq) {
        lastSeq = seq;
        lastChange = now;
      }
      if (now - lastChange >= c.networkIdleMs && !recentInFlight(recorder, now)) {
        return `network idle for ${c.networkIdleMs}ms (after ${now - start}ms)`;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`wait_for: none of [${describeCondition(c)}] within ${timeoutMs}ms`);
    await sleep(Math.min(POLL_MS, remaining));
  }
}

export function registerWaitForTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "page_wait_for",
    {
      description:
        "Wait until the page reaches a condition instead of sleeping: a CSS selector appears, some text appears, " +
        "the URL contains a string, or the network has been idle for N ms. Any one condition satisfies it (they OR " +
        "together). Returns as soon as it holds — use this (or net_wait) rather than fixed waits.",
      inputSchema: {
        sessionId: z.string().optional(),
        selector: z.string().optional().describe("wait until this CSS selector matches an element"),
        text: z.string().optional().describe("wait until this text appears anywhere in the page"),
        url: z.string().optional().describe("wait until the page URL contains this substring"),
        networkIdleMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "wait until no new requests/console output for this many ms AND nothing started since your last action is still awaiting a response (requests older than 5 s — long-polls, streams, hung calls — do not block)",
          ),
        timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe(`give up after this many ms (default ${DEFAULT_TIMEOUT_MS})`),
      },
    },
    async ({ sessionId, selector, text, url, networkIdleMs, timeoutMs }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const page = mgr.pageFor(sessionId);
        const what = await waitFor(recorder, page, { selector, text, url, networkIdleMs }, timeoutMs ?? DEFAULT_TIMEOUT_MS);
        return ok(what);
      }),
  );
}
