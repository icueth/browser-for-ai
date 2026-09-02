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
type Block = { type: string; text?: string; data?: string };
const textOf = (r: { [k: string]: unknown }) => (r.content as Block[]).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const imageOf = (r: { [k: string]: unknown }) => (r.content as Block[]).find((b) => b.type === "image");

describe.skipIf(!chromeAvailable)("speed pack e2e: smart settle, page_wait_for, page_batch", () => {
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

  it("an action that triggers nothing returns well under the old fixed 700ms (smart settle)", async () => {
    const t0 = Date.now();
    const r = await client.callTool({ name: "page_hover", arguments: { selector: "#hello" } });
    const dt = Date.now() - t0;
    expect(r.isError).toBeFalsy();
    expect(dt).toBeLessThan(650);
  });

  it("page_wait_for returns when a selector appears (not before)", async () => {
    await client.callTool({
      name: "page_eval",
      arguments: { expression: "setTimeout(() => { const b = document.createElement('button'); b.id = 'late'; b.textContent = 'LateButton'; document.body.appendChild(b); }, 500); 'scheduled'" },
    });
    const t0 = Date.now();
    const r = await client.callTool({ name: "page_wait_for", arguments: { selector: "#late", timeoutMs: 5000 } });
    const dt = Date.now() - t0;
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('selector "#late" appeared');
    expect(dt).toBeGreaterThanOrEqual(350);
    expect(dt).toBeLessThan(3000);
  });

  it("page_wait_for matches text and url too, and times out cleanly", async () => {
    const t = await client.callTool({ name: "page_wait_for", arguments: { text: "LateButton", timeoutMs: 3000 } });
    expect(textOf(t)).toContain("text");
    const u = await client.callTool({ name: "page_wait_for", arguments: { url: "127.0.0.1", timeoutMs: 1000 } });
    expect(textOf(u)).toContain("url matched");
    const miss = await client.callTool({ name: "page_wait_for", arguments: { selector: "#never-ever", timeoutMs: 600 } });
    expect(miss.isError).toBeTruthy();
    expect(textOf(miss)).toMatch(/within 600ms/);
  });

  it("page_wait_for networkIdle resolves on a quiet page", async () => {
    const r = await client.callTool({ name: "page_wait_for", arguments: { networkIdleMs: 300, timeoutMs: 5000 } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("network idle");
  });

  it("page_batch runs fill → fill → click-by-text in one call with a combined delta and a final look", async () => {
    const r = await client.callTool({
      name: "page_batch",
      arguments: {
        steps: [
          { action: "fill", selector: "input[name=user]", value: "bob" },
          { action: "fill", selector: "input[name=pass]", value: "pw" },
          { action: "click", text: "Login" },
          { action: "wait_for", url: "127.0.0.1", timeoutMs: 2000 },
        ],
        look: true,
      },
    });
    expect(r.isError).toBeFalsy();
    const out = textOf(r);
    expect(out).toContain("#1 fill ✓");
    expect(out).toContain("#3 click ✓");
    expect(out).toContain("#4 wait_for ✓");
    expect(out).toContain("/api/login"); // the combined delta saw the login call
    expect(out).toContain("/api/me");
    expect(out).toContain("--- look ---");
    expect(out).toMatch(/\d+ marked \(badge N = ref eN\)/);
    expect(imageOf(r)).toBeTruthy();
  }, 30_000);

  it("page_batch stops at the first failing step and marks the result as an error", async () => {
    const r = await client.callTool({
      name: "page_batch",
      arguments: {
        steps: [
          { action: "click", selector: "#does-not-exist" },
          { action: "click", selector: "#submit" },
        ],
      },
    });
    expect(r.isError).toBeTruthy();
    const out = textOf(r);
    expect(out).toContain("#1 click ✗");
    expect(out).toContain("stopped after step 1 (1 not run)");
    expect(out).not.toContain("#2 click ✓");
  });
});
