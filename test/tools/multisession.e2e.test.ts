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
const text = (r: { [k: string]: unknown }) => (r.content as { type: string; text: string }[]).map((b) => b.text ?? "").join("\n");
const sidOf = (r: { [k: string]: unknown }) => text(r).match(/session (s\d+)/)![1]!;

describe.skipIf(!chromeAvailable)("multi-session routing: ops target the id you pass, close closes that id", () => {
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
  }, 30_000);

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  }, 30_000);

  it("launch always lands on the requested URL; ops route to the id passed; close closes THAT id", async () => {
    const a = await client.callTool({ name: "browser_launch", arguments: { mode: "fresh", headless: true, url: `${fixture.url}?a` } });
    const b = await client.callTool({ name: "browser_launch", arguments: { mode: "fresh", headless: true, url: `${fixture.url}?b` } });
    const s1 = sidOf(a);
    const s2 = sidOf(b);
    expect(s1).not.toBe(s2);
    // #1: each launch actually loaded its OWN url (no silent reuse of another game's tab).
    expect(text(a)).toContain("?a");
    expect(text(b)).toContain("?b");

    // #4: page_goto on s1 must act on s1 and report s1 — not the active (s2).
    const g = await client.callTool({ name: "page_goto", arguments: { sessionId: s1, url: `${fixture.url}?a2` } });
    expect(text(g).startsWith(s1 + " ")).toBe(true);
    expect(text(g)).toContain("?a2");

    // s2 is untouched by the s1 navigation.
    const st2 = text(await client.callTool({ name: "page_state", arguments: { sessionId: s2 } }));
    expect(st2).toContain("?b");
    expect(st2).toContain(s2);

    // #4: closing s1 closes s1 (not s2, not "active").
    const closed = await client.callTool({ name: "browser_close", arguments: { sessionId: s1 } });
    expect(text(closed)).toContain(`closed: ${s1}`);
    expect(text(closed)).not.toContain(s2);
    const list = text(await client.callTool({ name: "browser_sessions", arguments: {} }));
    expect(list).toContain(s2);
    expect(list).not.toContain(s1);

    await client.callTool({ name: "browser_close", arguments: { all: true } });
  }, 40_000);

  it("page_batch supports tap_at (touch) as a step for canvas games", async () => {
    await client.callTool({ name: "browser_launch", arguments: { mode: "fresh", headless: true, url: fixture.url, device: "mobile" } });
    await new Promise((r) => setTimeout(r, 400));
    // #5: the correct step shape is { action: "tap_at", x, y }; a foreign shape must be rejected clearly.
    const r = await client.callTool({
      name: "page_batch",
      arguments: {
        steps: [
          { action: "tap_at", x: 10, y: 10 },
          { action: "wait", ms: 100 },
        ],
      },
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("#1 tap_at ✓");
    // wrong shape {tap_at:...} is rejected: `action` is required (MCP validation → isError).
    const bad: any = await client.callTool({ name: "page_batch", arguments: { steps: [{ tap_at: { x: 1, y: 1 } }] } });
    expect(bad.isError).toBeTruthy();
    await client.callTool({ name: "browser_close", arguments: { all: true } });
  }, 30_000);
});
