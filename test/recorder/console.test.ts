import { describe, it, expect } from "vitest";
import { ConsoleBuffer } from "../../src/recorder/console";

describe("ConsoleBuffer", () => {
  it("records console.log/error with level and text", () => {
    const b = new ConsoleBuffer();
    b.consoleAPICalled(1, { type: "log", args: [{ type: "string", value: "hello" }] });
    b.consoleAPICalled(2, { type: "error", args: [{ type: "string", value: "boom" }] });
    expect(b.list().map((e) => `${e.level}:${e.text}`)).toEqual(["log:hello", "error:boom"]);
  });

  it("dedupes repeats and counts them, keeping latest seq", () => {
    const b = new ConsoleBuffer();
    b.consoleAPICalled(1, { type: "warn", args: [{ type: "string", value: "again" }] });
    b.consoleAPICalled(2, { type: "warn", args: [{ type: "string", value: "again" }] });
    b.consoleAPICalled(9, { type: "warn", args: [{ type: "string", value: "again" }] });
    const rows = b.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ level: "warn", text: "again", count: 3, seq: 9 });
  });

  it("captures exceptionThrown as an error with stack", () => {
    const b = new ConsoleBuffer();
    b.exceptionThrown(1, { exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is not a function\n  at f (a.js:2:3)" }, url: "a.js", lineNumber: 1 } });
    const err = b.errors();
    expect(err).toHaveLength(1);
    expect(err[0]!.level).toBe("error");
    expect(err[0]!.stack).toContain("TypeError");
  });

  it("errors() returns error + warning levels only", () => {
    const b = new ConsoleBuffer();
    b.consoleAPICalled(1, { type: "log", args: [{ type: "string", value: "info" }] });
    b.consoleAPICalled(2, { type: "error", args: [{ type: "string", value: "e1" }] });
    b.consoleAPICalled(3, { type: "warning", args: [{ type: "string", value: "w1" }] });
    expect(b.errors().map((e) => e.text).sort()).toEqual(["e1", "w1"]);
  });
});
