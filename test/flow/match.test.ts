import { describe, it, expect } from "vitest";
import { matchValue } from "../../src/flow/match";

describe("matchValue", () => {
  it("matches exact equal strings", () => {
    const r = matchValue("token123", "token123");
    expect(r).toEqual({ transform: "exact" });
  });

  it("matches url-encoded consumed value (producer decoded, consumed encoded)", () => {
    const r = matchValue("a/b/c", "a%2Fb%2Fc");
    expect(r).toEqual({ transform: "urlenc" });
  });

  it("matches url-encoded producer value (producer encoded, consumed decoded)", () => {
    const r = matchValue("a%2Fb%2Fc", "a/b/c");
    expect(r).toEqual({ transform: "urlenc" });
  });

  it("matches base64: producer is base64 of consumed", () => {
    const decoded = "SESSION-XYZ-1234";
    const encoded = Buffer.from(decoded, "utf8").toString("base64");
    const r = matchValue(encoded, decoded);
    expect(r).toEqual({ transform: "base64" });
  });

  it("matches base64: consumed is base64 of producer", () => {
    const decoded = "SESSION-XYZ-1234";
    const encoded = Buffer.from(decoded, "utf8").toString("base64");
    const r = matchValue(decoded, encoded);
    expect(r).toEqual({ transform: "base64" });
  });

  it("matches jwt-claim on a top-level string claim", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8")
      .toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "alice-123", role: "admin" }), "utf8")
      .toString("base64url");
    const jwt = `${header}.${payload}.x`;

    const r = matchValue(jwt, "alice-123");
    expect(r).toEqual({ transform: "jwt-claim", claimPath: "sub" });
  });

  it("matches substring: producer value found inside a larger consumed string", () => {
    const r = matchValue("SESSIONABCDEFGH", "Bearer SESSIONABCDEFGH");
    expect(r).toEqual({ transform: "substring", container: "Bearer SESSIONABCDEFGH" });
  });

  it("returns null for unrelated strings", () => {
    expect(matchValue("hello", "world")).toBeNull();
  });

  it("returns null for a too-short substring candidate (producer < 8 chars)", () => {
    expect(matchValue("abc", "xxabcxx")).toBeNull();
  });

  it("returns null for short unrelated numeric-like strings", () => {
    expect(matchValue("1234", "99")).toBeNull();
  });

  it("returns null when producer equals consumed but exact only requires no extra checks (sanity: exact still wins for identical short strings)", () => {
    // exact match still applies even for short strings — only substring has the length guard
    expect(matchValue("ab", "ab")).toEqual({ transform: "exact" });
  });

  it("does not treat malformed percent-encoding as a urlenc match", () => {
    // decodeURIComponent throws on malformed sequences; matchValue must not throw
    expect(() => matchValue("token", "a%")).not.toThrow();
    expect(matchValue("token", "a%")).toBeNull();
  });

  it("does not false-positive base64 on short/non-base64-shaped values", () => {
    expect(matchValue("abc", "def")).toBeNull();
  });

  it("does not false-positive jwt-claim on a non-JWT-shaped producer", () => {
    expect(matchValue("not.a.jwt", "a")).toBeNull();
  });
});
