import { describe, it, expect } from "vitest";
import { buildFlow } from "../../src/flow/model";

describe("buildFlow", () => {
  it("parses JSON request/response and extracts produced values", () => {
    const m = buildFlow([{
      method: "POST", url: "https://x/api/login",
      reqHeaders: { "content-type": "application/json" }, reqBody: '{"user":"alice"}',
      status: 200, resHeaders: { "content-type": "application/json", "set-cookie": "sid=abc123; Path=/" },
      resBody: '{"ok":true,"token":"T-alice-9"}',
    }]);
    const c = m.calls[0]!;
    expect(c.reqJson).toEqual({ user: "alice" });
    expect(c.resJson).toMatchObject({ token: "T-alice-9" });
    expect(c.produced.some((p) => p.source === "json:$.token" && p.value === "T-alice-9")).toBe(true);
    expect(c.produced.some((p) => p.source === "cookie:sid" && p.value === "abc123")).toBe(true);
  });

  it("extracts consumed values from later request (auth header, query, body)", () => {
    const m = buildFlow([{
      method: "GET", url: "https://x/api/me?ref=T-alice-9",
      reqHeaders: { authorization: "Bearer T-alice-9", cookie: "sid=abc123" }, status: 200,
      resHeaders: {}, resBody: "",
    }]);
    const c = m.calls[0]!;
    expect(c.consumed.some((v) => v.location === "url-query" && v.field === "ref" && v.value === "T-alice-9")).toBe(true);
    expect(c.consumed.some((v) => v.location === "header" && v.value.includes("T-alice-9"))).toBe(true);
    expect(c.consumed.some((v) => v.value === "T-alice-9")).toBe(true); // unwrapped Bearer token present
    expect(c.consumed.some((v) => v.location === "cookie" && v.field === "sid" && v.value === "abc123")).toBe(true);
  });

  it("never JSON-parses a base64 (binary) body, even when content-type claims json, so no produced values are mined from it", () => {
    const base64Json = Buffer.from('{"token":"T-alice-9"}').toString("base64");
    const m = buildFlow([{
      method: "GET", url: "https://x/api/bin",
      reqHeaders: {}, status: 200,
      resHeaders: { "content-type": "application/json" },
      resBody: base64Json,
      resBodyBase64: true,
    }]);
    const c = m.calls[0]!;
    expect(c.resJson).toBeUndefined();
    expect(c.produced.some((p) => p.source.startsWith("json:"))).toBe(false);
  });
});
