import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import puppeteer, { type Browser, type BrowserContext, type Page, type Target } from "puppeteer-core";
import { SessionRegistry } from "./registry";
import { resolveChromePath } from "./chrome-path";
import { Recorder } from "../recorder/recorder";
import { Interceptor } from "../recorder/intercept";
import type { LaunchOptions, Session, SessionId, SessionInfo } from "../types";

/** Prefix of the ephemeral user-data dirs we create under $TMPDIR. */
const TEMP_PREFIX = "bfa-";

/** Apply an optional launch-time viewport. No-op when not requested (keeps puppeteer's
 *  800x600 default). isMobile/hasTouch default to false so plain mouse clicks
 *  (page.mouse.click / page_click_at) drive canvas games that listen for mouse input;
 *  set hasTouch:true only for games that require touch. */
async function applyViewport(page: Page, opts: LaunchOptions): Promise<void> {
  // No explicit viewport → do nothing: with defaultViewport:null (see launch/connect) puppeteer
  // sets no device-metrics override, so the page tracks the real window. (A stale override left by
  // a DIFFERENT still-connected CDP client can't be cleared from here — it is per-session and only
  // clears when that client disconnects; that's why a leftover old session keeps a page clamped.)
  if (!opts.viewport) return;
  await page.setViewport({
    width: opts.viewport.width,
    height: opts.viewport.height,
    deviceScaleFactor: opts.viewport.deviceScaleFactor ?? 1,
    isMobile: opts.viewport.mobile ?? false,
    hasTouch: opts.viewport.hasTouch ?? false,
  });
}

/** How long one CDP round-trip may take before puppeteer gives up. Its default is 180 s — with a
 *  renderer pinned by a script that means EVERY page-level tool blocks for three minutes. */
const PROTOCOL_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Await `p` for at most `ms`; on timeout (or rejection) resolve to `fallback` instead of hanging.
 *  For best-effort teardown/probe steps only — it never throws. */
async function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.catch(() => fallback),
      new Promise<T>((r) => {
        t = setTimeout(() => r(fallback), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Native dialogs must never be left open — puppeteer blocks on them and every later tool call
 *  hangs. But the TYPE matters: dismiss() on a beforeunload prompt means "Stay on page", which
 *  silently cancels the human's own Cmd+W / Cmd+Q / close click and any reload, leaving Chrome
 *  closable only by force-quit (a real field report). So: ACCEPT beforeunload (= leave), DISMISS
 *  everything else (never confirms a destructive confirm()). */
function installDialogGuard(page: Page): void {
  page.on("dialog", (d) => {
    (d.type() === "beforeunload" ? d.accept() : d.dismiss()).catch(() => {});
  });
}

/** Undo emulation a session may have left on the page (net_throttle offline / 3G / CPU). */
async function resetEmulation(page: Page): Promise<void> {
  await Promise.allSettled([page.setOfflineMode(false), page.emulateNetworkConditions(null), page.emulateCPUThrottling(null)]);
}

/** Puppeteer's default launch args include `--use-mock-keychain` (macOS) and `--password-store=basic`,
 *  which make Chrome unable to decrypt cookies encrypted with the REAL OS keystore. On a PERSISTENT
 *  (named) profile — which may hold logins written by your real Chrome — Chrome reacts by discarding
 *  the entire cookie jar, silently logging you out. Drop those two defaults for named profiles so
 *  real-keystore cookies survive across launches. Ephemeral (unnamed) profiles keep the defaults:
 *  nothing to preserve there, and it avoids an OS keychain prompt. Exported for unit testing. */
export function keychainOverrides(profileName: string | undefined): { ignoreDefaultArgs?: string[] } {
  if (!profileName) return {};
  return { ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"] };
}

export class SessionManager {
  private registry = new SessionRegistry();
  private flowMarks = new Map<SessionId, number>();
  private interceptors = new Map<SessionId, Interceptor>();
  private emulation = new Map<SessionId, string>();
  private locks = new Map<SessionId, Promise<void>>();

  async launch(opts: LaunchOptions): Promise<SessionInfo> {
    if (opts.mode === "attach") return this.attach(opts);
    return this.launchFresh(opts);
  }

  private async launchFresh(opts: LaunchOptions): Promise<SessionInfo> {
    // Normalize once: empty/whitespace-only profile names are treated as "no profile"
    // so they cleanly route to the ephemeral branch below, not silently pass through.
    const profileName = opts.profile?.trim() || undefined;
    // Named profile → persistent, reusable dir (concurrent sessions on the SAME named
    // profile are expected to collide — that's Chrome's real SingletonLock constraint).
    // No profile → unique ephemeral dir, so concurrent default fresh sessions (e.g. "open
    // prod + incognito at once") never collide and leave no persisted state behind.
    const tempDir = profileName ? undefined : mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    const userDataDir = profileName ? join(homedir(), ".bfa", "profiles", profileName) : tempDir!;
    // Everything from the launch onward is guarded: until registry.add() runs, `browser` and
    // `tempDir` are local-only, so an exception here (most likely page.goto on an unreachable
    // URL) would orphan a live Chrome process AND leak its profile dir for the life of the
    // server. Puppeteer will not clean a userDataDir it did not create, so we must.
    let browser: Browser | undefined;
    try {
      browser = await puppeteer.launch({
        executablePath: resolveChromePath(),
        headless: opts.headless ?? false,
        userDataDir,
        // null = don't force a device-metrics override; the page fills the real window instead of
        // puppeteer's 800x600 default (which otherwise renders the site in a small top-left box).
        // An explicit opts.viewport still overrides this via applyViewport below.
        defaultViewport: null,
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
        // Named profiles keep the real OS keystore so existing logins/cookies aren't wiped on launch.
        ...keychainOverrides(profileName),
        args: ["--no-first-run", "--no-default-browser-check"],
        // This app owns teardown (see server.ts). @puppeteer/browsers' own SIGINT handler
        // calls process.exit(130) synchronously, which would pre-empt our async cleanup and
        // strand every temp dir on Ctrl-C.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      const context: BrowserContext = opts.incognito
        ? await browser.createBrowserContext()
        : browser.defaultBrowserContext();
      const page: Page = await context.newPage();
      await applyViewport(page, opts);
      installDialogGuard(page);
      // We own this browser: guard dialogs in popups / new tabs the page opens as well, so an
      // alert() in a popup can't wedge a later tool call for the whole protocol timeout.
      const onTarget = (t: Target): void => {
        t.page()
          .then((p) => {
            if (p) installDialogGuard(p);
          })
          .catch(() => {});
      };
      const owned: Browser = browser;
      owned.on("targetcreated", onTarget);
      const cleanup = (): void => {
        try {
          owned.off("targetcreated", onTarget);
        } catch {
          // browser already gone
        }
      };
      // Start the recorder BEFORE navigating: the fixture's inline <script> fires console/fetch
      // calls synchronously as the page loads, so a recorder started after goto() would miss them.
      const recorder = new Recorder(page);
      await recorder.start();
      if (opts.url) await page.goto(opts.url, { waitUntil: "load" });
      const session = this.registry.add({
        mode: "fresh",
        incognito: opts.incognito ?? false,
        browser,
        context,
        page,
        recorder,
        ownsBrowser: true,
        tempDir,
        cleanup,
      });
      return await this.toInfo(session);
    } catch (err) {
      try {
        await browser?.close();
      } catch {
        // best-effort cleanup; the original error is what the caller needs
      }
      if (tempDir) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup; the original error is what the caller needs
        }
      }
      throw err; // guard() surfaces this to the caller as isError
    }
  }

  private async attach(opts: LaunchOptions): Promise<SessionInfo> {
    const port = opts.port ?? 9222;
    let browser: Browser;
    try {
      // defaultViewport:null so the attached page keeps the real Chrome window size — without it
      // puppeteer clamps the layout viewport to 800x600 and the site renders in a small corner.
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${port}`,
        defaultViewport: null,
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
      });
    } catch (err) {
      // The overwhelmingly common failure is "nothing is listening on the debug port". Puppeteer
      // reports it as an opaque "fetch failed"; turn that into the exact fix, since neither the
      // agent nor the human can guess that a normal Chrome has no port (and Chrome 136+ refuses
      // one on the default profile).
      throw new Error(
        `cannot attach: no Chrome debug endpoint on port ${port}. A normally-opened Chrome has no ` +
          `debug port, and Chrome 136+ refuses one on the default profile — so first start a SEPARATE ` +
          `Chrome with its own profile, then retry:\n` +
          `  <repo>/bfa-chrome ${port}   (or: npx -p browser-for-ai bfa-chrome ${port})   # dedicated profile ~/.bfa/attach-profile; log in once\n` +
          `  browser_launch { "mode": "attach", "port": ${port} }\n` +
          `To reuse existing logins, point bfa-chrome at a COPY of your Chrome profile dir ` +
          `(a non-default --user-data-dir). [${err instanceof Error ? err.message : String(err)}]`,
      );
    }
    // Same shape as launchFresh: a failure after connect() (e.g. goto on a bad URL) would
    // otherwise leak the CDP connection, since nothing holds a reference to `browser` yet.
    // We only disconnect — never close — because we do not own this browser.
    try {
      const context = browser.defaultBrowserContext();
      const pages = await browser.pages();
      const page: Page = pages[0] ?? (await context.newPage());
      await applyViewport(page, opts);
      // Only the page we drive gets the guard in attach mode: this is the user's real Chrome, and
      // auto-answering dialogs in tabs we don't control would be hijacking their browsing.
      installDialogGuard(page);
      const recorder = new Recorder(page);
      await recorder.start();
      if (opts.url) await page.goto(opts.url, { waitUntil: "load" });
      const session = this.registry.add({
        mode: "attach",
        incognito: false,
        browser,
        context,
        page,
        recorder,
        ownsBrowser: false,
      });
      return await this.toInfo(session);
    } catch (err) {
      try {
        await browser.disconnect();
      } catch {
        // best-effort cleanup; the original error is what the caller needs
      }
      throw err;
    }
  }

  sessions(): SessionInfo[] {
    const activeId = this.registry.activeId();
    return this.registry.list().map((s) => ({
      sessionId: s.id,
      mode: s.mode,
      incognito: s.incognito,
      url: safeUrl(s.page),
      title: null,
      active: s.id === activeId,
    }));
  }

  use(id: SessionId): boolean {
    return this.registry.setActive(id);
  }

  has(id: SessionId): boolean {
    return this.registry.has(id);
  }

  /** Ephemeral profile dirs of live sessions — used by the process-exit sweep in server.ts. */
  tempDirs(): string[] {
    return this.registry
      .list()
      .map((s) => s.tempDir)
      .filter((d): d is string => d !== undefined);
  }

  async tabs(id?: SessionId): Promise<{ index: number; url: string; title: string; active: boolean }[]> {
    const s = this.require(id);
    // Owned sessions report only their own context's pages: browser.pages() spans ALL contexts,
    // so an incognito session would list the default context's about:blank too, undercutting the
    // isolation incognito exists to provide. Attach sessions deliberately keep browser-wide
    // scope — listing the user's real tabs is the point of attaching.
    const pages = s.mode === "attach" ? await s.browser.pages() : await s.context.pages();
    const out: { index: number; url: string; title: string; active: boolean }[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]!;
      out.push({ index: i, url: p.url(), title: await bounded(p.title(), 2000, ""), active: p === s.page });
    }
    return out;
  }

  recorderFor(id?: SessionId): Recorder {
    return this.require(id).recorder;
  }

  /** Record a flow-start mark (a recorder seq) for a session. flow_export/flow_synthesize
   *  default their capture window to calls after this mark. Keyed by the session's resolved
   *  id (not the raw `id` argument), so an implicit "active session" mark and lookup always
   *  agree even as the active session changes. */
  setFlowMark(id: SessionId | undefined, seq: number): SessionId {
    const s = this.require(id);
    this.flowMarks.set(s.id, seq);
    return s.id;
  }

  getFlowMark(id?: SessionId): number | undefined {
    const s = this.require(id);
    return this.flowMarks.get(s.id);
  }

  modeOf(id?: SessionId): "fresh" | "attach" {
    return this.require(id).mode;
  }

  /** Emulation currently applied by net_throttle, surfaced by page_state — it silently persists
   *  across navigations and reloads, so the agent should see it rather than guess why a page crawls. */
  setEmulationNote(id: SessionId | undefined, note: string | null): void {
    const s = this.require(id);
    if (note) this.emulation.set(s.id, note);
    else this.emulation.delete(s.id);
  }

  getEmulationNote(id?: SessionId): string | null {
    return this.emulation.get(this.require(id).id) ?? null;
  }

  /** Serialize page-mutating captures (page_look's overlay, page_screenshot) per session, so two
   *  overlapping calls can't remove each other's overlay or re-number refs mid-capture. */
  async withPageLock<T>(id: SessionId | undefined, fn: () => Promise<T>): Promise<T> {
    const s = this.require(id);
    const prev = this.locks.get(s.id) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(s.id, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Owned Chrome child processes still registered — server.ts's last-resort exit hook kills these. */
  ownedProcesses(): ChildProcess[] {
    const out: ChildProcess[] = [];
    for (const s of this.registry.list()) {
      const p = s.ownsBrowser ? s.browser.process() : null;
      if (p) out.push(p);
    }
    return out;
  }

  pageFor(id?: SessionId): Page {
    return this.require(id).page;
  }

  /** Lazily creates and caches an Interceptor per session, keyed by the resolved id (same
   *  pattern as setFlowMark/getFlowMark) so an implicit "active session" call always reaches
   *  the same instance regardless of how the active session shifts afterward. */
  interceptorFor(id?: SessionId): Interceptor {
    const s = this.require(id);
    let interceptor = this.interceptors.get(s.id);
    if (!interceptor) {
      interceptor = new Interceptor(s.page, s.recorder);
      this.interceptors.set(s.id, interceptor);
    }
    return interceptor;
  }

  /** Resolved id of the session a call targets (the active one when `id` is omitted). */
  resolveSessionId(id?: SessionId): SessionId {
    return this.require(id).id;
  }

  sessionCount(): number {
    return this.registry.list().length;
  }

  async goto(url: string, id?: SessionId): Promise<SessionInfo> {
    const s = this.require(id);
    // A navigation is an action: net_wait / page_wait_for measure "since your last action" from here.
    s.recorder.lastActionMark = s.recorder.seqNow();
    await s.page.goto(url, { waitUntil: "load" });
    return this.toInfo(s);
  }

  async state(
    id?: SessionId,
  ): Promise<SessionInfo & { readyState: string; viewport: { width: number; height: number } | null }> {
    const s = this.require(id);
    const info = await this.toInfo(s);
    const readyState = await bounded(s.page.evaluate(() => document.readyState), 3000, "unknown");
    return { ...info, readyState, viewport: s.page.viewport() };
  }

  async close(id?: SessionId, all = false): Promise<SessionId[]> {
    const targets = all ? this.registry.removeAll() : compact(this.removeOne(this.resolveId(id)));
    await this.disposeAll(targets);
    return targets.map((s) => s.id);
  }

  async shutdown(): Promise<void> {
    await this.disposeAll(this.registry.removeAll());
  }

  /** Tear sessions down in PARALLEL under ONE budget — `browser_close {all:true}` with three pinned
   *  tabs must take ~12 s, not 3 × 12 s. Anything owned that outlives the budget is SIGKILLed;
   *  attached browsers are never killed (we only ever disconnect from them). */
  private async disposeAll(sessions: Session[]): Promise<void> {
    if (sessions.length === 0) return;
    await bounded(Promise.allSettled(sessions.map((s) => this.disposeSession(s))).then(() => undefined), 12_000, undefined);
    for (const s of sessions) {
      if (!s.ownsBrowser) continue;
      try {
        s.browser.process()?.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  private async disposeSession(s: Session): Promise<void> {
    // Every step is BOUNDED and independently guarded: a hung renderer or an open modal must
    // never turn "close" into a 3-minute stall — or a Chrome the human has to force-quit.
    try {
      s.cleanup?.();
    } catch {
      // best-effort
    }
    this.flowMarks.delete(s.id);
    this.emulation.delete(s.id);
    this.locks.delete(s.id);
    // Free a renderer pinned by a runaway script so the close below isn't queued behind it, and
    // undo any throttling/offline emulation so an attached (user-owned) tab is left as we found it.
    await bounded(s.recorder.terminateExecution(), 1500, undefined);
    await bounded(resetEmulation(s.page), 2000, undefined);
    // Don't await CDPSession.detach() here: on a wedged renderer each detach can stall for the
    // whole protocol timeout, and the browser close/disconnect below tears every session down anyway.
    s.recorder.abandon();
    const interceptor = this.interceptors.get(s.id);
    this.interceptors.delete(s.id);
    interceptor?.abandon();
    if (s.incognito && s.ownsBrowser) await bounded(s.context.close(), 3000, undefined);
    if (s.ownsBrowser) {
      const closed = await bounded(s.browser.close().then(() => true), 6000, false);
      if (!closed) {
        // Chrome did not go away on request (hung renderer, modal, beforeunload…). We launched
        // it, so it is ours to kill — this also releases the profile's SingletonLock.
        try {
          s.browser.process()?.kill("SIGKILL");
        } catch {
          // already gone
        }
        await sleep(200);
      }
    } else {
      await bounded(Promise.resolve(s.browser.disconnect()), 3000, undefined);
    }
    if (s.tempDir) {
      try {
        rmSync(s.tempDir, { recursive: true, force: true });
      } catch {
        // best-effort teardown; never throw during close
      }
    }
  }

  private async toInfo(s: Session): Promise<SessionInfo> {
    let title: string | null = null;
    title = await bounded(s.page.title(), 3000, null);
    return {
      sessionId: s.id,
      mode: s.mode,
      incognito: s.incognito,
      url: safeUrl(s.page),
      title,
      active: s.id === this.registry.activeId(),
    };
  }

  private require(id?: SessionId): Session {
    const s = this.registry.get(id);
    if (!s) {
      throw new Error(
        id ? `No session "${id}". Call browser_sessions to list open sessions.` : "No active session. Call browser_launch first.",
      );
    }
    return s;
  }

  /** Explicit id, else the active session's id, else undefined (nothing open). */
  private resolveId(id?: SessionId): SessionId | undefined {
    return id ?? this.registry.activeId();
  }

  private removeOne(id: SessionId | undefined): Session | undefined {
    return id === undefined ? undefined : this.registry.remove(id);
  }
}

/**
 * Remove leftover `$TMPDIR/bfa-*` profile dirs from earlier runs. In-process cleanup can always
 * be defeated (SIGKILL, power loss), so the server sweeps at startup too. A dir whose Chrome is
 * still running is skipped — Chrome keeps a `SingletonLock` symlink pointing at `<host>-<pid>`
 * while a profile is open, so a concurrently running bfa server never loses its live profiles.
 * Returns the dirs actually removed.
 */
export function sweepStaleTempDirs(dir: string = tmpdir()): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isDirectory()) continue;
      if (profileInUse(full)) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      // best-effort sweep; a dir we cannot stat or remove is simply left alone
    }
  }
  return removed;
}

/** True if a Chrome process still holds this profile (SingletonLock → "<host>-<pid>"). */
function profileInUse(profileDir: string): boolean {
  let target: string;
  try {
    target = readlinkSync(join(profileDir, "SingletonLock"));
  } catch {
    return false; // no lock (or not a symlink) → Chrome is not holding it
  }
  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  if (!Number.isInteger(pid) || pid <= 0) return true; // unparseable lock → assume in use
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (stale lock); EPERM = alive but owned by someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safeUrl(page: Page): string | null {
  try {
    return page.url();
  } catch {
    return null;
  }
}

function compact<T>(v: T | undefined): T[] {
  return v === undefined ? [] : [v];
}
