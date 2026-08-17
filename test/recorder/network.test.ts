import { describe, it, expect } from "vitest";
import { NetworkBuffer } from "../../src/recorder/network";

const REQ = (id: string, url: string, method = "GET", type = "XHR") => ({
  requestId: id, type, initiator: { type: "script" },
  request: { url, method, headers: { accept: "application/json" }, hasPostData: false },
});
const RES = (id: string, status: number, mimeType = "application/json") => ({
  requestId: id, type: "XHR",
  response: { status, statusText: status === 200 ? "OK" : "ERR", headers: { "content-type": mimeType }, mimeType, fromDiskCache: false },
});

describe("NetworkBuffer", () => {
  it("records a request→response→finished lifecycle and lists it", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, REQ("r1", "https://x/api/a"));
    b.responseReceived(RES("r1", 200));
    b.loadingFinished({ requestId: "r1", encodedDataLength: 123 });
    const rows = b.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ id: "r1", method: "GET", status: 200, finished: true, failed: false });
    expect(b.get("r1")?.encodedDataLength).toBe(123);
  });

  it("get() matches by id or by url substring", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, REQ("r1", "https://x/api/login"));
    expect(b.get("r1")?.id).toBe("r1");
    expect(b.get("login")?.id).toBe("r1");
  });

  it("failures() returns 4xx/5xx and loadingFailed entries only", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, REQ("ok", "https://x/ok")); b.responseReceived(RES("ok", 200)); b.loadingFinished({ requestId: "ok" });
    b.requestWillBeSent(2, REQ("bad", "https://x/bad")); b.responseReceived(RES("bad", 500)); b.loadingFinished({ requestId: "bad" });
    b.requestWillBeSent(3, REQ("dead", "https://x/dead")); b.loadingFailed({ requestId: "dead", errorText: "net::ERR_FAILED", blockedReason: undefined });
    const f = b.failures().map((e) => e.id).sort();
    expect(f).toEqual(["bad", "dead"]);
  });

  it("pending() returns requests started but not finished/failed", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, REQ("hang", "https://x/hang"));
    b.requestWillBeSent(2, REQ("done", "https://x/done")); b.responseReceived(RES("done", 200)); b.loadingFinished({ requestId: "done" });
    expect(b.pending(3).map((e) => e.id)).toEqual(["hang"]);
  });

  it("filters by onlyXhr and urlIncludes", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, REQ("a", "https://x/api/a", "GET", "XHR"));
    b.requestWillBeSent(2, REQ("img", "https://x/logo.png", "GET", "Image"));
    expect(b.list({ onlyXhr: true }).map((e) => e.id)).toEqual(["a"]);
    expect(b.list({ urlIncludes: "logo" }).map((e) => e.id)).toEqual(["img"]);
  });

  it("captures websocket frames in order", () => {
    const b = new NetworkBuffer();
    b.webSocketCreated(1, { requestId: "w1", url: "wss://x/ws" });
    b.webSocketFrame(2, "sent", { requestId: "w1", response: { opcode: 1, payloadData: "hello" } });
    b.webSocketFrame(3, "recv", { requestId: "w1", response: { opcode: 1, payloadData: "world" } });
    const ws = b.wsList();
    expect(ws).toHaveLength(1);
    expect(ws[0]!.frames.map((f) => `${f.dir}:${f.payload}`)).toEqual(["sent:hello", "recv:world"]);
  });

  it("sinceSeq returns only entries newer than a mark", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, REQ("old", "https://x/old"));
    b.requestWillBeSent(5, REQ("new", "https://x/new"));
    expect(b.sinceSeq(3).map((e) => e.id)).toEqual(["new"]);
  });

  it("preserves a single redirect hop", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, REQ("r1", "https://x/login"));
    b.requestWillBeSent(2, {
      requestId: "r1", type: "Document",
      request: { url: "https://x/home", method: "GET", headers: {} },
      redirectResponse: { url: "https://x/login", status: 302 },
    });
    const entry = b.get("r1")!;
    expect(entry.redirects).toEqual([{ url: "https://x/login", status: 302 }]);
    expect(entry.url).toBe("https://x/home");
  });

  it("accumulates a multi-hop redirect chain in order", () => {
    const b = new NetworkBuffer();
    b.requestWillBeSent(1, REQ("r1", "https://x/login"));
    b.requestWillBeSent(2, {
      requestId: "r1", type: "Document",
      request: { url: "https://x/step2", method: "GET", headers: {} },
      redirectResponse: { url: "https://x/login", status: 302 },
    });
    b.requestWillBeSent(3, {
      requestId: "r1", type: "Document",
      request: { url: "https://x/home", method: "GET", headers: {} },
      redirectResponse: { url: "https://x/step2", status: 302 },
    });
    const entry = b.get("r1")!;
    expect(entry.redirects).toEqual([
      { url: "https://x/login", status: 302 },
      { url: "https://x/step2", status: 302 },
    ]);
    expect(entry.url).toBe("https://x/home");
  });
});
