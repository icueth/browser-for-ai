import { describe, it, expect } from "vitest";
import { summarizeEvalResult } from "../../src/tools/delta";

// Pure test (no Chrome): summarizeEvalResult must never throw, whatever page JS returns.
describe("summarizeEvalResult", () => {
  it("JSON-summarizes a plain string", () => {
    const out = summarizeEvalResult("BFA Fixture");
    expect(out).toContain("BFA Fixture");
    expect(typeof out).toBe("string");
  });

  it("reports undefined explicitly", () => {
    expect(summarizeEvalResult(undefined)).toBe("undefined");
  });

  it("falls back to String() for a BigInt (JSON.stringify would throw)", () => {
    let out = "";
    expect(() => {
      out = summarizeEvalResult(10n);
    }).not.toThrow();
    expect(out).toBe("10");
  });

  it("falls back to String() for a circular object without throwing", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    let out = "";
    expect(() => {
      out = summarizeEvalResult(a);
    }).not.toThrow();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("truncates an oversized result to the 2000-char cap", () => {
    const big = "x".repeat(5000);
    const out = summarizeEvalResult(big);
    expect(out).toContain("more");
    expect(out.length).toBeLessThan(big.length);
  });
});
