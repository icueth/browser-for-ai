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
type Block = { type: string; text?: string; data?: string; mimeType?: string };
const blocks = (r: { [k: string]: unknown }) => r.content as Block[];
const textOf = (r: { [k: string]: unknown }) => blocks(r).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const imageOf = (r: { [k: string]: unknown }) => blocks(r).find((b) => b.type === "image");

describe.skipIf(!chromeAvailable)("page_eval: value, opt-in delta, opt-in screenshot (browsercode-style one-call)", () => {
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
    await new Promise((r) => setTimeout(r, 500));
  }, 30_000);

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  }, 30_000);

  it("plain eval returns just the value (no delta, no image)", async () => {
    const r = await client.callTool({ name: "page_eval", arguments: { expression: "document.title" } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("BFA Fixture");
    expect(imageOf(r)).toBeUndefined();
  });

  it("delta:true bundles the network/console side-effects the expression caused", async () => {
    const r = await client.callTool({
      name: "page_eval",
      arguments: { expression: "fetch('/api/ok?fromeval').catch(() => {}); 'kicked'", delta: true },
    });
    expect(r.isError).toBeFalsy();
    const out = textOf(r);
    expect(out).toContain("kicked"); // the eval value, as the delta header note
    expect(out).toContain("/api/ok?fromeval"); // the request it triggered, in the same call
  });

  it("screenshot:true returns a viewport image + a 1:1 mapping note in the same call", async () => {
    const r = await client.callTool({ name: "page_eval", arguments: { expression: "1+1", screenshot: true } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("2");
    const img = imageOf(r);
    expect(img).toBeTruthy();
    expect(img!.mimeType).toBe("image/png");
    expect((img!.data ?? "").length).toBeGreaterThan(100);
    expect(textOf(r)).toMatch(/page_click_at|1:1/); // the mapping note
  });

  it("delta + screenshot together: value note, delta, and image in one reply", async () => {
    const r = await client.callTool({
      name: "page_eval",
      arguments: { expression: "document.body.style.background='#eee'; fetch('/api/ok?both').catch(()=>{}); 'done'", delta: true, screenshot: true },
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("done");
    expect(textOf(r)).toContain("/api/ok?both");
    expect(imageOf(r)).toBeTruthy();
  });

  it("a busy loop is still bounded even with screenshot/delta on", async () => {
    const r = await client.callTool({
      name: "page_eval",
      arguments: { expression: "const t=Date.now(); while(Date.now()-t<60000){}; 'never'", timeoutMs: 1000, screenshot: true, delta: true },
    });
    // Either a terminated-script error, or it returns without hanging — never a 60s stall.
    expect(textOf(r).length).toBeGreaterThan(0);
  }, 20_000);
});
