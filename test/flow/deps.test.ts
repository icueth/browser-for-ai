import { describe, it, expect } from "vitest";
import { buildFlow } from "../../src/flow/model";
import { detectDeps } from "../../src/flow/deps";

describe("detectDeps", () => {
  it("links a login token used in a later Authorization header", () => {
    const model = buildFlow([
      { method: "POST", url: "https://x/api/login", reqHeaders: { "content-type": "application/json" }, reqBody: '{"user":"alice"}',
        status: 200, resHeaders: { "content-type": "application/json" }, resBody: '{"token":"T-alice-9"}' },
      { method: "GET", url: "https://x/api/me", reqHeaders: { authorization: "Bearer T-alice-9" }, status: 200, resHeaders: {}, resBody: "" },
    ]);
    const deps = detectDeps(model);
    const d = deps.find((x) => x.toCall === 1);
    expect(d).toBeTruthy();
    expect(d!.fromCall).toBe(0);
    expect(d!.source).toBe("json:$.token");
    expect(d!.varName).toBe("token");
    expect(d!.consumed.value).toBe("T-alice-9");
    expect(d!.transform).toBe("exact");
  });

  it("links a Set-Cookie value reused as a later request cookie", () => {
    const model = buildFlow([
      { method: "POST", url: "https://x/login", reqHeaders: {}, status: 200, resHeaders: { "set-cookie": "sid=Z9; Path=/" }, resBody: "" },
      { method: "GET", url: "https://x/home", reqHeaders: { cookie: "sid=Z9" }, status: 200, resHeaders: {}, resBody: "" },
    ]);
    const d = detectDeps(model).find((x) => x.toCall === 1);
    expect(d!.fromCall).toBe(0);
    expect(d!.source).toBe("cookie:sid");
    expect(d!.varName).toBe("sid");
    expect(d!.transform).toBe("exact");
  });

  it("does not link user-supplied literals with no earlier producer", () => {
    const model = buildFlow([
      { method: "POST", url: "https://x/api/login", reqHeaders: { "content-type": "application/json" }, reqBody: '{"user":"alice","pass":"secret"}', status: 200, resHeaders: {}, resBody: "{}" },
    ]);
    expect(detectDeps(model)).toHaveLength(0);
  });

  it("links a login token that is url-encoded in a later header value", () => {
    // Note: URLSearchParams auto-decodes query params on extraction, so a
    // url-encoded query value would already appear decoded (and thus match
    // as "exact"). Use a custom header instead, which is captured verbatim.
    const model = buildFlow([
      { method: "POST", url: "https://x/api/login", reqHeaders: { "content-type": "application/json" }, reqBody: '{"user":"alice"}',
        status: 200, resHeaders: { "content-type": "application/json" }, resBody: '{"token":"a/b+c"}' },
      { method: "GET", url: "https://x/api/data", reqHeaders: { "x-token": "a%2Fb%2Bc" }, status: 200, resHeaders: {}, resBody: "" },
    ]);
    const d = detectDeps(model).find((x) => x.toCall === 1);
    expect(d).toBeTruthy();
    expect(d!.fromCall).toBe(0);
    expect(d!.source).toBe("json:$.token");
    expect(d!.transform).toBe("urlenc");
  });

  it("links a JWT claim from login used as a value in a later call", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "alice-123" }), "utf8").toString("base64url");
    const jwt = `${header}.${payload}.sig`;
    const model = buildFlow([
      { method: "POST", url: "https://x/api/login", reqHeaders: { "content-type": "application/json" }, reqBody: '{"user":"alice"}',
        status: 200, resHeaders: { "content-type": "application/json" }, resBody: `{"jwt":"${jwt}"}` },
      { method: "GET", url: "https://x/api/profile?uid=alice-123", reqHeaders: {}, status: 200, resHeaders: {}, resBody: "" },
    ]);
    const d = detectDeps(model).find((x) => x.toCall === 1);
    expect(d).toBeTruthy();
    expect(d!.fromCall).toBe(0);
    expect(d!.source).toBe("json:$.jwt");
    expect(d!.transform).toBe("jwt-claim");
    expect(d!.claimPath).toBe("sub");
  });

  it("prefers a LATER call matching via a stronger transform over an EARLIER call matching only via a weaker one", () => {
    // call 0 produces a value that only relates to the later consumed value
    // via substring; call 1 (later, but still earlier than the consumer)
    // produces the consumed value's exact match. Producer selection is
    // transform-tier-first, not strictly earliest-call-first, so the exact
    // match at call 1 must win over the substring match at call 0.
    const model = buildFlow([
      { method: "POST", url: "https://x/step0", reqHeaders: {}, status: 200, resHeaders: { "content-type": "application/json" }, resBody: '{"partial":"TOKEN-999"}' },
      { method: "POST", url: "https://x/step1", reqHeaders: {}, status: 200, resHeaders: { "content-type": "application/json" }, resBody: '{"full":"SECRET-TOKEN-999"}' },
      { method: "GET", url: "https://x/step2", reqHeaders: { "x-tok": "SECRET-TOKEN-999" }, status: 200, resHeaders: {}, resBody: "" },
    ]);
    const d = detectDeps(model).find((x) => x.toCall === 2);
    expect(d).toBeTruthy();
    expect(d!.fromCall).toBe(1);
    expect(d!.source).toBe("json:$.full");
    expect(d!.transform).toBe("exact");
  });

  it("within the same transform tier, the earliest producing call still wins", () => {
    const model = buildFlow([
      { method: "POST", url: "https://x/step0", reqHeaders: {}, status: 200, resHeaders: { "content-type": "application/json" }, resBody: '{"a":"DUPTOKEN1234"}' },
      { method: "POST", url: "https://x/step1", reqHeaders: {}, status: 200, resHeaders: { "content-type": "application/json" }, resBody: '{"b":"DUPTOKEN1234"}' },
      { method: "GET", url: "https://x/step2", reqHeaders: { "x-dup": "DUPTOKEN1234" }, status: 200, resHeaders: {}, resBody: "" },
    ]);
    const d = detectDeps(model).find((x) => x.toCall === 2);
    expect(d).toBeTruthy();
    expect(d!.fromCall).toBe(0);
    expect(d!.source).toBe("json:$.a");
    expect(d!.transform).toBe("exact");
  });
});
