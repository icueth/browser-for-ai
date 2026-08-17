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

// Task 2.2 (page_snapshot + ref resolver + fixture form) assertions.
describe.skipIf(!chromeAvailable)("interact tools e2e (page_snapshot)", () => {
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
    await new Promise((r) => setTimeout(r, 500));
  });

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  });

  it("page_snapshot lists the login form's interactive elements with refs", async () => {
    const res = await client.callTool({ name: "page_snapshot", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;

    expect(text).toMatch(/\[e\d+\] button "Login"/);
    expect(text).toMatch(/\[e\d+\] input\(text\) "user"/);
    expect(text).toMatch(/\[e\d+\] input\(password\) "pass"/);
  });

  // Task 2.3 (page_click + page_type, delta-reporting) assertions.
  it("page_type fills the login form and page_click submits it — the click delta captures the new /api/login request", async () => {
    const typedUser = await client.callTool({
      name: "page_type",
      arguments: { selector: "input[name=user]", text: "alice" },
    });
    expect(typedUser.isError).toBeFalsy();
    const typedUserText = (typedUser.content as { type: string; text: string }[])[0]!.text;
    expect(typedUserText).toContain("typed 5 chars into selector");

    const typedPass = await client.callTool({
      name: "page_type",
      arguments: { selector: "input[name=pass]", text: "secret" },
    });
    expect(typedPass.isError).toBeFalsy();

    const clicked = await client.callTool({
      name: "page_click",
      arguments: { selector: "#submit", waitMs: 800 },
    });
    expect(clicked.isError).toBeFalsy();
    const clickedText = (clicked.content as { type: string; text: string }[])[0]!.text;

    expect(clickedText.length).toBeGreaterThan(0);
    expect(clickedText).toContain("clicked");
    expect(clickedText).toContain("/api/login");
  });

  // Proves the headline Phase 2 contract end-to-end: a ref assigned by page_snapshot
  // (data-bfa-ref="eN") actually resolves through resolveTarget's [data-bfa-ref="eN"] query
  // and drives a real click — not just the negative/not-found case below.
  it("page_click resolves a ref parsed from page_snapshot and clicks it — the ref round-trip contract", async () => {
    const snap = await client.callTool({ name: "page_snapshot", arguments: {} });
    expect(snap.isError).toBeFalsy();
    const snapText = (snap.content as { type: string; text: string }[])[0]!.text;

    const match = snapText.match(/^\[(e\d+)\] button "Login"/m);
    if (!match) {
      throw new Error(`ref round-trip test: no ref found for the Login button in snapshot output:\n${snapText}`);
    }
    const loginRef = match[1]!;

    // The user/pass fields still hold "alice"/"secret" from the previous test, so clicking
    // the (real, DOM-resolved) Login button submits the form and hits /api/login again.
    const clicked = await client.callTool({
      name: "page_click",
      arguments: { ref: loginRef, waitMs: 800 },
    });
    expect(clicked.isError).toBeFalsy();
    const clickedText = (clicked.content as { type: string; text: string }[])[0]!.text;
    expect(clickedText.length).toBeGreaterThan(0);
    expect(clickedText).toContain("clicked");
    expect(clickedText).toContain(`ref "${loginRef}"`);
    expect(clickedText).toContain("/api/login");
  });

  it("page_click with an unresolvable ref returns isError with a clear message", async () => {
    const res = await client.callTool({ name: "page_click", arguments: { ref: "e999" } });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/e999/);
  });

  // Task 2.4 (page_fill + page_select + page_key) assertions.
  it("page_fill fills multiple fields, page_select sets the plan, and page_key submits the form", async () => {
    const filled = await client.callTool({
      name: "page_fill",
      arguments: {
        fields: [
          { selector: "input[name=user]", value: "bob" },
          { selector: "input[name=pass]", value: "pw" },
        ],
      },
    });
    expect(filled.isError).toBeFalsy();
    const filledText = (filled.content as { type: string; text: string }[])[0]!.text;
    expect(filledText).toContain("filled 2 fields");

    const selected = await client.callTool({
      name: "page_select",
      arguments: { selector: "select[name=plan]", value: "pro" },
    });
    expect(selected.isError).toBeFalsy();
    const selectedText = (selected.content as { type: string; text: string }[])[0]!.text;
    expect(selectedText).toContain("selected");
    expect(selectedText).toContain("pro");

    // Verify the select actually changed the DOM value (not just that the tool didn't throw).
    const checked = await client.callTool({
      name: "page_observe",
      arguments: {
        action: { kind: "eval", expression: "document.querySelector('select[name=plan]').value" },
      },
    });
    expect(checked.isError).toBeFalsy();
    const checkedText = (checked.content as { type: string; text: string }[])[0]!.text;
    expect(checkedText).toContain('"pro"');

    // Focus an input, then press Enter — the fixture form submits on Enter (default HTML
    // behavior with a single-line text input and a submit button), hitting /api/login again.
    const focused = await client.callTool({
      name: "page_click",
      arguments: { selector: "input[name=user]" },
    });
    expect(focused.isError).toBeFalsy();

    const keyed = await client.callTool({
      name: "page_key",
      arguments: { keys: "Enter", waitMs: 800 },
    });
    expect(keyed.isError).toBeFalsy();
    const keyedText = (keyed.content as { type: string; text: string }[])[0]!.text;
    expect(keyedText).toContain("pressed Enter");
    expect(keyedText).toContain("/api/login");
  });

  // Task 2.5 (page_hover + page_scroll) assertions.
  it("page_hover hovers an element and reports a delta without error", async () => {
    const hovered = await client.callTool({
      name: "page_hover",
      arguments: { selector: "#submit" },
    });
    expect(hovered.isError).toBeFalsy();
    const hoveredText = (hovered.content as { type: string; text: string }[])[0]!.text;
    expect(hoveredText).toContain("hovered");
  });

  it("page_scroll with dy scrolls the window by a pixel offset", async () => {
    const scrolled = await client.callTool({
      name: "page_scroll",
      arguments: { dy: 400 },
    });
    expect(scrolled.isError).toBeFalsy();
    const scrolledText = (scrolled.content as { type: string; text: string }[])[0]!.text;
    expect(scrolledText).toContain("scrolled by");
  });

  it("page_scroll with a target scrolls the element into view", async () => {
    const scrolled = await client.callTool({
      name: "page_scroll",
      arguments: { selector: "#submit" },
    });
    expect(scrolled.isError).toBeFalsy();
    const scrolledText = (scrolled.content as { type: string; text: string }[])[0]!.text;
    expect(scrolledText).toContain("scrolled");

    const checked = await client.callTool({
      name: "page_observe",
      arguments: {
        action: {
          kind: "eval",
          expression:
            "(()=>{const r=document.querySelector('#submit').getBoundingClientRect();return r.top>=0 && r.top<=window.innerHeight})()",
        },
      },
    });
    expect(checked.isError).toBeFalsy();
    const checkedText = (checked.content as { type: string; text: string }[])[0]!.text;
    expect(checkedText).toContain("true");
  });

  // Task 2.6 (page_eval standalone extraction tool) assertions.
  it("page_eval evaluates document.title", async () => {
    const res = await client.callTool({
      name: "page_eval",
      arguments: { expression: "document.title" },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("BFA Fixture");
  });

  it("page_eval evaluates a numeric expression", async () => {
    const res = await client.callTool({
      name: "page_eval",
      arguments: { expression: "1+2" },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("3");
  });

  it("page_eval returns isError (not a crash) when the expression throws", async () => {
    const res = await client.callTool({
      name: "page_eval",
      arguments: { expression: "throw new Error('boom')" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text.length).toBeGreaterThan(0);
  });

  // Task phase2-fix I3 (dialog auto-dismiss) assertion. Without the page.on("dialog", ...)
  // handler in SessionManager, this confirm() would open a native dialog and puppeteer would
  // block forever waiting for it to resolve — the tool call (and this test, under vitest's
  // 30s testTimeout) would hang instead of failing fast. dismiss() resolves confirm() to false.
  it("page_eval evaluating confirm() does not hang — the dialog is auto-dismissed", async () => {
    const res = await client.callTool({
      name: "page_eval",
      arguments: { expression: "confirm('are you sure?')" },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("false");
  });

  // Task 2.7 (page_screenshot image content) assertions.
  it("page_screenshot with no target returns a full-page PNG image", async () => {
    const res = await client.callTool({ name: "page_screenshot", arguments: {} });
    expect(res.isError).toBeFalsy();
    const content = res.content as { type: string; mimeType?: string; data?: string }[];
    expect(content[0]!.type).toBe("image");
    expect(content[0]!.mimeType).toBe("image/png");
    expect(typeof content[0]!.data).toBe("string");
    expect((content[0]!.data as string).length).toBeGreaterThan(100);
  });

  it("page_screenshot with a selector returns an image of just that element", async () => {
    const res = await client.callTool({ name: "page_screenshot", arguments: { selector: "#submit" } });
    expect(res.isError).toBeFalsy();
    const content = res.content as { type: string; mimeType?: string; data?: string }[];
    expect(content[0]!.type).toBe("image");
    expect(content[0]!.mimeType).toBe("image/png");
    expect(typeof content[0]!.data).toBe("string");
    expect((content[0]!.data as string).length).toBeGreaterThan(100);
  });

  it("page_screenshot with an unresolvable ref returns isError with a clear text message (not an image)", async () => {
    const res = await client.callTool({ name: "page_screenshot", arguments: { ref: "e999" } });
    expect(res.isError).toBe(true);
    const content = res.content as { type: string; text?: string }[];
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text!.length).toBeGreaterThan(0);
    expect(content[0]!.text).toMatch(/e999/);
  });
});
