import { describe, it, expect } from "vitest";
import { NetworkBuffer } from "../../src/recorder/network";
import { ConsoleBuffer } from "../../src/recorder/console";

const req = (id: string) =>
  ({ requestId: id, type: "Fetch", request: { url: `https://x.test/${id}`, method: "GET", headers: {}, hasPostData: false } }) as never;

describe("recorder buffers are bounded (long sessions must not grow without limit)", () => {
  it("NetworkBuffer keeps the newest 3000 requests and evicts the oldest", () => {
    const b = new NetworkBuffer();
    for (let i = 0; i < 3100; i++) b.requestWillBeSent(i + 1, req(`r${i}`));
    const ids = new Set(b.list().map((e) => e.id)); // by id — get() also matches url substrings
    expect(ids.size).toBe(3000);
    expect(ids.has("r0")).toBe(false); // evicted
    expect(ids.has("r99")).toBe(false);
    expect(ids.has("r100")).toBe(true); // oldest survivor
    expect(ids.has("r3099")).toBe(true); // newest
  });

  it("a redirect (same requestId again) does not double-count in the ring", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, req("a"));
    b.requestWillBeSent(2, { ...(req("a") as object), redirectResponse: { url: "https://x.test/a", status: 302 } } as never);
    expect(b.list().length).toBe(1);
    expect(b.get("a")?.redirects?.length).toBe(1);
  });

  it("WebSocket frames per socket are capped at 500 and oversized payloads are truncated", () => {
    const b = new NetworkBuffer();
    b.webSocketCreated(1, { requestId: "ws1", url: "wss://x.test/ws" } as never);
    for (let i = 0; i < 600; i++) b.webSocketFrame(i + 2, "recv", { requestId: "ws1", response: { opcode: 1, payloadData: `f${i}` } } as never);
    const w = b.wsList()[0]!;
    expect(w.frames.length).toBe(500);
    expect(w.frames[0]!.payload).toBe("f100"); // oldest 100 dropped
    b.webSocketFrame(700, "recv", { requestId: "ws1", response: { opcode: 1, payloadData: "x".repeat(10000) } } as never);
    const last = w.frames[w.frames.length - 1]!;
    expect(last.payload.length).toBeLessThan(4200);
    expect(last.payload).toContain("(+5904 chars)");
  });

  it("WebSocket connections are capped at 200", () => {
    const b = new NetworkBuffer();
    for (let i = 0; i < 250; i++) b.webSocketCreated(i + 1, { requestId: `ws${i}`, url: "wss://x.test" } as never);
    expect(b.wsList().length).toBe(200);
    expect(b.wsList()[0]!.id).toBe("ws50");
  });

  it("ConsoleBuffer keeps the newest 2000 distinct messages and still dedupes repeats", () => {
    const c = new ConsoleBuffer();
    for (let i = 0; i < 2100; i++) c.consoleAPICalled(i + 1, { type: "log", args: [{ type: "string", value: `m${i}` }] } as never);
    expect(c.list().length).toBe(2000);
    expect(c.list()[0]!.text).toBe("m100");
    c.consoleAPICalled(5000, { type: "log", args: [{ type: "string", value: "m2099" }] } as never);
    const last = c.list().find((e) => e.text === "m2099")!;
    expect(last.count).toBe(2); // dedupe survives eviction bookkeeping
    expect(c.list().length).toBe(2000);
  });
});
