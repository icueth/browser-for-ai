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

describe.skipIf(!chromeAvailable)("page_find + page_read e2e", () => {
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
  });

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  });

  it("page_find by TEXT returns the matching interactive element with a ref that clicks", async () => {
    const found = await client.callTool({ name: "page_find", arguments: { text: "Login" } });
    expect(found.isError).toBeFalsy();
    const out = text(found);
    expect(out).toContain("Login");
    const ref = out.match(/\[(e\d+)\]/)?.[1];
    expect(ref).toBeTruthy();
    // the returned ref must resolve for a real interaction (round-trip the ref contract)
    const clicked = await client.callTool({ name: "page_click", arguments: { ref } });
    expect(clicked.isError).toBeFalsy();
  });

  it("page_find by ROLE=textbox finds the text inputs (implicit role, no role attr)", async () => {
    const found = await client.callTool({ name: "page_find", arguments: { role: "textbox" } });
    expect(found.isError).toBeFalsy();
    // fixture has <input name=user> + <input name=pass> — both implicit textboxes
    expect(text(found)).toMatch(/\[e\d+\] input/);
  });

  it("page_find by SELECTOR + includeNonInteractive locates a non-clickable heading", async () => {
    const found = await client.callTool({
      name: "page_find",
      arguments: { selector: "#hello", includeNonInteractive: true },
    });
    expect(found.isError).toBeFalsy();
    expect(text(found)).toContain("hello bfa");
  });

  it("page_find requires at least one of text/role/selector", async () => {
    const found = await client.callTool({ name: "page_find", arguments: {} });
    expect(found.isError).toBeTruthy();
    expect(text(found)).toContain("at least one");
  });

  it("page_read returns page content, and query filters to matching lines", async () => {
    const all = await client.callTool({ name: "page_read", arguments: {} });
    expect(all.isError).toBeFalsy();
    expect(text(all)).toContain("hello bfa");

    const filtered = await client.callTool({ name: "page_read", arguments: { query: "hello" } });
    expect(filtered.isError).toBeFalsy();
    expect(text(filtered)).toContain("hello bfa");

    const miss = await client.callTool({ name: "page_read", arguments: { query: "zzz-not-present" } });
    expect(text(miss)).toContain("no lines matching");
  });
});
