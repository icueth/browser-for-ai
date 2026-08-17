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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Task 3.3 (net_intercept) assertions.
describe.skipIf(!chromeAvailable)("net_intercept e2e", () => {
  let fixture: Fixture;
  let mgr: SessionManager;
  let client: Client;

  beforeAll(async () => {
    fixture = await startFixture();
    // Exercise the REAL production wiring from src/server.ts, not a hand-rebuilt copy.
    const wiring = createServer();
    mgr = wiring.mgr;
    const server = wiring.server;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const launched = await client.callTool({
      name: "browser_launch",
      arguments: { mode: "fresh", headless: true, url: fixture.url },
    });
    const launchedText = (launched.content as { type: string; text: string }[])[0]!.text;
    expect(launchedText).toContain("s1");
    // Let the fixture's onload fetches (/api/ok, /api/fail, /api/hang, /api/slow) settle.
    await sleep(800);
  });

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  });

  it("mocks a matching response", async () => {
    const add = await client.callTool({
      name: "net_intercept_add",
      arguments: { urlPattern: "/api/ok", action: "mock", status: 200, body: '{"mocked":true}', contentType: "application/json" },
    });
    expect(add.isError).toBeFalsy();
    const addText = (add.content as { type: string; text: string }[])[0]!.text;
    expect(addText).toContain("rule #");
    expect(addText).toContain("mock");
    expect(addText).toContain("/api/ok");

    const list1 = await client.callTool({ name: "net_intercept_list", arguments: {} });
    const list1Text = (list1.content as { type: string; text: string }[])[0]!.text;
    expect(list1Text).toContain("/api/ok");
    expect(list1Text).toContain("mock");

    // Reload so the page re-issues its fetches under the now-enabled interceptor.
    const goto = await client.callTool({ name: "page_goto", arguments: { url: fixture.url } });
    expect(goto.isError).toBeFalsy();
    await sleep(600);

    const get = await client.callTool({ name: "net_get", arguments: { url: "/api/ok" } });
    expect(get.isError).toBeFalsy();
    const getText = (get.content as { type: string; text: string }[])[0]!.text;
    expect(getText).toContain('"mocked":true');
  });

  it("blocks a matching request", async () => {
    const add = await client.callTool({
      name: "net_intercept_add",
      arguments: { urlPattern: "/api/fail", action: "block" },
    });
    expect(add.isError).toBeFalsy();

    const goto = await client.callTool({ name: "page_goto", arguments: { url: fixture.url } });
    expect(goto.isError).toBeFalsy();
    await sleep(600);

    const failures = await client.callTool({ name: "net_failures", arguments: {} });
    const failuresText = (failures.content as { type: string; text: string }[])[0]!.text;
    expect(failuresText).toContain("/api/fail");
    expect(failuresText.toUpperCase()).toContain("FAIL");
  });

  it("clears rules and stops intercepting", async () => {
    const clear = await client.callTool({ name: "net_intercept_clear", arguments: {} });
    expect(clear.isError).toBeFalsy();
    const clearText = (clear.content as { type: string; text: string }[])[0]!.text;
    expect(clearText).toContain("cleared");

    const list = await client.callTool({ name: "net_intercept_list", arguments: {} });
    const listText = (list.content as { type: string; text: string }[])[0]!.text;
    expect(listText).not.toContain("/api/ok");

    const goto = await client.callTool({ name: "page_goto", arguments: { url: fixture.url } });
    expect(goto.isError).toBeFalsy();
    await sleep(600);

    const get = await client.callTool({ name: "net_get", arguments: { url: "/api/ok" } });
    expect(get.isError).toBeFalsy();
    const getText = (get.content as { type: string; text: string }[])[0]!.text;
    expect(getText).toContain('"ok":true');
    expect(getText).not.toContain("mocked");
  });
});
