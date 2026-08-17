import { describe, it, expect } from "vitest";
import { buildFlow } from "../../src/flow/model";
import { applyDeps } from "../../src/flow/deps";
import {
  planReplay,
  extractRuntimeValue,
  resolveReplayValue,
  injectDepValue,
  type ReplayDep,
  type RuntimeResponse,
} from "../../src/flow/replay";
import type { RawCall } from "../../src/flow/types";

function loginMeModel() {
  const raw: RawCall[] = [
    {
      method: "POST",
      url: "https://x/api/login",
      reqHeaders: { "content-type": "application/json" },
      reqBody: '{"user":"alice"}',
      status: 200,
      resHeaders: { "content-type": "application/json" },
      resBody: '{"token":"T-alice-9"}',
    },
    {
      method: "GET",
      url: "https://x/api/me",
      reqHeaders: { authorization: "Bearer T-alice-9" },
      status: 200,
      resHeaders: {},
      resBody: "",
    },
  ];
  return applyDeps(buildFlow(raw));
}

describe("planReplay", () => {
  it("resolves step 1's dep chain from step 0's json:$.token, injected into the Authorization header", () => {
    const model = loginMeModel();
    const steps = planReplay(model);
    expect(steps).toHaveLength(2);

    const step0 = steps[0]!;
    expect(step0.method).toBe("POST");
    expect(step0.url).toBe("https://x/api/login");
    expect(step0.recordedStatus).toBe(200);
    expect(step0.deps).toHaveLength(0);
    expect(step0.body).toBe('{"user":"alice"}');

    const step1 = steps[1]!;
    expect(step1.method).toBe("GET");
    expect(step1.url).toBe("https://x/api/me");
    expect(step1.recordedStatus).toBe(200);
    expect(step1.deps).toHaveLength(1);

    const dep = step1.deps[0]!;
    expect(dep.fromStep).toBe(0);
    expect(dep.extract).toBe("json:$.token");
    expect(dep.transform).toBe("exact");
    expect(dep.varName).toBe("token");
    expect(dep.into).toEqual({ location: "header", field: "authorization" });
    expect(dep.needle).toBe("T-alice-9");
  });

  it("drops unsafe/meaningless headers (host/content-length/connection) from the replayed request", () => {
    const raw: RawCall[] = [
      {
        method: "GET",
        url: "https://x/api/ok",
        reqHeaders: { host: "x", "content-length": "0", connection: "keep-alive", "x-custom": "v" },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    const model = applyDeps(buildFlow(raw));
    const steps = planReplay(model);
    expect(steps[0]!.headers).toEqual({ "x-custom": "v" });
  });

  it("precomputes base64 alphabet/padding and urlenc direction for the executor", () => {
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/login",
        reqHeaders: {},
        status: 200,
        resHeaders: { "content-type": "application/json" },
        resBody: JSON.stringify({ blob: Buffer.from("session-999").toString("base64") }),
      },
      {
        method: "GET",
        url: "https://x/api/me",
        reqHeaders: { "x-sess": "session-999" },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    const model = applyDeps(buildFlow(raw));
    const steps = planReplay(model);
    const dep = steps[1]!.deps[0]!;
    expect(dep.transform).toBe("base64");
    expect(dep.opDirection).toBe("decode");
    expect(typeof dep.base64UrlSafe).toBe("boolean");
  });

  it("a substring dep's needle is the shorter produced literal, not the whole container", () => {
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/login",
        reqHeaders: {},
        status: 200,
        resHeaders: { "content-type": "application/json" },
        resBody: '{"token":"tok123456"}',
      },
      {
        method: "GET",
        url: "https://x/api/me",
        reqHeaders: { "x-wrapped": "prefix_tok123456_suffix" },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    const model = applyDeps(buildFlow(raw));
    const steps = planReplay(model);
    const dep = steps[1]!.deps[0]!;
    expect(dep.transform).toBe("substring");
    expect(dep.needle).toBe("tok123456");
  });
});

describe("extractRuntimeValue", () => {
  it("extracts a nested json path from a parsed response body", () => {
    const resp: RuntimeResponse = { status: 200, bodyText: "", headers: {}, json: { data: { id: "abc123" } } };
    expect(extractRuntimeValue("json:$.data.id", resp)).toBe("abc123");
  });

  it("extracts a Set-Cookie pair by name", () => {
    const resp: RuntimeResponse = { status: 200, bodyText: "", headers: { "set-cookie": "sid=Z9; Path=/" } };
    expect(extractRuntimeValue("cookie:sid", resp)).toBe("Z9");
  });

  it("extracts a response header verbatim", () => {
    const resp: RuntimeResponse = { status: 302, bodyText: "", headers: { location: "https://x/next" } };
    expect(extractRuntimeValue("header:location", resp)).toBe("https://x/next");
  });

  it("returns undefined when the path/cookie/header isn't present", () => {
    const resp: RuntimeResponse = { status: 200, bodyText: "", headers: {}, json: { a: 1 } };
    expect(extractRuntimeValue("json:$.missing", resp)).toBeUndefined();
    expect(extractRuntimeValue("cookie:nope", resp)).toBeUndefined();
    expect(extractRuntimeValue("header:nope", resp)).toBeUndefined();
  });

  it("resolves the FIRST Set-Cookie by name when a response sets two+ cookies (session + CSRF, a common pattern) -- not UNRESOLVED", () => {
    // Multiple Set-Cookie occurrences are joined with "\n" by lowerFetchHeaders (tools/flow.ts)
    // -- simulated directly here, matching its documented output shape.
    const resp: RuntimeResponse = {
      status: 200,
      bodyText: "",
      headers: { "set-cookie": "sid=ABC12345; Path=/\ncsrf=XYZ; Path=/" },
    };
    expect(extractRuntimeValue("cookie:sid", resp)).toBe("ABC12345");
  });

  it("splits on the cookie-header separator BEFORE splitting on ';', so a second cookie's pair can't bleed into the first when the first cookie has no ';'-delimited attributes of its own", () => {
    const resp: RuntimeResponse = {
      status: 200,
      bodyText: "",
      headers: { "set-cookie": "sid=ABC12345\ncsrf=XYZ; Path=/" },
    };
    expect(extractRuntimeValue("cookie:sid", resp)).toBe("ABC12345");
  });
});

function baseDep(overrides: Partial<ReplayDep>): ReplayDep {
  return {
    fromStep: 0,
    extract: "json:$.x",
    transform: "exact",
    varName: "x",
    into: { location: "header", field: "x" },
    needle: "orig",
    ...overrides,
  };
}

describe("resolveReplayValue", () => {
  it("exact/substring: the raw extracted value passes through unchanged", () => {
    expect(resolveReplayValue(baseDep({ transform: "exact" }), "raw-value")).toBe("raw-value");
    expect(resolveReplayValue(baseDep({ transform: "substring" }), "raw-value")).toBe("raw-value");
  });

  it("urlenc: encodes or decodes per the precomputed direction", () => {
    expect(resolveReplayValue(baseDep({ transform: "urlenc", opDirection: "encode" }), "a/b+c")).toBe(
      encodeURIComponent("a/b+c"),
    );
    expect(resolveReplayValue(baseDep({ transform: "urlenc", opDirection: "decode" }), "a%2Fb%2Bc")).toBe("a/b+c");
  });

  it("base64: decode-direction reads the correct alphabet", () => {
    const urlSafeBlob = Buffer.from("abc>>>def???ghi!!!").toString("base64url");
    const dep = baseDep({ transform: "base64", opDirection: "decode", base64UrlSafe: true });
    expect(resolveReplayValue(dep, urlSafeBlob)).toBe("abc>>>def???ghi!!!");
  });

  it("base64: encode-direction matches the wire's alphabet+padding", () => {
    const dep = baseDep({ transform: "base64", opDirection: "encode", base64UrlSafe: true, base64Padded: true });
    const out = resolveReplayValue(dep, "abc>>>def???ghi!!!X");
    expect(out).toBe("YWJjPj4-ZGVmPz8_Z2hpISEhWA==");
  });

  it("jwt-claim: decodes the payload segment and extracts the claim path", () => {
    const jwt = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({ sub: "user-42" }),
    ).toString("base64url")}.sig`;
    const dep = baseDep({ transform: "jwt-claim", claimPath: "sub" });
    expect(resolveReplayValue(dep, jwt)).toBe("user-42");
  });

  it("jwt-claim: falls back to the raw token if it can't be parsed", () => {
    const dep = baseDep({ transform: "jwt-claim", claimPath: "sub" });
    expect(resolveReplayValue(dep, "not-a-jwt")).toBe("not-a-jwt");
  });
});

describe("injectDepValue", () => {
  it("substitutes a header value, keeping surrounding literal text intact for a substring dep", () => {
    const dep = baseDep({
      transform: "substring",
      needle: "tok123456",
      into: { location: "header", field: "x-wrapped" },
    });
    const req = { url: "https://x/api/me", headers: { "x-wrapped": "prefix_tok123456_suffix" } };
    const result = injectDepValue(req, dep, "NEWTOKEN");
    expect(result.headers["x-wrapped"]).toBe("prefix_NEWTOKEN_suffix");
    expect(result.injected).toBe(true);
  });

  it("substitutes within the Cookie header for a cookie-location dep", () => {
    const dep = baseDep({ needle: "Z9", into: { location: "cookie", field: "sid" } });
    const req = { url: "https://x/home", headers: { cookie: "sid=Z9; other=keep" } };
    const result = injectDepValue(req, dep, "NEW9");
    expect(result.headers["cookie"]).toBe("sid=NEW9; other=keep");
  });

  it("substitutes a url-query value", () => {
    const dep = baseDep({ needle: "old-tok", into: { location: "url-query", field: "t" } });
    const req = { url: "https://x/api?t=old-tok&x=1", headers: {} };
    const result = injectDepValue(req, dep, "new-tok");
    expect(result.url).toBe("https://x/api?t=new-tok&x=1");
  });

  it("substitutes a body-json value", () => {
    const dep = baseDep({ needle: "old-tok", into: { location: "body-json", field: "$.t" } });
    const req = { url: "https://x/api", headers: {}, body: '{"t":"old-tok"}' };
    const result = injectDepValue(req, dep, "new-tok");
    expect(result.body).toBe('{"t":"new-tok"}');
  });

  it("reports injected:false when the header/needle isn't present (nothing to break)", () => {
    const dep = baseDep({ needle: "missing", into: { location: "header", field: "x-absent" } });
    const req = { url: "https://x/api", headers: {} };
    const result = injectDepValue(req, dep, "new");
    expect(result.injected).toBe(false);
  });
});
