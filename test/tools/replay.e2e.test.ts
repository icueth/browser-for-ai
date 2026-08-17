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

// Task 3.8: flow_replay -- executes a synthesized flow server-side and verifies it actually
// reproduces the recorded run, against the same real login -> /api/me chain the flow_export/
// flow_synthesize e2e (task 1F.6, flow.e2e.test.ts) uses.
describe.skipIf(!chromeAvailable)("flow_replay e2e (login -> me chain)", () => {
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
    expect((launched.content as { type: string; text: string }[])[0]!.text).toContain("s1");

    // Let the page-load fetches (/api/ok, /api/fail, /api/hang) and the WS handshake settle
    // before marking the flow start, so they never land in the exported window.
    await new Promise((r) => setTimeout(r, 500));

    const marked = await client.callTool({ name: "flow_mark", arguments: {} });
    expect(marked.isError).toBeFalsy();

    const typedUser = await client.callTool({
      name: "page_type",
      arguments: { selector: "input[name=user]", text: "alice" },
    });
    expect(typedUser.isError).toBeFalsy();

    const typedPass = await client.callTool({
      name: "page_type",
      arguments: { selector: "input[name=pass]", text: "secret" },
    });
    expect(typedPass.isError).toBeFalsy();

    const clicked = await client.callTool({
      name: "page_click",
      arguments: { selector: "#submit", waitMs: 1200 },
    });
    expect(clicked.isError).toBeFalsy();

    // The /api/me fetch fires from inside the /api/login .then() chain, so give it
    // room beyond the click's own waitMs before we read the recording back.
    await new Promise((r) => setTimeout(r, 500));
  });

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  });

  it("replays both calls against the live fixture, chaining the login token into /api/me's Authorization header at runtime", async () => {
    const res = await client.callTool({ name: "flow_replay", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);

    const loginLine = lines.find((l) => l.includes("/api/login"));
    expect(loginLine).toBeDefined();
    expect(loginLine).toMatch(/→ 200 \(recorded 200\) ✓/);

    const meLine = lines.find((l) => l.includes("/api/me"));
    expect(meLine).toBeDefined();
    expect(meLine).toMatch(/→ 200 \(recorded 200\) ✓/);
    // The report must note the chained dep (extracted from step #0's own replay response,
    // not baked in as the recorded literal) and it must have resolved successfully.
    expect(meLine).toMatch(/deps:.*token from #0/);
    expect(meLine).not.toMatch(/UNRESOLVED/);
  });

  it("flow_replay {timeoutMs} accepts an override without erroring", async () => {
    const res = await client.callTool({ name: "flow_replay", arguments: { timeoutMs: 5000 } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(2);
  });
});
