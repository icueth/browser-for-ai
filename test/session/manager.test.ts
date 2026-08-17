import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { SessionManager, sweepStaleTempDirs } from "../../src/session/manager";
import { resolveChromePath } from "../../src/session/chrome-path";
import { startFixture, type Fixture } from "../fixtures/server";

let chromeAvailable = false;
try {
  chromeAvailable = existsSync(resolveChromePath());
} catch {
  chromeAvailable = false;
}

describe.skipIf(!chromeAvailable)("SessionManager (integration)", () => {
  let fixture: Fixture;
  let mgr: SessionManager;

  beforeAll(async () => {
    fixture = await startFixture();
    mgr = new SessionManager();
  });

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  });

  it("launches a fresh headless session and reports it", async () => {
    const info = await mgr.launch({ mode: "fresh", headless: true, url: fixture.url });
    expect(info.sessionId).toBe("s1");
    expect(info.mode).toBe("fresh");
    expect(info.url).toContain("127.0.0.1");
    expect(mgr.sessions()).toHaveLength(1);
  });

  it("reads page state including title and readyState", async () => {
    const st = await mgr.state("s1");
    expect(st.title).toBe("BFA Fixture");
    expect(st.readyState).toBe("complete");
  });

  it("supports a second concurrent incognito session and switching active", async () => {
    const info2 = await mgr.launch({ mode: "fresh", headless: true, incognito: true, url: fixture.url });
    expect(info2.sessionId).toBe("s2");
    expect(info2.incognito).toBe(true);
    // both s1 and s2 (two DEFAULT fresh sessions, no profile named) coexist concurrently
    const ids = mgr.sessions().map((s) => s.sessionId);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(mgr.sessions()).toHaveLength(2);
    expect(mgr.use("s1")).toBe(true);
    // state() with no id targets active (s1)
    expect((await mgr.state()).sessionId).toBe("s1");
  });

  it("scopes tabs to the session's own context for owned sessions", async () => {
    // s2 is incognito: its browser also holds the default context's about:blank, which
    // browser.pages() would include. Only the session's own page may be listed.
    const tabs = await mgr.tabs("s2");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.active).toBe(true);
    expect(tabs[0]!.url).toContain("127.0.0.1");
  });

  it("closes one session, leaving the other, and clears its flow mark", async () => {
    mgr.setFlowMark("s1", 42);
    // flowMarks is a private field -- accessed directly here (not through getFlowMark, which
    // gates on the session still existing via require()) so this can assert the cleanup itself,
    // both before and after close, rather than something that would already throw either way.
    const flowMarks = (mgr as unknown as { flowMarks: Map<string, number> }).flowMarks;
    expect(flowMarks.get("s1")).toBe(42);

    const closed = await mgr.close("s1");
    expect(closed).toEqual(["s1"]);
    expect(mgr.sessions()).toHaveLength(1);
    expect(flowMarks.has("s1")).toBe(false);
  });

  it("closes all remaining sessions", async () => {
    const closed = await mgr.close(undefined, true);
    expect(closed).toContain("s2");
    expect(mgr.sessions()).toHaveLength(0);
  });
});

const NAMED_PROFILE = "bfa-selftest-named";

describe.skipIf(!chromeAvailable)("SessionManager ephemeral temp dir (integration)", () => {
  let mgr: SessionManager;

  beforeAll(() => {
    mgr = new SessionManager();
  });

  afterAll(async () => {
    await mgr.shutdown();
    // The named-profile case below persists a real dir by design; don't leave it behind.
    rmSync(join(homedir(), ".bfa", "profiles", NAMED_PROFILE), { recursive: true, force: true });
  });

  it("creates a bfa-* profile dir on default fresh launch and removes it on close", async () => {
    const info = await mgr.launch({ mode: "fresh", headless: true });
    const dirs = mgr.tempDirs();
    expect(dirs).toHaveLength(1);
    const dir = dirs[0]!;
    expect(basename(dir).startsWith("bfa-")).toBe(true);
    expect(existsSync(dir)).toBe(true);

    await mgr.close(info.sessionId);
    expect(existsSync(dir)).toBe(false);
    expect(mgr.tempDirs()).toHaveLength(0);
  });

  it("cleans up the temp dir when the launch itself fails", async () => {
    // Isolate $TMPDIR so this assertion cannot see dirs created by concurrently running test
    // files. os.tmpdir() re-reads the env on every call, so the manager picks this up.
    const isolated = mkdtempSync(join(tmpdir(), "bfa-isolated-"));
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = isolated;
    try {
      // Port 1 is on Chrome's blocked-port list → page.goto rejects with ERR_UNSAFE_PORT,
      // after the browser has launched and the temp profile dir exists.
      await expect(mgr.launch({ mode: "fresh", headless: true, url: "http://127.0.0.1:1/" })).rejects.toThrow();
      // No session was registered, and the orphaned profile dir was removed rather than leaked.
      expect(mgr.sessions()).toHaveLength(0);
      expect(mgr.tempDirs()).toHaveLength(0);
      expect(readdirSync(isolated).filter((n) => n.startsWith("bfa-"))).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("uses no temp dir for a named profile", async () => {
    const info = await mgr.launch({ mode: "fresh", headless: true, profile: NAMED_PROFILE });
    expect(mgr.tempDirs()).toHaveLength(0);
    expect(existsSync(join(homedir(), ".bfa", "profiles", NAMED_PROFILE))).toBe(true);
    await mgr.close(info.sessionId);
    // Named profiles persist across sessions — that is the point of naming one.
    expect(existsSync(join(homedir(), ".bfa", "profiles", NAMED_PROFILE))).toBe(true);
  });
});

describe.skipIf(!chromeAvailable)("SessionManager attach mode (integration)", () => {
  let donor: Browser;
  let donorPid: number;
  let mgr: SessionManager;

  beforeAll(async () => {
    // A stand-in for "the user's own Chrome, started with --remote-debugging-port".
    donor = await puppeteer.launch({
      executablePath: resolveChromePath(),
      headless: true,
      args: ["--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check"],
    });
    donorPid = donor.process()?.pid ?? 0;
    mgr = new SessionManager();
  });

  afterAll(async () => {
    await mgr.shutdown();
    await donor.close();
  });

  it("attaches over the debug port and leaves the donor Chrome alive after close", async () => {
    expect(donorPid).toBeGreaterThan(0);
    const port = Number(new URL(donor.wsEndpoint()).port);
    expect(port).toBeGreaterThan(0);

    const info = await mgr.launch({ mode: "attach", port });
    expect(info.mode).toBe("attach");
    expect(info.incognito).toBe(false);
    expect(mgr.sessions()).toHaveLength(1);

    const closed = await mgr.close(info.sessionId);
    expect(closed).toEqual([info.sessionId]);
    expect(mgr.sessions()).toHaveLength(0);

    // The whole point of ownsBrowser:false — close() must disconnect, never kill. A wrongly
    // owned browser would get CDP Browser.close, which tears Chrome down *asynchronously*, so
    // settle first and then prove liveness with real round-trips rather than a bare pid check.
    await new Promise((r) => setTimeout(r, 1000));
    expect(alive(donorPid)).toBe(true);
    expect(donor.connected).toBe(true);
    expect(await donor.version()).toMatch(/Chrome/i);
    const probe = await donor.newPage();
    await probe.goto("about:blank", { waitUntil: "load" });
    await probe.close();
    expect(alive(donorPid)).toBe(true);
  });
});

describe("sweepStaleTempDirs", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "bfa-sweep-test-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("removes stale bfa-* dirs, keeps in-use ones and anything else", () => {
    const stale = join(root, "bfa-stale");
    const locked = join(root, "bfa-locked");
    const other = join(root, "not-ours");
    for (const d of [stale, locked, other]) mkdirSync(d);
    // A SingletonLock naming THIS live process → Chrome still holds that profile.
    symlinkSync(`host-${process.pid}`, join(locked, "SingletonLock"));

    const removed = sweepStaleTempDirs(root);

    expect(removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(locked)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!chromeAvailable)("SessionManager viewport", () => {
  let fixture: Fixture;
  let mgr: SessionManager;

  beforeAll(async () => {
    fixture = await startFixture();
    mgr = new SessionManager();
  });

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  });

  it("applies a launch-time viewport and resizes it (page_set_viewport)", async () => {
    const info = await mgr.launch({
      mode: "fresh",
      headless: true,
      url: fixture.url,
      viewport: { width: 390, height: 844 },
    });
    let st = await mgr.state(info.sessionId);
    expect(st.viewport?.width).toBe(390);
    expect(st.viewport?.height).toBe(844);
    // what page_set_viewport does under the hood
    await mgr.pageFor(info.sessionId).setViewport({
      width: 412,
      height: 915,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    });
    st = await mgr.state(info.sessionId);
    expect(st.viewport?.width).toBe(412);
    expect(st.viewport?.height).toBe(915);
  });

  it("applies no forced viewport override on a plain session — it tracks the real window", async () => {
    const info = await mgr.launch({ mode: "fresh", headless: true, url: fixture.url });
    const page = mgr.pageFor(info.sessionId);
    // defaultViewport:null → puppeteer sets NO device-metrics override (page.viewport() is null),
    // so the layout viewport tracks the actual window instead of the old fixed 800x600 clamp that
    // rendered sites in a small top-left box in headful/attach windows.
    expect(page.viewport()).toBeNull();
    // Sanity: the page still has a live, positive layout width (whatever the window is).
    const innerWidth = (await page.evaluate(() => window.innerWidth)) as number;
    expect(innerWidth).toBeGreaterThan(0);
  });
});
