import type { Page } from "puppeteer-core";
import type { SessionManager } from "../session/manager";
import type { Recorder } from "../recorder/recorder";
import { netTable } from "../format/net";
import { consoleLines } from "./console";
import { truncate } from "../format/compact";

const DEFAULT_WAIT_MS = 700;
export const DELTA_ROW_CAP = 50;

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
 *  network/console/url delta it caused. Every Phase 2 interaction tool routes through
 *  this so actions report their side-effects without extra tool calls. `run` may return
 *  an optional `note` (e.g. an eval result) appended to the delta header. */
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

  const wait = waitMs ?? DEFAULT_WAIT_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

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
