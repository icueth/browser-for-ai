import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { SessionManager, findOrphanChromes } from "../../src/session/manager";
import { resolveChromePath } from "../../src/session/chrome-path";
import { startFixture, type Fixture } from "../fixtures/server";

let chromeAvailable = false;
try {
  chromeAvailable = existsSync(resolveChromePath());
} catch {
  chromeAvailable = false;
}

describe("findOrphanChromes (pure parser)", () => {
  const ps = [
    "  100 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/bfa-a --bfa-server=111",
    "  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer --bfa-server=111",
    "  200 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/bfa-b --bfa-server=222",
    "  300 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/real  ",
    "  400 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --bfa-server=333",
    "garbage line without pid",
  ].join("\n");

  it("returns only MAIN Chrome pids whose owning bfa pid is dead; skips helpers, live owners, untagged and self", () => {
    const alive = (pid: number) => pid === 222;
    expect(findOrphanChromes(ps, alive, /* selfPid */ 333)).toEqual([100]);
  });

  it("with everything alive there is nothing to kill", () => {
    expect(findOrphanChromes(ps, () => true, 999)).toEqual([]);
  });
});

describe.skipIf(!chromeAvailable)("session lifecycle: reuse by default, cap (LRU), idle reaper", () => {
  let fixture: Fixture;
  const managers: SessionManager[] = [];
  const make = (opts: ConstructorParameters<typeof SessionManager>[0]) => {
    const m = new SessionManager(opts);
    managers.push(m);
    return m;
  };

  beforeAll(async () => {
    fixture = await startFixture();
  });
  afterAll(async () => {
    for (const m of managers) await m.shutdown();
    await fixture.close();
  }, 60_000);

  it("a second launch with the same isolation REUSES the open session (navigates it) — no second Chrome", async () => {
    const mgr = make({ idleMinutes: 0, maxSessions: 0 });
    const a = await mgr.launch({ mode: "fresh", headless: true, url: `${fixture.url}?a` });
    const b = await mgr.launch({ mode: "fresh", headless: true, url: `${fixture.url}?b` });
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.reused).toBe(true);
    expect(b.url).toContain("?b");
    expect(mgr.sessions().length).toBe(1);
    expect(mgr.ownedProcesses().length).toBe(1);
    // different isolation (incognito) does NOT reuse a non-incognito session
    const c = await mgr.launch({ mode: "fresh", headless: true, incognito: true, url: `${fixture.url}?c` });
    expect(c.sessionId).not.toBe(a.sessionId);
    expect(c.reused).toBeUndefined();
    // new:true forces a second browser even when a match exists
    const d = await mgr.launch({ mode: "fresh", headless: true, url: `${fixture.url}?d`, new: true });
    expect(d.sessionId).not.toBe(a.sessionId);
    expect(mgr.sessions().length).toBe(3);
  }, 60_000);

  it("the session cap evicts the least-recently-used owned session (and reports it)", async () => {
    const mgr = make({ idleMinutes: 0, maxSessions: 2 });
    const s1 = await mgr.launch({ mode: "fresh", headless: true, url: fixture.url, new: true });
    const s2 = await mgr.launch({ mode: "fresh", headless: true, url: fixture.url, new: true });
    // touch s1 so s2 becomes the LRU
    await mgr.goto(`${fixture.url}?touch`, s1.sessionId);
    const s3 = await mgr.launch({ mode: "fresh", headless: true, url: fixture.url, new: true });
    expect(s3.evicted).toBe(s2.sessionId);
    const ids = mgr.sessions().map((s) => s.sessionId);
    expect(ids).toContain(s1.sessionId);
    expect(ids).toContain(s3.sessionId);
    expect(ids).not.toContain(s2.sessionId);
    expect(ids.length).toBe(2);
  }, 60_000);

  it("the idle reaper closes an owned session nobody touches (attach sessions are never reaped)", async () => {
    // 0.005 min = 300 ms idle budget, reaper every 100 ms.
    const mgr = make({ idleMinutes: 0.005, maxSessions: 0, reapIntervalMs: 100 });
    const s = await mgr.launch({ mode: "fresh", headless: true, url: fixture.url });
    expect(mgr.sessions().length).toBe(1);
    await new Promise((r) => setTimeout(r, 1200));
    expect(mgr.sessions().map((x) => x.sessionId)).not.toContain(s.sessionId);
    expect(mgr.ownedProcesses().length).toBe(0);
  }, 30_000);

  it("browser_sessions-style listing exposes idleMs and listing does not reset it", async () => {
    const mgr = make({ idleMinutes: 0, maxSessions: 0 });
    await mgr.launch({ mode: "fresh", headless: true, url: fixture.url });
    await new Promise((r) => setTimeout(r, 250));
    const [row] = mgr.sessions();
    expect(row!.idleMs).toBeGreaterThanOrEqual(200);
    await new Promise((r) => setTimeout(r, 200));
    const [row2] = mgr.sessions();
    expect(row2!.idleMs).toBeGreaterThan(row!.idleMs!); // listing didn't touch lastUsedAt
  }, 30_000);
});
