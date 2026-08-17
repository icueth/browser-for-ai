import { describe, it, expect } from "vitest";
import { NetworkBuffer } from "../../src/recorder/network";

// Minimal shapes — the buffer only reads these fields.
const req = (id: string, headers: Record<string, string>) =>
  ({ requestId: id, type: "Fetch", request: { url: "https://api.example.com/pay", method: "POST", headers, hasPostData: true } }) as never;
const res = (id: string, headers: Record<string, string>) =>
  ({ requestId: id, response: { status: 200, statusText: "OK", headers, mimeType: "application/json" } }) as never;

describe("NetworkBuffer — ExtraInfo header merge (complete wire headers)", () => {
  it("merges request ExtraInfo (Cookie + network-added) arriving AFTER requestWillBeSent", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, req("r1", { "x-api-key": "abc", authorization: "Bearer t" }));
    b.requestWillBeSentExtraInfo({ requestId: "r1", headers: { cookie: "sid=9; csrf=z", "x-api-key": "abc" } } as never);
    const e = b.get("r1")!;
    expect(e.requestHeaders["cookie"]).toBe("sid=9; csrf=z");
    expect(e.requestHeaders["x-api-key"]).toBe("abc");
    expect(e.requestHeaders["authorization"]).toBe("Bearer t");
  });

  it("applies request ExtraInfo that arrives BEFORE requestWillBeSent (stashed, then merged)", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSentExtraInfo({ requestId: "r2", headers: { cookie: "sid=1" } } as never);
    b.requestWillBeSent(1, req("r2", { authorization: "Bearer t" }));
    const e = b.get("r2")!;
    expect(e.requestHeaders["cookie"]).toBe("sid=1");
    expect(e.requestHeaders["authorization"]).toBe("Bearer t");
  });

  it("merges response ExtraInfo (raw Set-Cookie / trace headers) even when it precedes responseReceived", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, req("r3", {}));
    b.responseReceivedExtraInfo({ requestId: "r3", headers: { "set-cookie": "a=1\nb=2", "x-trace": "T" } } as never);
    b.responseReceived(res("r3", { "content-type": "application/json" }));
    const e = b.get("r3")!;
    expect(e.responseHeaders!["set-cookie"]).toBe("a=1\nb=2");
    expect(e.responseHeaders!["x-trace"]).toBe("T");
    expect(e.responseHeaders!["content-type"]).toBe("application/json");
  });

  it("does not duplicate a header that differs only in case", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, req("r4", { Authorization: "Bearer t" }));
    b.requestWillBeSentExtraInfo({ requestId: "r4", headers: { authorization: "Bearer NEW" } } as never);
    const e = b.get("r4")!;
    const authKeys = Object.keys(e.requestHeaders).filter((k) => k.toLowerCase() === "authorization");
    expect(authKeys).toHaveLength(1);
    // ExtraInfo (the on-the-wire value) wins, under base's original casing.
    expect(e.requestHeaders["Authorization"]).toBe("Bearer NEW");
  });

  it("ignores ExtraInfo with no headers", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, req("r5", { authorization: "Bearer t" }));
    b.requestWillBeSentExtraInfo({ requestId: "r5" } as never);
    expect(b.get("r5")!.requestHeaders["authorization"]).toBe("Bearer t");
  });
});
