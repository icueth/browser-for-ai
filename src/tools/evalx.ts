import type { Page } from "puppeteer-core";
import type { Recorder } from "../recorder/recorder";

export const DEFAULT_EVAL_TIMEOUT_MS = 15_000;
export const MAX_EVAL_TIMEOUT_MS = 60_000;

class BusyTimeout extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Evaluate `expression` in the page with a hard time budget — the difference between a tool that
 * returns and one that wedges the agent for the protocol timeout while the tab stays frozen.
 *
 * Two distinct failure shapes, handled differently:
 *  • the expression pins the JS thread (a synchronous busy loop): the evaluate can't even be
 *    delivered, so on timeout we send Runtime.terminateExecution over the Recorder's
 *    pre-attached CDP session (a session created during the hang never gets through) — verified
 *    to free the renderer in ~1 ms — and report that the script was terminated;
 *  • the expression awaits a promise that never settles (fetch to a dead endpoint, a stalled
 *    WebSocket): the renderer is healthy, nothing is executing, so terminate is a no-op; we stop
 *    waiting and say so.
 * MCP cancellation (the user pressing Esc) also terminates a running script instead of leaving it
 * spinning for the next call to trip over. The expression itself still goes through
 * page.evaluate(string) at the CDP level, so page CSP (no 'unsafe-eval') never blocks it.
 */
export async function boundedEval(
  recorder: Recorder,
  page: Page,
  expression: string,
  timeoutMs = DEFAULT_EVAL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<unknown> {
  const inPage = page.evaluate(expression);
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new BusyTimeout()), timeoutMs);
  });
  const onAbort = (): void => {
    recorder.terminateExecution().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([inPage, budget]);
  } catch (err) {
    if (err instanceof BusyTimeout) {
      // Try to free the renderer; if the pending evaluate then rejects quickly, it was pinned.
      await recorder.terminateExecution();
      const settled = await Promise.race([inPage.then(() => "ok", () => "rejected"), sleep(1500).then(() => "pending")]);
      if (settled === "rejected") {
        throw new Error(
          `page_eval: expression ran longer than ${timeoutMs}ms and pinned the page's JS thread — it was terminated ` +
            `(Runtime.terminateExecution) and the page is responsive again`,
        );
      }
      throw new Error(
        `page_eval: timed out after ${timeoutMs}ms waiting for the expression to settle (the page stayed responsive — ` +
          `the value never resolved, e.g. a request that never answers). Raise timeoutMs or await something bounded.`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/Internal error/i.test(msg)) {
      throw new Error("page_eval: the script was terminated (a timeout or browser_recover freed the page)");
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
