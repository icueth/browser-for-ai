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

describe.skipIf(!chromeAvailable)("MCP tools e2e", () => {
  let fixture: Fixture;
  let mgr: SessionManager;
  let client: Client;

  beforeAll(async () => {
    fixture = await startFixture();
    // Exercise the REAL production wiring from src/server.ts (not a hand-rebuilt copy), so a
    // missing register*Tools call or a broken createServer() fails here.
    const wiring = createServer();
    mgr = wiring.mgr;
    const server = wiring.server;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  });

  it("lists the registered tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["browser_launch", "browser_sessions", "browser_use", "browser_tabs", "browser_close", "page_goto", "page_state"]),
    );
  });

  it("launches a session and reads state through the tool layer", async () => {
    const launched = await client.callTool({
      name: "browser_launch",
      arguments: { mode: "fresh", headless: true, url: fixture.url },
    });
    const launchedText = (launched.content as { type: string; text: string }[])[0]!.text;
    expect(launchedText).toContain("s1");

    const state = await client.callTool({ name: "page_state", arguments: {} });
    const stateText = (state.content as { type: string; text: string }[])[0]!.text;
    expect(stateText).toContain("BFA Fixture");
    expect(stateText).toContain("complete");
  });

  it("returns a structured error (not a crash) for a bad session id", async () => {
    const res = await client.callTool({ name: "page_state", arguments: { sessionId: "s999" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("s999");
  });
});
