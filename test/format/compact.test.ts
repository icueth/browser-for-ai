import { describe, it, expect } from "vitest";
import { ok, fail, table, truncate } from "../../src/format/compact";

describe("compact helpers", () => {
  it("ok wraps text as a non-error tool result", () => {
    expect(ok("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
  });

  it("fail marks isError", () => {
    expect(fail("boom")).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
  });

  it("table pads columns and includes a header row", () => {
    const out = table(["id", "url"], [["s1", "http://a"], ["s2", "http://longer"]]);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^id\s+url$/);
    expect(lines[1]).toContain("s1");
    expect(lines[2]).toContain("s2");
  });

  it("truncate leaves short text and trims long text with a suffix", () => {
    expect(truncate("abc", 10)).toBe("abc");
    const long = "x".repeat(50);
    const t = truncate(long, 10);
    expect(t.startsWith("xxxxxxxxxx")).toBe(true);
    expect(t).toContain("+40c more");
  });
});
