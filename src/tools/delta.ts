import type { Page } from "puppeteer-core";
import type { SessionManager } from "../session/manager";
import type { Recorder } from "../recorder/recorder";
import { netTable } from "../format/net";
import { consoleLines } from "./console";
import { truncate } from "../format/compact";

const DEFAULT_WAIT_MS = 700;
export const DELTA_ROW_CAP = 50;

const SETTLE_POLL_MS = 40;
const SETTLE_MIN_MS = 120; // always give an action's first effects a moment to be recorded
const SETTLE_QUIET_MS = 250; // no recorder activity for this long (and nothing in flight) = settled

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until the page goes quiet after an action — no new recorder events (requests, socket
 *  frames, console) for SETTLE_QUIET_MS and no request started since `mark` still in flight — or
 *  until `capMs` elapses, whichever comes first. Replaces the old fixed sleep: a click that
 *  triggers nothing returns in ~250 ms instead of 700, while a slow flow still gets its full cap. */
export async function settle(recorder: Recorder, mark: number, capMs: number): Promise<void> {
  if (capMs <= 0) return;
  const start = Date.now();
  let lastSeq = recorder.seqNow();
  let lastChange = start;
  for (;;) {
    await sleep(SETTLE_POLL_MS);
    const now = Date.now();
    const seq = recorder.seqNow();
    if (seq !== lastSeq) {
      lastSeq = seq;
      lastChange = now;
    }
    if (now - start >= capMs) return;
    if (now - start < SETTLE_MIN_MS || now - lastChange < SETTLE_QUIET_MS) continue;
    const inFlight = recorder.network.sinceSeq(mark).some((e) => !e.finished && !e.failed);
    if (!inFlight) return;
  }
}

/** JSON-summarize an eval result; falls back to String() for values JSON can't represent
 *  (undefined, functions, circular refs, BigInt) so a hostile/odd expression never throws here.
 *  Shared by page_observe's eval action and the standalone page_eval tool. */
export function summarizeEvalResult(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return truncate(JSON.stringify(value) ?? String(value), 2000);
  } catch {
    return truncate(String(value), 2000);
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "(unavailable)";
  }
}

/** Runs `run` between a recorder mark and a settle wait, then returns the compact
 *  network/console/url delta it caused. Every interaction tool routes through this so
 *  actions report their side-effects without extra tool calls. `run` may return an optional
 *  `note` (e.g. an eval result) appended to the delta header. `waitMs` is the settle CAP: the
 *  delta is reported as soon as the page is quiet, or when the cap elapses. */
export async function withDelta(
  mgr: SessionManager,
  sessionId: string | undefined,
  waitMs: number | undefined,
  run: (recorder: Recorder, page: Page) => Promise<{ note?: string } | void>,
): Promise<string> {
  const recorder = mgr.recorderFor(sessionId);
  const page = mgr.pageFor(sessionId);
  // Mark with the recorder's own counter — the SAME domain every entry.seq is
  // assigned from — captured strictly before the action dispatches any events.
  // (network.maxSeq() lives in a different, endTs-inflated domain and would drop
  //  the earliest post-action requests.)
  const mark = recorder.seqNow();
  const urlBefore = safeUrl(page);

  const res = await run(recorder, page);

  await settle(recorder, mark, waitMs ?? DEFAULT_WAIT_MS);

  const urlAfter = safeUrl(page);
  const newNet = recorder.network.sinceSeq(mark);
  const newConsole = recorder.console.sinceSeq(mark);
  // Cap rendered rows (keep the newest) so a heavy reload can't blow the token budget.
  const netShown = newNet.slice(-DELTA_ROW_CAP);
  const consoleShown = newConsole.slice(-DELTA_ROW_CAP);

  const lines: string[] = [];
  if (res?.note) lines.push(res.note);
  if (urlBefore !== urlAfter) lines.push(`url: ${urlBefore} → ${urlAfter}`);
  lines.push("");
  lines.push(`network (${newNet.length} new):`);
  lines.push(netShown.length > 0 ? netTable(netShown) : "(none)");
  if (netShown.length < newNet.length) lines.push(`showing last ${netShown.length} of ${newNet.length}`);
  lines.push("");
  lines.push(`console (${newConsole.length} new):`);
  lines.push(consoleShown.length > 0 ? consoleLines(consoleShown) : "(none)");
  if (consoleShown.length < newConsole.length) lines.push(`showing last ${consoleShown.length} of ${newConsole.length}`);

  return lines.join("\n");
}
