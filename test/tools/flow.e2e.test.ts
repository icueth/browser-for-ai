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

// Task 1F.6: flow_mark + flow_export + flow_synthesize, proven against a real
// login -> /api/me flow (the second fetch fires with the first response's token
// as a Bearer header, from a real browser session).
describe.skipIf(!chromeAvailable)("flow tools e2e (login -> me chain)", () => {
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
    expect((marked.content as { type: string; text: string }[])[0]!.text).toMatch(/mark.*seq \d+/i);

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

  it("flow_export {format:'har'} produces a parseable HAR with the login and me entries", async () => {
    const res = await client.callTool({ name: "flow_export", arguments: { format: "har" } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    const har = JSON.parse(text) as { log: { entries: { request: { url: string } }[] } };
    expect(har.log.entries.length).toBeGreaterThanOrEqual(2);
    const urls = har.log.entries.map((e) => e.request.url);
    expect(urls.some((u) => u.includes("/api/login"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/me"))).toBe(true);
  });

  it("flow_export (default json) produces a summary with the login/me calls and the detected token dependency", async () => {
    const res = await client.callTool({ name: "flow_export", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    const summary = JSON.parse(text) as {
      calls: { index: number; method: string; url: string }[];
      deps: { fromCall: number; toCall: number; varName: string }[];
    };

    expect(summary.calls.length).toBeGreaterThanOrEqual(2);
    expect(summary.calls.some((c) => c.url.includes("/api/login"))).toBe(true);
    expect(summary.calls.some((c) => c.url.includes("/api/me"))).toBe(true);

    const tokenDep = summary.deps.find((d) => d.varName === "token");
    expect(tokenDep).toBeDefined();
    expect(typeof tokenDep!.fromCall).toBe("number");
    expect(typeof tokenDep!.toCall).toBe("number");
  });

  it("flow_synthesize {target:'ts'} chains the login token into the /api/me Authorization header", async () => {
    const res = await client.callTool({ name: "flow_synthesize", arguments: { target: "ts" } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;

    const fetchCount = (text.match(/fetch\(/g) ?? []).length;
    expect(fetchCount).toBeGreaterThanOrEqual(2);
    expect(text).toContain(".token");
    expect(text).toContain("Bearer ${");
    expect(text).not.toContain("T-alice");
  });

  it("flow_synthesize {target:'curl'} extracts the token via jq and chains it as a shell variable", async () => {
    const res = await client.callTool({ name: "flow_synthesize", arguments: { target: "curl" } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;

    expect(text).toContain("jq -r '.token'");
    expect(text).toMatch(/\$token\b/);
    expect(text).not.toContain("T-alice");
  });
});
