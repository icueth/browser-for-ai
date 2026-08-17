import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { SessionManager } from "../../src/session/manager";
import { resolveChromePath } from "../../src/session/chrome-path";
import { startFixture, type Fixture } from "../fixtures/server";

let chrome = false;
try {
  chrome = existsSync(resolveChromePath());
} catch {
  chrome = false;
}

describe.skipIf(!chrome)("Recorder (integration)", () => {
  let fx: Fixture;
  let mgr: SessionManager;
  let sid: string;
  beforeAll(async () => {
    fx = await startFixture();
    mgr = new SessionManager();
    const info = await mgr.launch({ mode: "fresh", headless: true, url: fx.url });
    sid = info.sessionId;
    // give in-page fetch/console/ws a moment
    await new Promise((r) => setTimeout(r, 800));
  });
  afterAll(async () => {
    await mgr.shutdown();
    await fx.close();
  });

  it("captured the fixture's network requests including a 500", async () => {
    const rec = mgr.recorderFor(sid);
    const urls = rec.network.list({ onlyXhr: true }).map((e) => e.url);
    expect(urls.some((u) => u.includes("/api/ok"))).toBe(true);
    expect(rec.network.failures().some((e) => e.url.includes("/api/fail") && e.status === 500)).toBe(true);
  });

  it("captured console log + error", async () => {
    const rec = mgr.recorderFor(sid);
    expect(rec.console.list().some((e) => e.text.includes("bfa-fixture-log"))).toBe(true);
    expect(rec.console.errors().some((e) => e.text.includes("bfa-fixture-error"))).toBe(true);
  });

  it("lazily fetches a response body for /api/ok", async () => {
    const rec = mgr.recorderFor(sid);
    const ok = rec.network.get("/api/ok");
    expect(ok).toBeTruthy();
    const body = await rec.bodyOf(ok!.id);
    expect(body?.body).toContain("ok");
  });

  it("lists a pending request for /api/hang", async () => {
    const rec = mgr.recorderFor(sid);
    expect(rec.network.pending(rec.seqNow()).some((e) => e.url.includes("/api/hang"))).toBe(true);
  });
});
