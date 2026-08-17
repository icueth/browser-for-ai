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

// Does a live fetch to /api/ok succeed right now? Returns "ok" or "failed".
const FETCH_PROBE =
  "(async()=>{try{const r=await fetch('/api/ok',{cache:'no-store'});return r.ok?'ok':'failed';}catch(e){return 'failed';}})()";

describe.skipIf(!chromeAvailable)("net_throttle e2e", () => {
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

  it("offline cuts the network, and reset restores it — a real fetch proves the effect", async () => {
    // sanity: online first
    const before = await client.callTool({ name: "page_eval", arguments: { expression: FETCH_PROBE } });
    expect(text(before)).toBe('"ok"');

    const off = await client.callTool({ name: "net_throttle", arguments: { preset: "offline" } });
    expect(off.isError).toBeFalsy();
    expect(text(off)).toContain("offline");

    const during = await client.callTool({ name: "page_eval", arguments: { expression: FETCH_PROBE } });
    expect(text(during)).toBe('"failed"');

    const reset = await client.callTool({ name: "net_throttle", arguments: { preset: "none" } });
    expect(reset.isError).toBeFalsy();
    expect(text(reset)).toContain("reset");

    const after = await client.callTool({ name: "page_eval", arguments: { expression: FETCH_PROBE } });
    expect(text(after)).toBe('"ok"');
  });

  it("applies a named 3G preset without error", async () => {
    const slow = await client.callTool({ name: "net_throttle", arguments: { preset: "slow-3g", cpuRate: 2 } });
    expect(slow.isError).toBeFalsy();
    expect(text(slow)).toContain("slow-3g");
    expect(text(slow)).toContain("cpu 2x");
    // clean up so later suites aren't throttled
    await client.callTool({ name: "net_throttle", arguments: { preset: "none" } });
  });
});
