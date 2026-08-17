import { describe, it, expect } from "vitest";
import { resolveChromePath } from "../../src/session/chrome-path";

describe("resolveChromePath", () => {
  it("prefers BFA_CHROME_PATH override", () => {
    const p = resolveChromePath({ BFA_CHROME_PATH: "/custom/chrome" }, "darwin");
    expect(p).toBe("/custom/chrome");
  });

  it("returns the macOS default when no override", () => {
    const p = resolveChromePath({}, "darwin");
    expect(p).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  it("returns a linux default", () => {
    const p = resolveChromePath({}, "linux");
    expect(p).toContain("google-chrome");
  });

  it("throws on unsupported platform with a helpful message", () => {
    expect(() => resolveChromePath({}, "aix")).toThrowError(/BFA_CHROME_PATH/);
  });
});
