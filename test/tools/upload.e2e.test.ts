import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

const text = (r: { [k: string]: unknown }) => (r.content as { type: string; text: string }[])[0]!.text;

describe.skipIf(!chromeAvailable)("page_upload e2e", () => {
  let fixture: Fixture;
  let mgr: SessionManager;
  let client: Client;
  let dir: string;
  let filePath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "bfa-upload-"));
    filePath = join(dir, "resume.txt");
    writeFileSync(filePath, "hello upload");

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
    rmSync(dir, { recursive: true, force: true });
  });

  it("attaches a real file to the <input type=file>, verifiable from the page", async () => {
    const up = await client.callTool({
      name: "page_upload",
      arguments: { selector: "#fileup", files: [filePath] },
    });
    expect(up.isError).toBeFalsy();
    expect(text(up)).toContain("attached 1 file(s)");

    // The page itself must now see the file on the input — proves it really landed.
    const seen = await client.callTool({
      name: "page_eval",
      arguments: {
        expression:
          "(()=>{const f=document.getElementById('fileup').files;return JSON.stringify({n:f.length,name:f[0]&&f[0].name});})()",
      },
    });
    expect(seen.isError).toBeFalsy();
    const parsed = JSON.parse(JSON.parse(text(seen))) as { n: number; name: string };
    expect(parsed.n).toBe(1);
    expect(parsed.name).toBe("resume.txt");
  });

  it("fails clearly when a path does not exist", async () => {
    const up = await client.callTool({
      name: "page_upload",
      arguments: { selector: "#fileup", files: [join(dir, "nope.txt")] },
    });
    expect(up.isError).toBeTruthy();
    expect(text(up)).toContain("not found");
  });
});
