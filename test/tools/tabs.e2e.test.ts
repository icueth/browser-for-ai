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
const text = (r: { [k: string]: unknown }) => (r.content as { type: string; text: string }[]).map((b) => b.text ?? "").join("\n");

describe.skipIf(!chromeAvailable)("tabs & healing: mobile preset, popup follow, closed-tab heal, browser_use_tab", () => {
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
  }, 30_000);

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  }, 30_000);

  it('device:"mobile" gives a fixed 390x844 viewport (page_state reports it as fixed)', async () => {
    await client.callTool({ name: "browser_launch", arguments: { mode: "fresh", headless: true, url: fixture.url, device: "mobile" } });
    await new Promise((r) => setTimeout(r, 400));
    const st = text(await client.callTool({ name: "page_state", arguments: {} }));
    expect(st).toContain("390x844 (fixed)");
    const w = text(await client.callTool({ name: "page_eval", arguments: { expression: "innerWidth" } }));
    expect(w).toContain("390");
    await client.callTool({ name: "browser_close", arguments: { all: true } });
  }, 30_000);

  it("auto-follows a tab the page opens (fresh mode): after clicking 'open game', tools drive the popup", async () => {
    await client.callTool({ name: "browser_launch", arguments: { mode: "fresh", headless: true, url: fixture.url } });
    await new Promise((r) => setTimeout(r, 400));
    await client.callTool({ name: "page_click", arguments: { selector: "#openpop" } });
    await new Promise((r) => setTimeout(r, 800));
    const st = text(await client.callTool({ name: "page_state", arguments: {} }));
    expect(st).toContain("/popup");
    const game = text(await client.callTool({ name: "page_eval", arguments: { expression: "document.getElementById('game')?.textContent ?? 'NO'" } }));
    expect(game).toContain("GAME WINDOW");
    // browser_use_tab can switch back to the opener (tab 0)
    const tabs = text(await client.callTool({ name: "browser_tabs", arguments: {} }));
    expect(tabs).toContain("/popup");
    const back = text(await client.callTool({ name: "browser_use_tab", arguments: { index: 0 } }));
    expect(back).toContain("driving tab 0");
    const opener = text(await client.callTool({ name: "page_eval", arguments: { expression: "document.getElementById('hello')?.textContent ?? 'NO'" } }));
    expect(opener).toContain("hello bfa");
    await client.callTool({ name: "browser_close", arguments: { all: true } });
  }, 30_000);

  it("heals a closed driven tab instead of throwing 'detached Frame' — page_goto recovers to a live tab", async () => {
    await client.callTool({ name: "browser_launch", arguments: { mode: "fresh", headless: true, url: fixture.url } });
    await new Promise((r) => setTimeout(r, 400));
    // Open a second tab, follow it, then close it out from under bfa.
    await client.callTool({ name: "page_click", arguments: { selector: "#openpop" } });
    await new Promise((r) => setTimeout(r, 800));
    await client.callTool({ name: "page_eval", arguments: { expression: "window.close(); 'closing'" } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    // The driven tab is gone; page_goto must heal to the surviving opener tab, not error.
    const r = await client.callTool({ name: "page_goto", arguments: { url: `${fixture.url}?healed` } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("?healed");
    await client.callTool({ name: "browser_close", arguments: { all: true } });
  }, 30_000);
});
