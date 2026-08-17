import { describe, it, expect } from "vitest";
import { assertExactlyOne, describeTarget } from "../../src/tools/refs";

describe("refs (pure helpers)", () => {
  it("describeTarget formats a ref target", () => {
    expect(describeTarget({ ref: "e3" })).toBe('ref "e3"');
  });

  it("describeTarget formats a selector target", () => {
    expect(describeTarget({ selector: ".x" })).toBe('selector ".x"');
  });

  it("assertExactlyOne throws when neither ref nor selector is set", () => {
    expect(() => assertExactlyOne({}, "page_click")).toThrow(
      "page_click: provide exactly one of ref/selector",
    );
  });

  it("assertExactlyOne throws when both ref and selector are set", () => {
    expect(() => assertExactlyOne({ ref: "e1", selector: ".x" }, "page_click")).toThrow(
      "page_click: provide exactly one of ref/selector",
    );
  });

  it("assertExactlyOne passes when exactly one of ref/selector is set", () => {
    expect(() => assertExactlyOne({ ref: "e1" }, "page_click")).not.toThrow();
    expect(() => assertExactlyOne({ selector: ".x" }, "page_click")).not.toThrow();
  });
});
