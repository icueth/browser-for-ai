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

// Task 1.4 (net_* tools) + Task 1.5 (console_* tools) assertions.
describe.skipIf(!chromeAvailable)("deep-read tools e2e (net + console)", () => {
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
    // Let the fixture's onload fetches (/api/ok, /api/fail, /api/hang) and WS handshake settle.
    await new Promise((r) => setTimeout(r, 800));
  });

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  });

  it("net_failures reports the failing /api/fail request", async () => {
    const res = await client.callTool({ name: "net_failures", arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("/api/fail");
    expect(text).toContain("500");
  });

  it("net_get fetches the full response body of a completed request by url", async () => {
    const res = await client.callTool({ name: "net_get", arguments: { url: "/api/ok" } });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    // Real CDP body retrieval, not just an echo of the requested url.
    expect(text).toContain('"ok":true');
  });

  it("net_pending reports the still-hanging /api/hang request", async () => {
    const res = await client.callTool({ name: "net_pending", arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("/api/hang");
  });

  it("console_errors reports the fixture's console.error and caught error", async () => {
    const res = await client.callTool({ name: "console_errors", arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("bfa-fixture-error");
  });

  it("console_list with a pattern filters to matching entries, including the log line", async () => {
    const res = await client.callTool({
      name: "console_list",
      arguments: { pattern: "bfa-fixture" },
    });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("bfa-fixture-log");
  });

  // Task 1.6 (page_observe) assertions.
  it("page_observe reload reports a delta with the re-issued network request and console line", async () => {
    const res = await client.callTool({
      name: "page_observe",
      arguments: { action: { kind: "reload" } },
    });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("/api/ok");
    expect(text).toContain("bfa-fixture-log");
  });

  it("page_observe eval returns the truncated expression result", async () => {
    const res = await client.callTool({
      name: "page_observe",
      arguments: { action: { kind: "eval", expression: "document.title" } },
    });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("BFA Fixture");
  });

  it("page_observe goto without a url is rejected", async () => {
    const res = await client.callTool({
      name: "page_observe",
      arguments: { action: { kind: "goto" } },
    });
    expect(res.isError).toBe(true);
  });

  // Task 1.7 (browser_clear_cache + browser_hard_reload) assertions.
  it("browser_clear_cache reports success for the current page's origin", async () => {
    const origin = new URL(fixture.url).origin;
    const res = await client.callTool({ name: "browser_clear_cache", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("cleared");
    expect(text).toContain(origin);
  });

  it("browser_hard_reload reloads the page, reissuing network requests, and reports url/title", async () => {
    const before = await client.callTool({ name: "net_list", arguments: {} });
    const beforeText = (before.content as { type: string; text: string }[])[0]!.text;
    const beforeCount = beforeText.split("\n").length;

    const res = await client.callTool({ name: "browser_hard_reload", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain(new URL(fixture.url).host);
    expect(text).toContain("BFA Fixture");

    // Let the fixture's onload fetches settle again before re-checking net_list.
    await new Promise((r) => setTimeout(r, 800));
    const after = await client.callTool({ name: "net_list", arguments: {} });
    const afterText = (after.content as { type: string; text: string }[])[0]!.text;
    const afterCount = afterText.split("\n").length;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });
});
