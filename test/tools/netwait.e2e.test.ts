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

// Task 3.2 (net_slow + net_wait) assertions.
describe.skipIf(!chromeAvailable)("net_slow + net_wait e2e", () => {
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
    await new Promise((r) => setTimeout(r, 800));
  });

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  });

  it("net_slow reports the slow-but-finished /api/slow request with a ms value", async () => {
    const res = await client.callTool({ name: "net_slow", arguments: { thresholdMs: 200 } });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("/api/slow");
    expect(text).toMatch(/\b\d+ms\b/);
  });

  it("net_wait resolves for a fresh /api/ok request without a fixed sleep", async () => {
    // Reload to re-issue the fetches, then wait immediately (no manual delay) — this proves
    // net_wait is actually polling for the request rather than the entry already existing.
    const goto = await client.callTool({ name: "page_goto", arguments: { url: fixture.url } });
    expect(goto.isError).toBeFalsy();

    const res = await client.callTool({
      name: "net_wait",
      arguments: { urlIncludes: "/api/ok", requireFinished: true, timeoutMs: 5000 },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("/api/ok");
  });

  it("net_wait times out with an error for a request that never happens", async () => {
    const res = await client.callTool({
      name: "net_wait",
      arguments: { urlIncludes: "/does-not-exist", timeoutMs: 600 },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("no match");
    expect(text).toContain("600ms");
  });
});
