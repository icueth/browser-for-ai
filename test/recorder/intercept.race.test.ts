import { describe, it, expect, vi } from "vitest";
import type { Page } from "puppeteer-core";
import { Interceptor } from "../../src/recorder/intercept";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function fakeClient() {
  return { on: vi.fn(), send: vi.fn(async () => ({})), detach: vi.fn(async () => {}) };
}

describe("Interceptor enable/disable race", () => {
  it("a clear() that lands while enable() is still connecting wins: Fetch never ends up ON with zero rules", async () => {
    const c1 = fakeClient();
    const d1 = deferred<typeof c1>();
    const page = { createCDPSession: vi.fn(() => d1.promise) } as unknown as Page;
    const ic = new Interceptor(page);

    ic.add({ urlPattern: "/a", action: "block" } as Parameters<Interceptor["add"]>[0]);
    const enabling = ic.enable(); // pending on createCDPSession
    await ic.clear(); // rules → [], gen bumped, nothing published yet
    d1.resolve(c1); // connection completes AFTER the clear
    await enabling;

    expect(ic.list()).toEqual([]);
    expect((ic as unknown as { client: unknown }).client).toBeNull();
    expect(c1.detach).toHaveBeenCalled();
    expect(c1.send).not.toHaveBeenCalledWith("Fetch.enable", expect.anything());
  });

  it("add → clear → add pipelined: the surviving rule IS served by a fresh session", async () => {
    const c1 = fakeClient();
    const c2 = fakeClient();
    const d1 = deferred<typeof c1>();
    const createCDPSession = vi.fn().mockReturnValueOnce(d1.promise).mockResolvedValueOnce(c2);
    const page = { createCDPSession } as unknown as Page;
    const ic = new Interceptor(page);

    ic.add({ urlPattern: "/a", action: "block" } as Parameters<Interceptor["add"]>[0]);
    const first = ic.enable();
    await ic.clear();
    ic.add({ urlPattern: "/b", action: "block" } as Parameters<Interceptor["add"]>[0]);
    const second = ic.enable(); // joins the in-flight attempt, then re-arms because a rule remains
    d1.resolve(c1);
    await Promise.all([first, second]);

    expect(ic.list().map((r) => r.urlPattern)).toEqual(["/b"]);
    expect(c1.detach).toHaveBeenCalled();
    expect(c2.send).toHaveBeenCalledWith("Fetch.enable", {});
    expect((ic as unknown as { client: unknown }).client).toBe(c2);
  });
});
