import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
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

export class SessionManager {
  private registry = new SessionRegistry();
  private flowMarks = new Map<SessionId, number>();
  private interceptors = new Map<SessionId, Interceptor>();

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
      // Auto-dismiss native dialogs (confirm()/alert()/beforeunload). Without this, puppeteer
      // blocks on any open dialog and every subsequent tool call hangs — dismiss (not accept)
      // is the safe default since it never confirms a destructive action. Best-effort: the
      // dialog is already gone by the time dismiss() would reject, so a failure here is inert.
      page.on("dialog", (d) => {
        d.dismiss().catch(() => {});
      });
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
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    } catch (err) {
      // The overwhelmingly common failure is "nothing is listening on the debug port". Puppeteer
      // reports it as an opaque "fetch failed"; turn that into the exact fix, since neither the
      // agent nor the human can guess that a normal Chrome has no port (and Chrome 136+ refuses
      // one on the default profile).
      throw new Error(
        `cannot attach: no Chrome debug endpoint on port ${port}. A normally-opened Chrome has no ` +
          `debug port, and Chrome 136+ refuses one on the default profile — so first start a SEPARATE ` +
          `Chrome with its own profile, then retry:\n` +
          `  <repo>/bin/bfa-chrome ${port}     # dedicated profile ~/.bfa/attach-profile; log in once\n` +
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
      // Same reasoning as launchFresh: an attached page can still open a native dialog and
      // stall every subsequent tool call if nothing auto-resolves it.
      page.on("dialog", (d) => {
        d.dismiss().catch(() => {});
      });
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
      out.push({ index: i, url: p.url(), title: await p.title(), active: p === s.page });
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

  async goto(url: string, id?: SessionId): Promise<SessionInfo> {
    const s = this.require(id);
    await s.page.goto(url, { waitUntil: "load" });
    return this.toInfo(s);
  }

  async state(
    id?: SessionId,
  ): Promise<SessionInfo & { readyState: string; viewport: { width: number; height: number } | null }> {
    const s = this.require(id);
    const info = await this.toInfo(s);
    const readyState = await s.page.evaluate(() => document.readyState);
    return { ...info, readyState, viewport: s.page.viewport() };
  }

  async close(id?: SessionId, all = false): Promise<SessionId[]> {
    const targets = all ? this.registry.removeAll() : compact(this.removeOne(this.resolveId(id)));
    for (const s of targets) await this.disposeSession(s);
    return targets.map((s) => s.id);
  }

  async shutdown(): Promise<void> {
    for (const s of this.registry.removeAll()) await this.disposeSession(s);
  }

  private async disposeSession(s: Session): Promise<void> {
    // Each teardown step is independently guarded so a failure in one (e.g. context.close()
    // throwing) never skips the next (e.g. browser.close()) — otherwise a live Chrome process
    // can be stranded, and a later rmSync on its still-held userDataDir can EBUSY.
    try {
      await s.recorder.stop();
    } catch {
      // best-effort teardown; never throw during close
    }
    this.flowMarks.delete(s.id);
    const interceptor = this.interceptors.get(s.id);
    this.interceptors.delete(s.id);
    if (interceptor) {
      try {
        await interceptor.disable();
      } catch {
        // best-effort teardown; never throw during close
      }
    }
    if (s.incognito && s.ownsBrowser) {
      try {
        await s.context.close();
      } catch {
        // best-effort teardown; never throw during close
      }
    }
    try {
      if (s.ownsBrowser) await s.browser.close();
      else await s.browser.disconnect();
    } catch {
      // best-effort teardown; never throw during close
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
    try {
      title = await s.page.title();
    } catch {
      title = null;
    }
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
