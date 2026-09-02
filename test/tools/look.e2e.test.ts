import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import type { SessionManager } from "../../src/session/manager";
import { resolveChromePath } from "../../src/session/chrome-path";
import { createServer } from "../../src/server";
import { pngSize } from "../../src/tools/screenshot";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startFixture, type Fixture } from "../fixtures/server";

let chromeAvailable = false;
try {
  chromeAvailable = existsSync(resolveChromePath());
} catch {
  chromeAvailable = false;
}

type Block = { type: string; text?: string; data?: string; mimeType?: string };
const blocks = (r: { [k: string]: unknown }) => r.content as Block[];
const textOf = (r: { [k: string]: unknown }) => blocks(r).find((b) => b.type === "text")?.text ?? "";
const imageOf = (r: { [k: string]: unknown }) => blocks(r).find((b) => b.type === "image");

// The hard case on purpose: an emulated HiDPI viewport (dpr 2), where a naive screenshot is 2x the
// CSS size and "look at the image, click there" silently lands in the wrong place.
const VW = 800;
const VH = 600;

describe.skipIf(!chromeAvailable)("vision: page_screenshot 1:1 + page_look (Set-of-Mark)", () => {
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
    await client.callTool({
      name: "browser_launch",
      arguments: { mode: "fresh", headless: true, url: fixture.url, viewport: { width: VW, height: VH, deviceScaleFactor: 2 } },
    });
    await new Promise((r) => setTimeout(r, 400));
  });

  afterAll(async () => {
    await mgr.shutdown();
    await fixture.close();
  });

  it("page_screenshot is 1:1 with CSS px even at dpr 2, and says so", async () => {
    const res = await client.callTool({ name: "page_screenshot", arguments: {} });
    expect(res.isError).toBeFalsy();
    const img = imageOf(res)!;
    expect(img.mimeType).toBe("image/png");
    const size = pngSize(img.data!);
    expect(size.width).toBe(VW); // NOT 1600
    expect(size.height).toBe(VH);
    expect(textOf(res)).toContain("1:1");
  });

  it("page_screenshot fullRes:true keeps native device pixels (2x)", async () => {
    const res = await client.callTool({ name: "page_screenshot", arguments: { fullRes: true } });
    expect(res.isError).toBeFalsy();
    expect(pngSize(imageOf(res)!.data!).width).toBe(VW * 2);
    expect(textOf(res)).toContain("scale 2");
  });

  it("page_screenshot of one element is 1:1 and reports the element's page offset", async () => {
    const res = await client.callTool({ name: "page_screenshot", arguments: { selector: "#submit" } });
    expect(res.isError).toBeFalsy();
    const size = pngSize(imageOf(res)!.data!);
    // the fixture's Login button is a small control — far narrower than the viewport, and 1:1
    expect(size.width).toBeGreaterThan(10);
    expect(size.width).toBeLessThan(VW / 2);
    expect(textOf(res)).toMatch(/element origin at page \(\d+, \d+\)/);
  });

  it("page_look returns a marked 1:1 image + legend whose refs really click, and leaves no overlay", async () => {
    const res = await client.callTool({ name: "page_look", arguments: {} });
    expect(res.isError).toBeFalsy();
    const legend = textOf(res);
    expect(legend).toMatch(/^\d+ marked \(badge N = ref eN\)/);
    expect(legend).toContain("Login"); // the submit button is marked
    expect(pngSize(imageOf(res)!.data!).width).toBe(VW); // normalized like page_screenshot

    // the badge numbers are real refs: the Login line's ref must resolve for a click
    const loginLine = legend.split("\n").find((l) => l.includes("Login"))!;
    const ref = loginLine.match(/\[(e\d+)\]/)![1];
    const clicked = await client.callTool({ name: "page_click", arguments: { ref } });
    expect(clicked.isError).toBeFalsy();

    // the overlay must be gone — page_look never leaves marks on the page
    const left = await client.callTool({ name: "page_eval", arguments: { expression: "!!document.getElementById('__bfa_marks')" } });
    expect(textOf(left)).toBe("false");
  });

  it("page_look with a text filter marks only the matching element", async () => {
    const res = await client.callTool({ name: "page_look", arguments: { text: "Login" } });
    expect(res.isError).toBeFalsy();
    const legend = textOf(res);
    expect(legend).toMatch(/^1 marked/);
    expect(legend).toContain("Login");
  });

  it("page_look / page_screenshot capture the CURRENT viewport when scrolled (clip is document-relative)", async () => {
    // make the page tall, add a button far below the fold, scroll to it
    await client.callTool({
      name: "page_eval",
      arguments: {
        expression:
          "(()=>{const s=document.createElement('div');s.style.height='3000px';document.body.appendChild(s);const b=document.createElement('button');b.id='deep';b.textContent='DeepButton';document.body.appendChild(b);return 'ok';})()",
      },
    });
    await client.callTool({ name: "page_scroll", arguments: { selector: "#deep" } });

    const res = await client.callTool({ name: "page_look", arguments: {} });
    expect(res.isError).toBeFalsy();
    const legend = textOf(res);
    expect(legend).toContain("DeepButton"); // visible after scrolling → marked
    expect(legend).not.toContain("Login"); // the top form is 3000px above → off-screen → not marked
    expect(pngSize(imageOf(res)!.data!).width).toBe(VW);

    // a plain screenshot at this scroll position is the current viewport (not the doc top, no throw)
    const shot = await client.callTool({ name: "page_screenshot", arguments: {} });
    expect(shot.isError).toBeFalsy();
    expect(pngSize(imageOf(shot)!.data!)).toEqual({ width: VW, height: VH });
  });
});
