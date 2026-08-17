import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

// Task 3.4 (session_save + session_restore) assertions.
describe.skipIf(!chromeAvailable)("session_save + session_restore e2e", () => {
  let fixture: Fixture;
  let mgr: SessionManager;
  let client: Client;
  const stateName = `t1_${Date.now()}`;

  beforeAll(async () => {
    fixture = await startFixture();
    // Exercise the REAL production wiring from src/server.ts, not a hand-rebuilt copy.
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
    const statePath = join(homedir(), ".bfa", "state", `${stateName}.json`);
    try {
      unlinkSync(statePath);
    } catch {
      // best-effort cleanup
    }
  });

  it("saves cookies + storage from one session and restores them into a fresh one", async () => {
    const launched1 = await client.callTool({
      name: "browser_launch",
      arguments: { mode: "fresh", headless: true, url: fixture.url },
    });
    const launched1Text = (launched1.content as { type: string; text: string }[])[0]!.text;
    const s1Match = launched1Text.match(/^session (\S+)/);
    expect(s1Match).toBeTruthy();
    const s1 = s1Match![1]!;

    const setResult = await client.callTool({
      name: "page_eval",
      arguments: {
        sessionId: s1,
        expression: "document.cookie='bfa_test=hi; path=/'; localStorage.setItem('k','v'); 'set'",
      },
    });
    expect(setResult.isError).toBeFalsy();

    const saveResult = await client.callTool({
      name: "session_save",
      arguments: { sessionId: s1, name: stateName },
    });
    expect(saveResult.isError).toBeFalsy();
    const saveText = (saveResult.content as { type: string; text: string }[])[0]!.text;
    expect(saveText).toMatch(/\bsaved\b/);
    expect(saveText).toContain("1 cookie");
    expect(saveText).toContain(stateName);

    // New, independent fresh session — no cookies/localStorage of its own.
    const launched2 = await client.callTool({
      name: "browser_launch",
      arguments: { mode: "fresh", headless: true },
    });
    const launched2Text = (launched2.content as { type: string; text: string }[])[0]!.text;
    const s2Match = launched2Text.match(/^session (\S+)/);
    expect(s2Match).toBeTruthy();
    const s2 = s2Match![1]!;

    const goto = await client.callTool({
      name: "page_goto",
      arguments: { url: fixture.url, sessionId: s2 },
    });
    expect(goto.isError).toBeFalsy();

    const restoreResult = await client.callTool({
      name: "session_restore",
      arguments: { sessionId: s2, name: stateName },
    });
    expect(restoreResult.isError).toBeFalsy();
    const restoreText = (restoreResult.content as { type: string; text: string }[])[0]!.text;
    expect(restoreText).toMatch(/\brestored\b/);
    expect(restoreText).toContain("1 cookie");

    const localResult = await client.callTool({
      name: "page_eval",
      arguments: { sessionId: s2, expression: "localStorage.getItem('k')" },
    });
    const localText = (localResult.content as { type: string; text: string }[])[0]!.text;
    expect(localText).toContain("v");

    const cookieResult = await client.callTool({
      name: "page_eval",
      arguments: { sessionId: s2, expression: "document.cookie" },
    });
    const cookieText = (cookieResult.content as { type: string; text: string }[])[0]!.text;
    expect(cookieText).toContain("bfa_test");
  });

  it("session_restore fails cleanly for a name that was never saved", async () => {
    const res = await client.callTool({
      name: "session_restore",
      arguments: { name: "does-not-exist-" + Date.now() },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("no saved state");
  });
});
