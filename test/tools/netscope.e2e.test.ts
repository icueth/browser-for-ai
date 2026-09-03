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
const text = (r: { [k: string]: unknown }) => (r.content as { type: string; text: string }[]).map((b) => b.text).join("\n");

describe.skipIf(!chromeAvailable)("net scoping: since-last-action waits and since-navigation listings", () => {
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
    await new Promise((r) => setTimeout(r, 800));
  }, 30_000);

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  }, 30_000);

  it("net_wait ignores a request that predates the last action (an old poll can't satisfy it) unless includeExisting", async () => {
    // /api/ok was fetched during page load — before this hover, which becomes the 'last action'.
    await client.callTool({ name: "page_hover", arguments: { selector: "#hello" } });
    const t0 = Date.now();
    const miss = await client.callTool({ name: "net_wait", arguments: { urlIncludes: "/api/ok", timeoutMs: 500 } });
    expect(miss.isError).toBeTruthy();
    expect(text(miss)).toContain("since your last action");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
    const hit = await client.callTool({ name: "net_wait", arguments: { urlIncludes: "/api/ok", timeoutMs: 500, includeExisting: true } });
    expect(hit.isError).toBeFalsy();
    expect(text(hit)).toContain("/api/ok");
  });

  it("net_wait DOES see a request triggered by the last action (page_click → /api/login)", async () => {
    await client.callTool({ name: "page_fill", arguments: { fields: [{ selector: "input[name=user]", value: "bob" }, { selector: "input[name=pass]", value: "pw" }] } });
    await client.callTool({ name: "page_click", arguments: { selector: "#submit" } });
    const r = await client.callTool({ name: "net_wait", arguments: { urlIncludes: "/api/login", requireFinished: true, timeoutMs: 5000 } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("/api/login");
  });

  it('net_list since:"nav" drops requests from the previous page; the default listing flags them as stale', async () => {
    await client.callTool({ name: "page_eval", arguments: { expression: "fetch('/first-only-marker').catch(() => {}); 'x'" } });
    await client.callTool({ name: "net_wait", arguments: { urlIncludes: "first-only-marker", requireFinished: true, timeoutMs: 3000 } });
    await client.callTool({ name: "page_goto", arguments: { url: fixture.url } });
    await new Promise((r) => setTimeout(r, 500));
    const scoped = text(await client.callTool({ name: "net_list", arguments: { since: "nav", limit: 200 } }));
    expect(scoped).toContain("/api/ok"); // this page load's own requests
    expect(scoped).not.toContain("first-only-marker");
    expect(scoped).not.toContain("from BEFORE the current page");
    const all = text(await client.callTool({ name: "net_list", arguments: { limit: 200 } }));
    expect(all).toContain("first-only-marker");
    expect(all.split("\n").length).toBeGreaterThan(scoped.split("\n").length);
    expect(all).toMatch(/\d+ of these are from BEFORE the current page/);
    const pending = text(await client.callTool({ name: "net_pending", arguments: { since: "nav" } }));
    expect(pending).toContain("/api/hang"); // this page's own hang, not the earlier page's
  });
});
