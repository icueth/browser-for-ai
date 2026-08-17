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

// Task 3.1 (page_click_at + page_drag, coordinate interaction) assertions.
describe.skipIf(!chromeAvailable)("mouse tools e2e (page_click_at, page_drag)", () => {
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

  it("page_click_at clicks a raw coordinate on the pad — the click delta reports it, and the pad's own handler records offset coords within its bounds", async () => {
    const rect = await client.callTool({
      name: "page_eval",
      arguments: {
        expression:
          "(()=>{const r=document.getElementById('pad').getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:r.width,h:r.height});})()",
      },
    });
    expect(rect.isError).toBeFalsy();
    const rectText = (rect.content as { type: string; text: string }[])[0]!.text;
    const parsed = JSON.parse(JSON.parse(rectText)) as { x: number; y: number; w: number; h: number };

    const clicked = await client.callTool({
      name: "page_click_at",
      arguments: { x: parsed.x, y: parsed.y },
    });
    expect(clicked.isError).toBeFalsy();
    const clickedText = (clicked.content as { type: string; text: string }[])[0]!.text;
    expect(clickedText).toContain(`clicked at (${parsed.x}, ${parsed.y})`);

    const result = await client.callTool({
      name: "page_eval",
      arguments: { expression: "document.getElementById('result').textContent" },
    });
    expect(result.isError).toBeFalsy();
    const resultText = (result.content as { type: string; text: string }[])[0]!.text;
    expect(resultText).toContain("pad:");

    // Extract the offsetX,offsetY the pad's own click handler recorded and confirm
    // they landed inside the pad's own bounding box — proves the coordinate click
    // actually hit the pad, not just that some element somewhere received a click.
    const match = resultText.match(/pad:(\d+),(\d+)/);
    if (!match) throw new Error(`expected result to contain "pad:X,Y", got: ${resultText}`);
    const offsetX = Number(match[1]);
    const offsetY = Number(match[2]);
    expect(offsetX).toBeGreaterThanOrEqual(0);
    expect(offsetX).toBeLessThanOrEqual(parsed.w);
    expect(offsetY).toBeGreaterThanOrEqual(0);
    expect(offsetY).toBeLessThanOrEqual(parsed.h);
  });

  it("page_drag returns isError:false and reports the drag in its note", async () => {
    const dragged = await client.callTool({
      name: "page_drag",
      arguments: { fromX: 20, fromY: 20, toX: 150, toY: 100 },
    });
    expect(dragged.isError).toBeFalsy();
    const draggedText = (dragged.content as { type: string; text: string }[])[0]!.text;
    expect(draggedText).toContain("dragged (20,20)→(150,100)");
  });
});
