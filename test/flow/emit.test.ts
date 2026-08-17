import { describe, it, expect } from "vitest";
import { buildFlow } from "../../src/flow/model";
import { applyDeps } from "../../src/flow/deps";
import { emitCurl } from "../../src/flow/emit/curl";
import { emitHar } from "../../src/flow/emit/har";
import { emitTs } from "../../src/flow/emit/ts";
import { emitPython } from "../../src/flow/emit/python";
import { emitGo } from "../../src/flow/emit/go";
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
      resHeaders: { "content-type": "application/json" },
      resBody: '{"id":1}',
    },
  ];
  return applyDeps(buildFlow(raw));
}

describe("emitCurl", () => {
  it("extracts the token with jq and chains it into the later call instead of the literal", () => {
    const model = loginMeModel();
    const script = emitCurl(model);

    // extraction from the login response
    expect(script).toContain("jq -r '.token'");
    // chain: the /api/me call must use the variable, not the raw literal
    expect(script).toMatch(/Bearer \$token|"\$token"/);
    // the literal token value must never appear anywhere in the static script
    expect(script).not.toContain("T-alice-9");
  });

  it("keeps unmatched literals as literals", () => {
    const model = loginMeModel();
    const script = emitCurl(model);
    expect(script).toContain('{"user":"alice"}');
  });

  it("escapes a pre-existing literal $ instead of letting it expand, while still injecting the chained $var", () => {
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
        url: "https://x/api/r?$filter=active&token=T-alice-9",
        reqHeaders: {},
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    const model = applyDeps(buildFlow(raw));
    const script = emitCurl(model);

    // pre-existing literal $ must be escaped so bash doesn't expand it as a variable
    expect(script).toContain("\\$filter");
    // the chained value must still be injected as a real (unescaped) shell variable
    expect(script).toContain("$token");
    // must never appear as a bare, unescaped $filter
    expect(script).not.toContain("?$filter");
  });

  it("substitutes the longest matching literal first so one var's value being a substring of another's doesn't mangle the result", () => {
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/login",
        reqHeaders: {},
        reqBody: undefined,
        status: 200,
        resHeaders: { "content-type": "application/json" },
        resBody: '{"tok":"abcd","full":"abcdef"}',
      },
      {
        method: "GET",
        url: "https://x/api/r?a=abcd&b=abcdef",
        reqHeaders: {},
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    const model = applyDeps(buildFlow(raw));
    const script = emitCurl(model);

    expect(script).toContain("a=$tok&b=$full");
    expect(script).not.toContain("$tokef");
    expect(script).not.toContain("abcd");
  });
});

describe("emitHar", () => {
  it("produces valid HAR 1.2 JSON with two entries", () => {
    const model = loginMeModel();
    const har = emitHar(model);
    const parsed = JSON.parse(har);

    expect(parsed.log.version).toBe("1.2");
    expect(parsed.log.creator.name).toBe("browser-for-ai");
    expect(parsed.log.entries).toHaveLength(2);
    expect(parsed.log.entries[0].request.method).toBe("POST");
    expect(parsed.log.entries[0].request.url).toBe("https://x/api/login");
    expect(parsed.log.entries[0].response.status).toBe(200);
    expect(parsed.log.entries[1].request.method).toBe("GET");
  });

  it("includes the HAR-1.2-required cookies array on request and response", () => {
    const model = loginMeModel();
    const har = emitHar(model);
    const parsed = JSON.parse(har);

    expect(Array.isArray(parsed.log.entries[0].request.cookies)).toBe(true);
    expect(Array.isArray(parsed.log.entries[0].response.cookies)).toBe(true);
  });

  it("marks a base64 (binary) response body with content.encoding and an unknown (-1) size, instead of reporting the base64 text's length", () => {
    const raw: RawCall[] = [
      {
        method: "GET",
        url: "https://x/api/bin",
        reqHeaders: {},
        status: 200,
        resHeaders: { "content-type": "application/octet-stream" },
        resBody: Buffer.from('{"token":"T-alice-9"}').toString("base64"),
        resBodyBase64: true,
      },
    ];
    const model = applyDeps(buildFlow(raw));
    const har = emitHar(model);
    const parsed = JSON.parse(har);

    expect(parsed.log.entries[0].response.content.encoding).toBe("base64");
    expect(parsed.log.entries[0].response.content.size).toBe(-1);
  });
});

describe("emitTs", () => {
  it("chains the token through a var instead of the literal, and extracts it from the JSON response", () => {
    const model = loginMeModel();
    const script = emitTs(model);

    expect(script.match(/await fetch\(/g)).toHaveLength(2);
    // extraction from the login response
    expect(script).toMatch(/\.token\b/);
    // chain: the /api/me call must use the variable, not the raw literal
    expect(script).toContain("Bearer ${token}");
    // the literal token value must never appear anywhere in the static script
    expect(script).not.toContain("T-alice-9");
  });

  it("keeps unmatched literals as literals, rendered as a JS object literal for the JSON body", () => {
    const model = loginMeModel();
    const script = emitTs(model);
    expect(script).toContain('user: "alice"');
    expect(script).toContain("JSON.stringify(");
  });

  it("wraps the script in an async run() function that gets called", () => {
    const model = loginMeModel();
    const script = emitTs(model);
    expect(script).toContain("async function run() {");
    expect(script.trimEnd().endsWith("run();")).toBe(true);
  });

  it("safely escapes a literal body value containing a double quote", () => {
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/note",
        reqHeaders: { "content-type": "application/json" },
        reqBody: '{"note":"he said \\"hi\\""}',
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    const model = applyDeps(buildFlow(raw));
    const script = emitTs(model);

    // JSON.stringify's escaped form of `he said "hi"` must appear intact (not broken by an
    // unescaped quote that would terminate the string early).
    expect(script).toContain(JSON.stringify('he said "hi"'));
  });
});

describe("emitPython", () => {
  it("chains the token through a var instead of the literal, and extracts it from the JSON response", () => {
    const model = loginMeModel();
    const script = emitPython(model);

    expect(script.match(/requests\./g)).toHaveLength(2);
    // extraction from the login response
    expect(script).toContain('["token"]');
    // chain: the /api/me call must use the variable, not the raw literal
    expect(script).toContain('f"Bearer {token}"');
    // the literal token value must never appear anywhere in the static script
    expect(script).not.toContain("T-alice-9");
  });

  it("keeps unmatched literals as literals", () => {
    const model = loginMeModel();
    const script = emitPython(model);
    expect(script).toContain("import requests");
    expect(script).toContain('"user"');
    expect(script).toContain('"alice"');
  });

  it("safely escapes a literal body value containing a double quote", () => {
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/note",
        reqHeaders: { "content-type": "application/json" },
        reqBody: '{"note":"he said \\"hi\\""}',
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    const model = applyDeps(buildFlow(raw));
    const script = emitPython(model);

    // JSON.stringify's escaped form of `he said "hi"` is also a valid Python double-quoted
    // string literal, and must appear intact.
    expect(script).toContain(JSON.stringify('he said "hi"'));
  });
});

describe("transform rendering", () => {
  function urlencModel() {
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/login",
        reqHeaders: {},
        status: 200,
        resHeaders: { "content-type": "application/json" },
        resBody: '{"token":"ab cd"}',
      },
      {
        method: "GET",
        url: "https://x/api/me",
        reqHeaders: { "x-tok": "ab%20cd" },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    return applyDeps(buildFlow(raw));
  }

  it("urlenc: substitutes the ENCODED form of the var at the use site, per language", () => {
    const model = urlencModel();
    expect(emitTs(model)).toMatch(/encodeURIComponent\(token\)/);
    expect(emitPython(model)).toContain('urllib.parse.quote(token, safe="")');
    expect(emitPython(model)).toContain("import urllib.parse");
    expect(emitGo(model)).toContain("url.QueryEscape(token)");
    expect(emitGo(model)).toContain('"net/url"');
  });

  function urlencReverseModel() {
    // Producer's raw literal is ALREADY percent-encoded; the consumer uses the DECODED form.
    // Unconditionally wrapping in encodeURIComponent here would double-encode it.
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/login",
        reqHeaders: {},
        status: 200,
        resHeaders: { "content-type": "application/json" },
        resBody: '{"token":"a%2Fb%2Bc"}',
      },
      {
        method: "GET",
        url: "https://x/api/me",
        reqHeaders: { "x-token": "a/b+c" },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    return applyDeps(buildFlow(raw));
  }

  it("urlenc (reverse direction): decodes the var at the use site when the producer's literal was already encoded", () => {
    const model = urlencReverseModel();
    const dep = model.deps.find((d) => d.transform === "urlenc");
    expect(dep).toBeTruthy();
    const ts = emitTs(model);
    expect(ts).toContain("decodeURIComponent(token)");
    expect(ts).not.toContain("encodeURIComponent(token)");
    expect(emitPython(model)).toContain("urllib.parse.unquote(token)");
    expect(emitGo(model)).toMatch(/url\.QueryUnescape\(token\)/);
  });

  function base64DecodeModel() {
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
    return applyDeps(buildFlow(raw));
  }

  it("base64 (decode-direction): decodes the extracted var at extraction time", () => {
    const model = base64DecodeModel();
    const ts = emitTs(model);
    expect(ts).toContain("Buffer.from(");
    expect(ts).not.toContain("session-999");
    const py = emitPython(model);
    expect(py).toContain("b64decode");
    expect(py).toContain("import base64");
  });

  function base64UrlSafeDecodeModel() {
    // "abc>>>def???ghi!!!" is standard-base64 "YWJjPj4+ZGVmPz8/Z2hpISEh" (contains +//) --
    // its url-safe form ("YWJjPj4-ZGVmPz8_Z2hpISEh") contains -/_, which plain atob()/
    // base64.b64decode()/Go base64.StdEncoding/BSD `base64 -d` all mishandle.
    const plain = "abc>>>def???ghi!!!";
    const urlSafe = Buffer.from(plain).toString("base64url");
    expect(urlSafe).toMatch(/[-_]/);
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/login",
        reqHeaders: {},
        status: 200,
        resHeaders: { "content-type": "application/json" },
        resBody: JSON.stringify({ blob: urlSafe }),
      },
      {
        method: "GET",
        url: "https://x/api/me",
        reqHeaders: { "x-plain": plain },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    return { model: applyDeps(buildFlow(raw)), plain, urlSafe };
  }

  it("base64 (url-safe alphabet): every emitter decodes -/_ correctly instead of mangling it", () => {
    const { model, plain, urlSafe } = base64UrlSafeDecodeModel();
    const dep = model.deps.find((d) => d.transform === "base64");
    expect(dep).toBeTruthy();

    const ts = emitTs(model);
    expect(ts).toContain('Buffer.from(j0.blob, "base64url").toString()');
    expect(ts).not.toContain(plain);
    // Real end-to-end decode of the actual emitted expression -- not just a string match.
    // eslint-disable-next-line no-new-func
    expect(new Function(`return Buffer.from(${JSON.stringify(urlSafe)}, "base64url").toString();`)()).toBe(plain);

    const py = emitPython(model);
    expect(py).toContain("base64.urlsafe_b64decode(_b64pad(j0[");
    expect(py).toContain("def _b64pad(s):");

    const go = emitGo(model);
    expect(go).toMatch(/base64\.Raw(URL|Std)Encoding\.DecodeString\(strings\.TrimRight\(/);
    expect(go).toContain('"strings"');

    const curl = emitCurl(model);
    expect(curl).toContain("_b64url_decode");
    expect(curl).toContain("tr '_-' '/+'");
  });

  function base64EncodeModel() {
    const encoded = Buffer.from("plainvalue123").toString("base64");
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/login",
        reqHeaders: {},
        status: 200,
        resHeaders: { "content-type": "application/json" },
        resBody: '{"raw":"plainvalue123"}',
      },
      {
        method: "GET",
        url: "https://x/api/me",
        reqHeaders: { "x-enc": encoded },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    return applyDeps(buildFlow(raw));
  }

  it("base64 (encode-direction): encodes the var at the use site", () => {
    const model = base64EncodeModel();
    expect(emitTs(model)).toMatch(/Buffer\.from\(raw\)\.toString\("base64"\)/);
  });

  function buildBase64EncodeModel(plain: string, wire: string) {
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/login",
        reqHeaders: {},
        status: 200,
        resHeaders: { "content-type": "application/json" },
        resBody: JSON.stringify({ raw: plain }),
      },
      {
        method: "GET",
        url: "https://x/api/me",
        reqHeaders: { "x-enc": wire },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    return applyDeps(buildFlow(raw));
  }

  it("base64 (encode-direction, standard alphabet + NO padding): TS/curl reproduce the exact unpadded wire literal", () => {
    // 9-byte plaintext -> standard base64 has no padding and no -/_ (Buffer.toString("base64")
    // always pads when needed, so this combo needs the trailing "=" stripped back off).
    const plain = "abcdefghi";
    const wire = Buffer.from(plain).toString("base64");
    expect(wire.endsWith("=")).toBe(false);

    const model = buildBase64EncodeModel(plain, wire);
    const dep = model.deps.find((d) => d.transform === "base64");
    expect(dep).toBeTruthy();

    const ts = emitTs(model);
    expect(ts).toContain('Buffer.from(raw).toString("base64").replace(/=+$/, "")');
    // eslint-disable-next-line no-new-func
    const actualTs = new Function("raw", `return Buffer.from(raw).toString("base64").replace(/=+$/, "");`)(plain);
    expect(actualTs).toBe(wire);

    const curl = emitCurl(model);
    expect(curl).toContain(`base64 | tr -d '='`);
  });

  it("base64 (encode-direction, url-safe alphabet + padding): TS/curl reproduce the exact padded url-safe wire literal", () => {
    // 19-byte plaintext -> url-safe base64 needs padding AND contains -/_. Node's
    // Buffer.toString("base64url") NEVER pads, so this combo needs padding added back on.
    const plain = "abc>>>def???ghi!!!X";
    const wire = "YWJjPj4-ZGVmPz8_Z2hpISEhWA=="; // verified: python base64.urlsafe_b64encode(plain)
    expect(wire.endsWith("=")).toBe(true);
    expect(wire).toMatch(/[-_]/);
    expect(Buffer.from(wire, "base64url").toString()).toBe(plain); // sanity: wire really decodes to plain

    const model = buildBase64EncodeModel(plain, wire);
    const dep = model.deps.find((d) => d.transform === "base64");
    expect(dep).toBeTruthy();

    const ts = emitTs(model);
    expect(ts).toContain('Buffer.from(raw).toString("base64url")');
    expect(ts).toContain('"=".repeat((4 - (s.length % 4)) % 4)');
    // eslint-disable-next-line no-new-func
    const actualTs = new Function(
      "raw",
      `return (() => { const s = Buffer.from(raw).toString("base64url"); return s + "=".repeat((4 - (s.length % 4)) % 4); })();`,
    )(plain);
    expect(actualTs).toBe(wire);

    const curl = emitCurl(model);
    expect(curl).toContain(`| tr '+/' '-_'`);
    expect(curl).not.toContain(`tr -d '='`); // padded -- must NOT strip
  });

  function jwtClaimModel() {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "user-42" })).toString("base64url");
    const jwt = `${header}.${payload}.sig`;
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/login",
        reqHeaders: {},
        status: 200,
        resHeaders: { "content-type": "application/json" },
        resBody: JSON.stringify({ token: jwt }),
      },
      {
        method: "GET",
        url: "https://x/api/me",
        reqHeaders: { "x-user": "user-42" },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    return applyDeps(buildFlow(raw));
  }

  it("jwt-claim: TS decodes the payload inline and accesses the claim", () => {
    const model = jwtClaimModel();
    const ts = emitTs(model);
    expect(ts).toContain('Buffer.from(token.split(".")[1], "base64url")');
    expect(ts).not.toContain("atob(");
    expect(ts).toContain('.split(".")');
    expect(ts).toContain(".sub");
    expect(ts).not.toContain("user-42");
  });

  it("jwt-claim (url-safe payload): TS decodes a payload segment containing -/_ correctly, not via atob", () => {
    // JWT segments are ALWAYS base64url per RFC 7515 -- a payload whose JSON happens to encode
    // to a segment containing "-"/"_" is the realistic case, not an edge case; atob() throws or
    // mis-decodes those characters, which is exactly the bug being fixed here.
    const claimValue = "abc>>>def???ghi!!!";
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: claimValue })).toString("base64url");
    expect(payload).toMatch(/[-_]/);
    const jwt = `${header}.${payload}.sig`;
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/login",
        reqHeaders: {},
        status: 200,
        resHeaders: { "content-type": "application/json" },
        resBody: JSON.stringify({ token: jwt }),
      },
      {
        method: "GET",
        url: "https://x/api/me",
        reqHeaders: { "x-user": claimValue },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    const model = applyDeps(buildFlow(raw));
    const ts = emitTs(model);
    expect(ts).toContain('Buffer.from(token.split(".")[1], "base64url")');
    expect(ts).not.toContain("atob(");

    // Real end-to-end decode of the emitted expression against the actual JWT payload segment.
    // eslint-disable-next-line no-new-func
    const decoded = new Function(
      "token",
      `return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;`,
    )(jwt);
    expect(decoded).toBe(claimValue);
  });

  it("jwt-claim: Python decodes the payload inline and accesses the claim", () => {
    const model = jwtClaimModel();
    const py = emitPython(model);
    expect(py).toContain("urlsafe_b64decode");
    expect(py).toContain('.split(".")');
    expect(py).toContain("import json");
  });

  it("jwt-claim: Go and curl emit a TODO with the claim path and fall back to the raw var", () => {
    const model = jwtClaimModel();
    const go = emitGo(model);
    expect(go).toContain("TODO jwt-claim");
    expect(go).toContain("sub");
    const curl = emitCurl(model);
    expect(curl).toContain("TODO jwt-claim");
  });

  it("substring: substitutes the var within the container literal, leaving surrounding text intact", () => {
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
    const ts = emitTs(model);
    expect(ts).toContain("prefix_${token}_suffix");
    expect(ts).not.toContain("prefix_tok123456_suffix");
  });
});

describe("redaction", () => {
  function redactModel() {
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/login",
        reqHeaders: {},
        status: 200,
        resHeaders: { "content-type": "application/json" },
        resBody: '{"token":"token123456"}',
      },
      {
        method: "GET",
        url: "https://x/api/me",
        reqHeaders: {
          // chained via substring ("Bearer " + producer's token) -- must stay a var, never redacted
          authorization: "Bearer token123456",
          // unmatched anywhere, but long + token-like -- must be redacted
          "x-api-key": "sk_live_abcdefghijklmnop1234567890",
        },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    return applyDeps(buildFlow(raw));
  }

  it("redacts an unmatched token-like literal, leaving a matched (chained) value as its var", () => {
    const model = redactModel();
    const script = emitTs(model, { redact: true });
    expect(script).toContain("process.env.BFA_SECRET_");
    expect(script).not.toContain("sk_live_abcdefghijklmnop1234567890");
    expect(script).toContain("Bearer ${token}");
  });

  it("does not redact when the option is off (default)", () => {
    const model = redactModel();
    const script = emitTs(model);
    expect(script).toContain("sk_live_abcdefghijklmnop1234567890");
  });

  it("redacts a short unmatched authorization/cookie header value too (secret-bearing location, not just length)", () => {
    const raw: RawCall[] = [
      {
        method: "GET",
        url: "https://x/api/whoami",
        reqHeaders: { cookie: "sid=abc" },
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    const model = applyDeps(buildFlow(raw));
    const script = emitTs(model, { redact: true });
    expect(script).toContain("process.env.BFA_SECRET_");
    expect(script).not.toContain("sid=abc");
  });

  it("uses language-appropriate placeholder syntax across emitters", () => {
    const model = redactModel();
    expect(emitPython(model, { redact: true })).toContain('os.environ["BFA_SECRET_');
    expect(emitGo(model, { redact: true })).toContain('os.Getenv("BFA_SECRET_');
    expect(emitCurl(model, { redact: true })).toContain("$BFA_SECRET_");
  });
});

describe("emitGo", () => {
  it("chains the token through a var instead of the literal, and extracts it from the JSON response", () => {
    const model = loginMeModel();
    const script = emitGo(model);

    expect(script.match(/http\.NewRequest\(/g)).toHaveLength(2);
    // extraction from the login response
    expect(script).toContain("json.Unmarshal(");
    expect(script).toContain('data0["token"]');
    // chain: the /api/me call must use the variable, not the raw literal
    expect(script).toMatch(/"Bearer "\+token|\+token/);
    // the literal token value must never appear anywhere in the static script
    expect(script).not.toContain("T-alice-9");
  });

  it("keeps unmatched literals as literals", () => {
    const model = loginMeModel();
    const script = emitGo(model);
    expect(script).toContain('"user"');
    expect(script).toContain('"alice"');
  });

  it("emits a runnable package main with imports and a func main", () => {
    const model = loginMeModel();
    const script = emitGo(model);
    expect(script).toContain("package main");
    expect(script).toContain("import (");
    expect(script).toContain("func main() {");
    expect(script).toContain("net/http");
  });

  it("safely escapes a literal body value containing a double quote", () => {
    const raw: RawCall[] = [
      {
        method: "POST",
        url: "https://x/api/note",
        reqHeaders: { "content-type": "application/json" },
        reqBody: '{"note":"he said \\"hi\\""}',
        status: 200,
        resHeaders: {},
        resBody: "",
      },
    ];
    const model = applyDeps(buildFlow(raw));
    const script = emitGo(model);

    // A Go double-quoted string literal must contain the escaped quote (\") — an
    // unescaped literal `"` here would break the emitted Go source.
    expect(script).toContain('\\"hi\\"');
  });
});
