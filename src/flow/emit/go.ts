import type { FlowCall, FlowDep, FlowModel } from "../types";
import {
  SKIP_HEADERS,
  base64Direction,
  base64Encoding,
  bodyJsonDepsByField,
  dedupeOutgoing,
  findAllIncoming,
  groupDepsByCall,
  newRedactionTracker,
  parseJsonPath,
  redactionHeaderComment,
  registerSecret,
  shouldRedact,
  tokenize,
  urlencDirection,
  type EmitOptions,
  type JsonPathSegment,
  type RedactionTracker,
} from "./shared";

/**
 * A plain Go double-quoted string literal. `JSON.stringify`'s escapes (`\"`, `\\`, `\n`,
 * `\r`, `\t`, `\uXXXX` for control chars) are all valid Go string escapes too, and any raw
 * UTF-8 text it leaves untouched is legal inside a Go string as-is — same reasoning the
 * Python emitter uses for `pyStringLiteral`.
 */
function goStringLiteral(text: string): string {
  return JSON.stringify(text);
}

/**
 * Decode a base64 blob in the correct alphabet, tolerant of missing padding (a captured wire
 * literal is often padding-stripped, and Go's `base64.StdEncoding`/`URLEncoding` REQUIRE exact
 * padding — the `Raw*` variants don't, so trim any padding present and always use those). Using
 * the wrong alphabet here (`StdEncoding` on a url-safe `-`/`_` blob) is a `CorruptInputError`.
 */
function goBase64DecodeExpr(rhs: string, urlSafe: boolean): string {
  const encoding = urlSafe ? "base64.RawURLEncoding" : "base64.RawStdEncoding";
  return `func() string { b, _ := ${encoding}.DecodeString(strings.TrimRight(${rhs}, "=")); return string(b) }()`;
}

/**
 * The Go expression (and any setup line(s) it needs beforehand) that refer to a dep's value,
 * honoring its transform. Go has no string interpolation and no terse inline JWT decode, so:
 * - urlenc: `url.QueryEscape(...)` at this use site (or, when the producer's literal was already
 *   percent-encoded and the consumer used the decoded form, `url.QueryUnescape(...)` — see
 *   `urlencDirection`; wrapped in an inline closure since `QueryUnescape` returns `(string,
 *   error)` and can't be used directly inside a larger expression).
 * - base64 (encode-direction): `EncodeToString(...)` at this use site, in whichever alphabet
 *   (and padding style) the wire literal actually used — see `base64Encoding`.
 * - jwt-claim: per the brief, a `// TODO jwt-claim` comment plus a fallback to the raw var —
 *   a full inline JWT decode in Go needs several statements and error handling, disproportionate
 *   for a codegen leaf; the TODO is honest about what's left to do by hand.
 */
function goVarRef(model: FlowModel, dep: FlowDep, imports: Set<string>): { expr: string; preLines: string[] } {
  if (dep.transform === "urlenc") {
    imports.add("net/url");
    if (urlencDirection(model, dep) === "decode") {
      return {
        expr: `func() string { v, _ := url.QueryUnescape(${dep.varName}); return v }()`,
        preLines: [],
      };
    }
    return { expr: `url.QueryEscape(${dep.varName})`, preLines: [] };
  }
  if (dep.transform === "base64" && base64Direction(model, dep) === "encode") {
    imports.add("encoding/base64");
    const { urlSafe, padded } = base64Encoding(model, dep);
    const encoding = padded
      ? urlSafe
        ? "base64.URLEncoding"
        : "base64.StdEncoding"
      : urlSafe
        ? "base64.RawURLEncoding"
        : "base64.RawStdEncoding";
    return { expr: `${encoding}.EncodeToString([]byte(${dep.varName}))`, preLines: [] };
  }
  if (dep.transform === "jwt-claim") {
    return {
      expr: dep.varName,
      preLines: [
        `// TODO jwt-claim: extract ${goStringLiteral(dep.claimPath ?? "")} from ${dep.varName} (JWT) -- using the raw token as a fallback`,
      ],
    };
  }
  return { expr: dep.varName, preLines: [] };
}

function addPreLines(target: string[], lines: string[]): void {
  for (const l of lines) if (!target.includes(l)) target.push(l);
}

/** Render a raw string with dep substitutions as a Go expression: a plain string literal if nothing matched, a bare (transform-wrapped) expression if the whole string is a single var, else a `"lit"+var+"lit"` concatenation chain (Go has no string interpolation). */
function goConcatExpr(raw: string, deps: FlowDep[], model: FlowModel, imports: Set<string>, preLines: string[]): string {
  const parts = tokenize(raw, deps, model);
  if (parts.length === 1 && parts[0]?.type === "text") return goStringLiteral(raw);
  return parts
    .map((p) => {
      if (p.type === "text") return goStringLiteral(p.text);
      const { expr, preLines: pl } = goVarRef(model, p.dep, imports);
      addPreLines(preLines, pl);
      return expr;
    })
    .join("+");
}

/** Recursively render a parsed JSON value as a Go map[string]interface{}/[]interface{}/literal expression, substituting any leaf whose json-path matches a body-json dep with its (bare) transform-aware expression instead of its literal value. See `renderJsValue` (ts.ts) for the same "substring loses its container" limitation. */
function renderGoValue(
  value: unknown,
  path: string,
  depsByField: Map<string, FlowDep>,
  model: FlowModel,
  imports: Set<string>,
  preLines: string[],
): string {
  if (value === null || value === undefined) return "nil";
  if (Array.isArray(value)) {
    return `[]interface{}{${value.map((v, i) => renderGoValue(v, `${path}[${i}]`, depsByField, model, imports, preLines)).join(", ")}}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${goStringLiteral(k)}: ${renderGoValue(v, `${path}.${k}`, depsByField, model, imports, preLines)}`,
    );
    return entries.length > 0 ? `map[string]interface{}{${entries.join(", ")}}` : "map[string]interface{}{}";
  }
  const dep = depsByField.get(path);
  if (dep) {
    const { expr, preLines: pl } = goVarRef(model, dep, imports);
    addPreLines(preLines, pl);
    return expr;
  }
  if (typeof value === "string") return goStringLiteral(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function redactedLiteralExpr(tracker: RedactionTracker, location: string, imports: Set<string>): string {
  imports.add("os");
  return `os.Getenv(${goStringLiteral(registerSecret(tracker, location))})`;
}

function buildUrlExpr(call: FlowCall, incoming: FlowDep[], model: FlowModel, imports: Set<string>, preLines: string[]): string {
  return goConcatExpr(call.url, findAllIncoming(incoming, "url-query"), model, imports, preLines);
}

/** Build `(headerName, valueExpr)` pairs for `req{i}.Header.Set(...)` calls, substituting any consumed header/cookie values with their (transform-aware) Go expression. */
function buildHeaderSets(
  call: FlowCall,
  incoming: FlowDep[],
  model: FlowModel,
  imports: Set<string>,
  preLines: string[],
  redact: { tracker: RedactionTracker } | undefined,
): Array<[string, string]> {
  const headerDeps = findAllIncoming(incoming, "header");
  const cookieDeps = findAllIncoming(incoming, "cookie");
  const out: Array<[string, string]> = [];

  for (const [name, rawValue] of Object.entries(call.reqHeaders)) {
    const lower = name.toLowerCase();
    if (SKIP_HEADERS.has(lower)) continue;

    const deps =
      lower === "cookie"
        ? cookieDeps
        : (() => {
            // detectDeps guarantees at most one dep per (call, location, field).
            const dep = headerDeps.find((d) => d.consumed.field === lower);
            return dep ? [dep] : [];
          })();

    let expr: string;
    if (redact) {
      const parts = tokenize(rawValue, deps, model);
      const fullyLiteral = parts.length === 1 && parts[0]?.type === "text";
      const isSecretHeader = lower === "authorization" || lower === "cookie";
      expr =
        fullyLiteral && shouldRedact(rawValue, isSecretHeader)
          ? redactedLiteralExpr(redact.tracker, `header:${lower}`, imports)
          : goConcatExpr(rawValue, deps, model, imports, preLines);
    } else {
      expr = goConcatExpr(rawValue, deps, model, imports, preLines);
    }

    out.push([lower, expr]);
  }

  return out;
}

/** Build the request body reader expression, plus any statements needed before the `http.NewRequest` line to produce it. */
function buildBodyReader(
  call: FlowCall,
  incoming: FlowDep[],
  model: FlowModel,
  imports: Set<string>,
  preLines: string[],
  redact: { tracker: RedactionTracker } | undefined,
): { readerExpr: string; preLines: string[] } {
  if (call.reqBody === undefined) return { readerExpr: "nil", preLines: [] };

  if (call.reqJson !== undefined) {
    imports.add("bytes");
    imports.add("encoding/json");
    const depsByField = bodyJsonDepsByField(incoming);
    const valueExpr = renderGoValue(call.reqJson, "$", depsByField, model, imports, preLines);
    const bytesVar = `bodyBytes${call.index}`;
    return {
      readerExpr: `bytes.NewBuffer(${bytesVar})`,
      preLines: [`${bytesVar}, _ := json.Marshal(${valueExpr})`],
    };
  }

  // extractConsumed only emits body-json deps when reqJson parses, so a non-JSON body can
  // never have a chained var — always a plain literal, and thus a safe, simple redaction target.
  imports.add("bytes");
  if (redact && shouldRedact(call.reqBody, false)) {
    return { readerExpr: `bytes.NewBufferString(${redactedLiteralExpr(redact.tracker, "body", imports)})`, preLines: [] };
  }
  return { readerExpr: `bytes.NewBufferString(${goStringLiteral(call.reqBody)})`, preLines: [] };
}

/** Render a chained map/slice type-assertion accessor into `dataVar` (a `map[string]interface{}`), ending in `.(string)`. */
function goJsonAccessor(dataVar: string, segments: JsonPathSegment[]): string {
  let expr = dataVar;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    if (i > 0) expr += seg.type === "index" ? ".([]interface{})" : ".(map[string]interface{})";
    expr += seg.type === "index" ? `[${seg.index}]` : `[${goStringLiteral(seg.name)}]`;
  }
  return `${expr}.(string)`;
}

function jsonExtractionLines(
  varName: string,
  dataVar: string,
  segments: JsonPathSegment[],
  decodeB64: { urlSafe: boolean } | undefined,
  imports: Set<string>,
): string[] {
  if (segments.length === 0) {
    // TODO deep path: "$" itself (the whole body) has no scalar type to assert. `dataVar` is a
    // map[string]interface{} -- string-typing varName via fmt.Sprintf keeps this a valid,
    // compilable (if not pretty) placeholder instead of an untyped map that would fail to
    // compile wherever a later line string-concatenates it.
    return [`${varName} := fmt.Sprintf("%v", ${dataVar}) // TODO deep path: whole-body extraction, adjust type as needed`];
  }
  if (segments[0]?.type === "index") {
    // TODO deep path: a top-level array response doesn't fit the `map[string]interface{}`
    // this emitter always declares for the parsed body -- best-effort placeholder only.
    return [
      `// TODO deep path: top-level array response body, ${dataVar} is declared as a map -- extract ${varName} by hand`,
      `var ${varName} string`,
    ];
  }
  const expr = goJsonAccessor(dataVar, segments);
  const comment = segments.length > 1 ? " // best-effort: assumes a string leaf" : "";
  if (decodeB64) {
    imports.add("encoding/base64");
    imports.add("strings");
    return [`${varName} := ${goBase64DecodeExpr(expr, decodeB64.urlSafe)}${comment}`];
  }
  return [`${varName} := ${expr}${comment}`];
}

const COOKIE_HELPER_LINES = [
  "func cookieValue(resp *http.Response, name string) string {",
  "\tfor _, c := range resp.Cookies() {",
  "\t\tif c.Name == name {",
  "\t\t\treturn c.Value",
  "\t\t}",
  "\t}",
  '\treturn ""',
  "}",
  "",
];

function extractionLines(call: FlowCall, outgoing: FlowDep[], imports: Set<string>, model: FlowModel): string[] {
  const unique = dedupeOutgoing(outgoing);
  if (unique.length === 0) return [];

  const lines: string[] = [];
  const jsonDeps = unique.filter((d) => d.source.startsWith("json:"));
  const cookieDeps = unique.filter((d) => d.source.startsWith("cookie:"));
  const headerDeps = unique.filter((d) => d.source.startsWith("header:"));
  const otherDeps = unique.filter(
    (d) => !d.source.startsWith("json:") && !d.source.startsWith("cookie:") && !d.source.startsWith("header:"),
  );

  if (jsonDeps.length > 0) {
    imports.add("io");
    imports.add("encoding/json");
    const bodyVar = `body${call.index}`;
    const dataVar = `data${call.index}`;
    lines.push(`${bodyVar}, _ := io.ReadAll(resp${call.index}.Body)`);
    lines.push(`resp${call.index}.Body.Close()`);
    lines.push(`var ${dataVar} map[string]interface{}`);
    lines.push(`json.Unmarshal(${bodyVar}, &${dataVar})`);
    for (const dep of jsonDeps) {
      const segments = parseJsonPath(dep.source.slice("json:".length));
      const decodeB64 =
        dep.transform === "base64" && base64Direction(model, dep) === "decode"
          ? { urlSafe: base64Encoding(model, dep).urlSafe }
          : undefined;
      lines.push(...jsonExtractionLines(dep.varName, dataVar, segments, decodeB64, imports));
    }
  }

  for (const dep of cookieDeps) {
    const cookieName = dep.source.slice("cookie:".length);
    const rhs = `cookieValue(resp${call.index}, ${goStringLiteral(cookieName)})`;
    const decodeB64 = dep.transform === "base64" && base64Direction(model, dep) === "decode";
    if (decodeB64) {
      imports.add("encoding/base64");
      imports.add("strings");
    }
    lines.push(`${dep.varName} := ${decodeB64 ? goBase64DecodeExpr(rhs, base64Encoding(model, dep).urlSafe) : rhs}`);
  }

  for (const dep of headerDeps) {
    const headerName = dep.source.slice("header:".length);
    const rhs = `resp${call.index}.Header.Get(${goStringLiteral(headerName)})`;
    const decodeB64 = dep.transform === "base64" && base64Direction(model, dep) === "decode";
    if (decodeB64) {
      imports.add("encoding/base64");
      imports.add("strings");
    }
    lines.push(`${dep.varName} := ${decodeB64 ? goBase64DecodeExpr(rhs, base64Encoding(model, dep).urlSafe) : rhs}`);
  }

  for (const dep of otherDeps) {
    // Every source kind produced by extractProduced ("json:", "cookie:", "header:") is
    // handled above; this only fires if that set grows without a matching case here. A typed
    // zero-value declaration (rather than a bare comment) keeps any downstream reference to
    // varName compiling instead of undefined.
    lines.push(`var ${dep.varName} string // TODO: ${dep.source} not auto-extractable`);
  }

  return lines;
}

function buildCallLines(
  call: FlowCall,
  incoming: FlowDep[],
  outgoing: FlowDep[],
  model: FlowModel,
  imports: Set<string>,
  redact: { tracker: RedactionTracker } | undefined,
): string[] {
  const lines: string[] = [];
  const preLines: string[] = [];

  const urlExpr = buildUrlExpr(call, incoming, model, imports, preLines);
  const headerSets = buildHeaderSets(call, incoming, model, imports, preLines, redact);
  const body = buildBodyReader(call, incoming, model, imports, preLines, redact);

  lines.push(...preLines);
  lines.push(...body.preLines);

  lines.push(
    `req${call.index}, _ := http.NewRequest(${goStringLiteral(call.method)}, ${urlExpr}, ${body.readerExpr})`,
  );

  for (const [name, expr] of headerSets) {
    lines.push(`req${call.index}.Header.Set(${goStringLiteral(name)}, ${expr})`);
  }

  lines.push(`resp${call.index}, _ := client.Do(req${call.index})`);
  lines.push(`fmt.Printf("call %d: %s\\n", ${call.index}, resp${call.index}.Status)`);
  lines.push(...extractionLines(call, outgoing, imports, model));

  return lines;
}

/**
 * Emit a runnable Go `package main` (net/http) script that replays a captured flow. Values a
 * later call consumed from an earlier call's response are extracted (`io.ReadAll` +
 * `json.Unmarshal` into a `map[string]interface{}` + a chained type-assertion accessor for
 * JSON, `resp.Cookies()` for Set-Cookie, `resp.Header.Get(...)` for response headers) and
 * chained via Go variables instead of baked in as literals. A non-exact transform
 * (url-encoding, base64, a value embedded in a larger string) is decoded/encoded/extracted
 * inline; a jwt-claim dep gets a `// TODO jwt-claim` comment and falls back to the raw JWT var
 * (see `goVarRef`). Unmatched values stay literal, escaped via `JSON.stringify` for
 * Go-string-literal safety (see `goStringLiteral`) — or, with `opts.redact`, replaced by a
 * numbered `os.Getenv("BFA_SECRET_N")` placeholder when they look like a secret.
 *
 * The emitter's job is correct structure and a real chain, not gofmt-perfection -- but the
 * output is meant to be `go build`-shaped: balanced syntax, and every declared import/var
 * actually used (Go fails to compile otherwise).
 */
export function emitGo(model: FlowModel, opts?: EmitOptions): string {
  const { incomingByCall, outgoingByCall } = groupDepsByCall(model.deps);
  const needsCookieHelper = model.deps.some((d) => d.source.startsWith("cookie:"));
  const imports = new Set<string>();
  if (model.calls.length > 0) {
    imports.add("net/http");
    imports.add("fmt");
  }
  const redact = opts?.redact ? { tracker: newRedactionTracker() } : undefined;

  const callLines: string[][] = model.calls.map((call) => {
    const incoming = incomingByCall.get(call.index) ?? [];
    const outgoing = outgoingByCall.get(call.index) ?? [];
    return buildCallLines(call, incoming, outgoing, model, imports, redact);
  });

  const lines: string[] = [
    "// Extracted by browser-for-ai from a real browser session. Unmatched values are literals — review before use.",
    "package main",
    "",
  ];

  const importList = Array.from(imports).sort();
  if (importList.length > 0) {
    lines.push("import (");
    for (const imp of importList) lines.push(`\t${goStringLiteral(imp)}`);
    lines.push(")");
    lines.push("");
  }

  if (needsCookieHelper) lines.push(...COOKIE_HELPER_LINES);

  lines.push("func main() {");
  if (model.calls.length > 0) {
    lines.push("\tclient := &http.Client{}");
    lines.push("");
  }
  for (const block of callLines) {
    for (const l of block) lines.push(`\t${l}`);
    lines.push("");
  }
  lines.push("}");

  let out = `${lines.join("\n").trimEnd()}\n`;
  if (redact && redact.tracker.entries.length > 0) {
    out = `${redactionHeaderComment(redact.tracker, "//").join("\n")}\n${out}`;
  }
  return out;
}
