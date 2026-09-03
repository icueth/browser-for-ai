import { describe, it, expect } from "vitest";
import { SessionRegistry } from "../../src/session/registry";
import type { Session } from "../../src/types";

// Minimal fake — registry never touches puppeteer objects, only stores them.
function fakeSession(): Omit<Session, "id"> {
  return {
    mode: "fresh",
    incognito: false,
    browser: {} as Session["browser"],
    context: {} as Session["context"],
    page: {} as Session["page"],
    recorder: {} as Session["recorder"],
    ownsBrowser: true,
  };
}

describe("SessionRegistry", () => {
  it("assigns monotonic ids s1, s2, ...", () => {
    const r = new SessionRegistry();
    expect(r.add(fakeSession()).id).toBe("s1");
    expect(r.add(fakeSession()).id).toBe("s2");
  });

  it("the most recently added session is active; get() with no id returns it", () => {
    const r = new SessionRegistry();
    const a = r.add(fakeSession());
    expect(r.activeId()).toBe(a.id);
    const b = r.add(fakeSession());
    expect(r.activeId()).toBe(b.id);
    expect(r.get()?.id).toBe(b.id);
  });

  it("setActive changes the active session; unknown id returns false", () => {
    const r = new SessionRegistry();
    r.add(fakeSession());
    const b = r.add(fakeSession());
    expect(r.setActive(b.id)).toBe(true);
    expect(r.activeId()).toBe(b.id);
    expect(r.setActive("s99")).toBe(false);
  });

  it("remove returns the session and clears active if it was active", () => {
    const r = new SessionRegistry();
    const a = r.add(fakeSession());
    const b = r.add(fakeSession());
    r.setActive(a.id);
    expect(r.remove(a.id)?.id).toBe(a.id);
    // active falls back to a remaining session
    expect(r.activeId()).toBe(b.id);
    expect(r.get(a.id)).toBeUndefined();
  });

  it("removeAll empties the registry and returns everything", () => {
    const r = new SessionRegistry();
    r.add(fakeSession());
    r.add(fakeSession());
    expect(r.removeAll()).toHaveLength(2);
    expect(r.list()).toHaveLength(0);
    expect(r.activeId()).toBeUndefined();
  });
});

describe("active session follows the latest launch", () => {
  it("the second add() becomes active, so tools without sessionId target the session just launched", async () => {
    const { SessionRegistry } = await import("../../src/session/registry");
    const reg = new SessionRegistry();
    const fake = () => ({}) as unknown as Omit<import("../../src/types").Session, "id">;
    const s1 = reg.add(fake());
    expect(reg.activeId()).toBe(s1.id);
    const s2 = reg.add(fake());
    expect(reg.activeId()).toBe(s2.id);
    expect(reg.get()?.id).toBe(s2.id);
  });
});
