import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import type { SessionManager } from "../../src/session/manager";
import { resolveChromePath } from "../../src/session/chrome-path";
import { createServer } from "../../src/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startFixture, type Fixture } from "../fixtures/server";

let chromeAvailable = false;
try {
  chromeAvailable = existsSync(resolveChromePath());
} catch {
  chromeAvailable = false;
}

const text = (r: { [k: string]: unknown }) => (r.content as { type: string; text: string }[])[0]!.text;
const SPIN_FOREVER = "setInterval(() => { for (;;) {} }, 0); 'armed'";

describe.skipIf(!chromeAvailable)("hang-proofing e2e", () => {
  let fixture: Fixture;
  let mgr: SessionManager;
  let client: Client;

  beforeAll(async () => {
    fixture = await startFixture();
    const wiring = createServer();
    mgr = wiring.mgr;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([wiring.server.connect(st), client.connect(ct)]);
    await client.callTool({ name: "browser_launch", arguments: { mode: "fresh", headless: true, url: fixture.url } });
    await new Promise((r) => setTimeout(r, 400));
  }, 30_000);

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  }, 30_000);

  it("page_eval terminates a synchronous busy loop within its budget and the page stays usable", async () => {
    const t0 = Date.now();
    const r = await client.callTool({ name: "page_eval", arguments: { expression: "for(;;){}", timeoutMs: 1500 } });
    const dt = Date.now() - t0;
    expect(r.isError).toBeTruthy();
    expect(text(r)).toMatch(/terminated/);
    expect(dt).toBeLessThan(8000); // NOT the 180 s puppeteer default
    const ok = await client.callTool({ name: "page_eval", arguments: { expression: "1+1" } });
    expect(ok.isError).toBeFalsy();
    expect(text(ok)).toBe("2");
  }, 20_000);

  it("page_eval abandons a never-settling promise quickly and says the page stayed responsive", async () => {
    const t0 = Date.now();
    const r = await client.callTool({ name: "page_eval", arguments: { expression: "new Promise(() => {})", timeoutMs: 1000 } });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toMatch(/never resolved|stayed responsive/);
    expect(Date.now() - t0).toBeLessThan(6000);
    const ok = await client.callTool({ name: "page_eval", arguments: { expression: "2+2" } });
    expect(text(ok)).toBe("4");
  }, 20_000);

  it("page_click_at refuses a point outside the viewport with a clear message", async () => {
    const r = await client.callTool({ name: "page_click_at", arguments: { x: 5000, y: 10 } });
    expect(r.isError).toBeTruthy();
    expect(text(r)).toMatch(/outside the .* viewport/);
  });

  it("net_throttle rejects a CPU slowdown above 20x (which would brick the renderer)", async () => {
    const r = await client.callTool({ name: "net_throttle", arguments: { cpuRate: 50 } });
    expect(r.isError).toBeTruthy();
  });

  it("beforeunload is ACCEPTED, so a hard reload really reloads instead of being silently cancelled", async () => {
    await client.callTool({
      name: "page_eval",
      arguments: {
        expression:
          "window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; }); window.__bfa_marker = 1; 'armed'",
      },
    });
    // a real click = user activation, so Chrome actually raises the beforeunload prompt on reload
    await client.callTool({ name: "page_click", arguments: { selector: "#hello" } });
    const r = await client.callTool({ name: "browser_hard_reload", arguments: {} });
    expect(r.isError).toBeFalsy();
    await new Promise((res) => setTimeout(res, 800));
    const after = await client.callTool({ name: "page_eval", arguments: { expression: "String(window.__bfa_marker)" } });
    expect(text(after)).toBe('"undefined"'); // marker gone → the reload happened
  }, 20_000);

  it("browser_recover unfreezes a page whose own script keeps re-spinning; page_eval works again", async () => {
    const armed = await client.callTool({ name: "page_eval", arguments: { expression: SPIN_FOREVER, timeoutMs: 3000 } });
    expect(text(armed)).toBe('"armed"');
    const t0 = Date.now();
    const r = await client.callTool({ name: "browser_recover", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/recovered/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    const ok = await client.callTool({ name: "page_eval", arguments: { expression: "3+3", timeoutMs: 4000 } });
    expect(ok.isError).toBeFalsy();
    expect(text(ok)).toBe("6");
  }, 40_000);

  it("browser_close stays bounded even when the renderer is pinned (owned Chrome is force-killed)", async () => {
    const launched = await client.callTool({ name: "browser_launch", arguments: { mode: "fresh", headless: true, url: fixture.url } });
    const sid = text(launched).match(/session (s\d+)/)![1];
    await new Promise((r) => setTimeout(r, 300));
    const armed = await client.callTool({ name: "page_eval", arguments: { expression: SPIN_FOREVER, sessionId: sid, timeoutMs: 3000 } });
    expect(text(armed)).toBe('"armed"');
    const t0 = Date.now();
    const closed = await client.callTool({ name: "browser_close", arguments: { sessionId: sid } });
    const dt = Date.now() - t0;
    expect(closed.isError).toBeFalsy();
    expect(text(closed)).toContain(sid!);
    expect(dt).toBeLessThan(15_000); // the force-quit scenario, now bounded
  }, 40_000);
it("browser_close {all:true} with TWO pinned sessions is bounded (parallel teardown, not N × budget)", async () => {
    const a = await client.callTool({ name: "browser_launch", arguments: { mode: "fresh", headless: true, url: fixture.url } });
    const b = await client.callTool({ name: "browser_launch", arguments: { mode: "fresh", headless: true, url: fixture.url } });
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    const ids = [a, b].map((r) => text(r).match(/session (s\d+)/)![1]!);
    await new Promise((r) => setTimeout(r, 300));
    for (const id of ids) {
      const armed = await client.callTool({ name: "page_eval", arguments: { sessionId: id, expression: SPIN_FOREVER, timeoutMs: 3000 } });
      expect(text(armed)).toContain("armed");
    }
    const t0 = Date.now();
    const r = await client.callTool({ name: "browser_close", arguments: { all: true } });
    const dt = Date.now() - t0;
    expect(r.isError).toBeFalsy();
    expect(dt).toBeLessThan(16_000);
  }, 60_000);
});
