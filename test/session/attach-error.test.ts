import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/session/manager";

// No Chrome needed: attaching to a port nothing listens on must fail fast with actionable guidance,
// not puppeteer's opaque "fetch failed".
describe("attach error is self-explanatory", () => {
  it("tells the caller exactly how to start a debug-port Chrome", async () => {
    const mgr = new SessionManager();
    const err = (await mgr.launch({ mode: "attach", port: 65533 }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("no Chrome debug endpoint on port 65533");
    expect(err.message).toContain("bfa-chrome");
    expect(err.message).toMatch(/Chrome 136\+/);
  });
});
