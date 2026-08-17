import type { FlowCall, FlowDep, FlowModel } from "../types";
import {
  SKIP_HEADERS,
  base64Direction,
  base64Encoding,
  bodyJsonDepsByField,
  claimPathSegments,
  claimVarName,
  dedupeOutgoing,
  findAllIncoming,
  groupDepsByCall,
  newRedactionTracker,
  parseJsonPath,
  pyAccessor,
  redactionHeaderComment,
  registerSecret,
  shouldRedact,
  tokenize,
  urlencDirection,
  type EmitOptions,
  type RedactionTracker,
} from "./shared";

/**
 * A plain Python string literal. `JSON.stringify` and Python's double-quoted string syntax
 * agree on the escapes that matter here (`\"`, `\\`, `\n`, `\r`, `\t`, `\uXXXX` for control
 * chars), so reusing it is a safe shortcut for the common case; it does not cover ES2015+
 * `\u{...}` code-point escapes, which JSON.stringify never emits anyway.
 */
function pyStringLiteral(text: string): string {
  return JSON.stringify(text);
}

/** The escaped inner contents of a Python string literal, without the surrounding quotes (for building f-strings). */
function pyInnerEscaped(text: string): string {
  return pyStringLiteral(text).slice(1, -1);
}

/** Escape literal text for embedding inside an f-string body: string-escape it, then double any brace so it isn't read as a format expression. */
function pyEscapeFStringText(s: string): string {
  return pyInnerEscaped(s).replace(/\{/g, "{{").replace(/\}/g, "}}");
}

/**
 * The Python expression (and any setup statement(s) it needs beforehand) that refer to a
 * dep's value, honoring its transform — same shape as the TS emitter's `tsVarRef`. Each
 * jwt-claim dep gets its own namespaced intermediate variable names (via `claimVarName`) so
 * two different claims off two different JWTs used in the same call never collide.
 */
function pyVarRef(model: FlowModel, dep: FlowDep): { expr: string; preLines: string[] } {
  if (dep.transform === "urlenc") {
    const dir = urlencDirection(model, dep);
    return dir === "decode"
      ? { expr: `urllib.parse.unquote(${dep.varName})`, preLines: [] }
      : { expr: `urllib.parse.quote(${dep.varName}, safe="")`, preLines: [] };
  }
  if (dep.transform === "base64" && base64Direction(model, dep) === "encode") {
    const { urlSafe, padded } = base64Encoding(model, dep);
    const encodeFn = urlSafe ? "base64.urlsafe_b64encode" : "base64.b64encode";
    const expr = `${encodeFn}(${dep.varName}.encode()).decode()`;
    // Python's b64encode/urlsafe_b64encode always pad; strip it back off to match a wire
    // literal that was captured unpadded (common for url-safe tokens/JWT-adjacent values).
    return { expr: padded ? expr : `${expr}.rstrip("=")`, preLines: [] };
  }
  if (dep.transform === "jwt-claim") {
    const cvar = claimVarName(dep);
    const b64var = `_${cvar}_b64`;
    const accessor = pyAccessor("", claimPathSegments(dep));
    return {
      expr: cvar,
      preLines: [
        `${b64var} = ${dep.varName}.split(".")[1]`,
        `${b64var} += "=" * (-len(${b64var}) % 4)`,
        `${cvar} = json.loads(base64.urlsafe_b64decode(${b64var}))${accessor}`,
      ],
    };
  }
  return { expr: dep.varName, preLines: [] };
}

function addPreLines(target: string[], lines: string[]): void {
  for (const l of lines) if (!target.includes(l)) target.push(l);
}

/** Render a raw string with dep substitutions: a plain string literal if nothing matched, a bare expression if the whole string is a single (possibly transform-wrapped) var, else an f-string with `{expr}` interpolation. */
function renderTemplateExpr(raw: string, deps: FlowDep[], model: FlowModel, preLines: string[]): string {
  const parts = tokenize(raw, deps, model);
  if (parts.length === 1 && parts[0]?.type === "text") return pyStringLiteral(raw);
  if (parts.length === 1 && parts[0]?.type === "var") {
    const { expr, preLines: pl } = pyVarRef(model, parts[0].dep);
    addPreLines(preLines, pl);
    return expr;
  }
  const body = parts
    .map((p) => {
      if (p.type === "text") return pyEscapeFStringText(p.text);
      const { expr, preLines: pl } = pyVarRef(model, p.dep);
      addPreLines(preLines, pl);
      return `{${expr}}`;
    })
    .join("");
  return `f"${body}"`;
}

/** Recursively render a parsed JSON value as a Python dict/list/literal expression, substituting any leaf whose json-path matches a body-json dep with its (bare) transform-aware expression instead of its literal value. See `renderJsValue` (ts.ts) for the same "substring loses its container" limitation. */
function renderPyValue(
  value: unknown,
  path: string,
  depsByField: Map<string, FlowDep>,
  model: FlowModel,
  preLines: string[],
): string {
  if (value === null || value === undefined) return "None";
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => renderPyValue(v, `${path}[${i}]`, depsByField, model, preLines)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${pyStringLiteral(k)}: ${renderPyValue(v, `${path}.${k}`, depsByField, model, preLines)}`,
    );
    return entries.length > 0 ? `{${entries.join(", ")}}` : "{}";
  }
  const dep = depsByField.get(path);
  if (dep) {
    const { expr, preLines: pl } = pyVarRef(model, dep);
    addPreLines(preLines, pl);
    return expr;
  }
  if (typeof value === "string") return pyStringLiteral(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function redactedLiteralExpr(tracker: RedactionTracker, location: string): string {
  return `os.environ[${pyStringLiteral(registerSecret(tracker, location))}]`;
}

function buildUrlExpr(call: FlowCall, incoming: FlowDep[], model: FlowModel, preLines: string[]): string {
  return renderTemplateExpr(call.url, findAllIncoming(incoming, "url-query"), model, preLines);
}

function buildHeadersExpr(
  call: FlowCall,
  incoming: FlowDep[],
  model: FlowModel,
  preLines: string[],
  redact: { tracker: RedactionTracker } | undefined,
): string | undefined {
  const headerDeps = findAllIncoming(incoming, "header");
  const cookieDeps = findAllIncoming(incoming, "cookie");
  const entries: string[] = [];

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
          ? redactedLiteralExpr(redact.tracker, `header:${lower}`)
          : renderTemplateExpr(rawValue, deps, model, preLines);
    } else {
      expr = renderTemplateExpr(rawValue, deps, model, preLines);
    }

    entries.push(`${pyStringLiteral(lower)}: ${expr}`);
  }

  return entries.length > 0 ? `{${entries.join(", ")}}` : undefined;
}

/** Render the `json=`/`data=` kwarg: a dict literal (deps substituted at their leaf) when the request body is JSON, else a plain string for the raw body (or a redacted placeholder, when `redact` is on and it looks like a secret). */
function buildBodyKwarg(
  call: FlowCall,
  incoming: FlowDep[],
  model: FlowModel,
  preLines: string[],
  redact: { tracker: RedactionTracker } | undefined,
): { kwarg: string; expr: string } | undefined {
  if (call.reqBody === undefined) return undefined;
  if (call.reqJson !== undefined) {
    const depsByField = bodyJsonDepsByField(incoming);
    return { kwarg: "json", expr: renderPyValue(call.reqJson, "$", depsByField, model, preLines) };
  }
  // extractConsumed only emits body-json deps when reqJson parses, so a non-JSON body can never
  // have a chained var — it's always fully literal, and thus a safe, simple redaction target.
  if (redact && shouldRedact(call.reqBody, false)) {
    return { kwarg: "data", expr: redactedLiteralExpr(redact.tracker, "body") };
  }
  return { kwarg: "data", expr: pyStringLiteral(call.reqBody) };
}

const METHOD_ATTR: Record<string, string> = {
  GET: "get",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
  HEAD: "head",
  OPTIONS: "options",
};

function buildRequestLine(
  call: FlowCall,
  incoming: FlowDep[],
  model: FlowModel,
  redact: { tracker: RedactionTracker } | undefined,
): { line: string; preLines: string[] } {
  const preLines: string[] = [];
  const urlExpr = buildUrlExpr(call, incoming, model, preLines);
  const headersExpr = buildHeadersExpr(call, incoming, model, preLines, redact);
  const body = buildBodyKwarg(call, incoming, model, preLines, redact);

  const kwargs: string[] = [];
  if (headersExpr) kwargs.push(`headers=${headersExpr}`);
  if (body) kwargs.push(`${body.kwarg}=${body.expr}`);

  const methodAttr = METHOD_ATTR[call.method.toUpperCase()];
  const callExpr = methodAttr
    ? `requests.${methodAttr}(${[urlExpr, ...kwargs].join(", ")})`
    : `requests.request(${[pyStringLiteral(call.method), urlExpr, ...kwargs].join(", ")})`;

  return { line: `r${call.index} = ${callExpr}`, preLines };
}

function extractionLines(call: FlowCall, outgoing: FlowDep[], model: FlowModel): string[] {
  const unique = dedupeOutgoing(outgoing);
  if (unique.length === 0) return [];

  const lines: string[] = [];
  if (unique.some((d) => d.source.startsWith("json:"))) {
    lines.push(`j${call.index} = r${call.index}.json()`);
  }

  for (const dep of unique) {
    const decodeB64 = dep.transform === "base64" && base64Direction(model, dep) === "decode";
    let rhs: string;
    if (dep.source.startsWith("json:")) {
      const segments = parseJsonPath(dep.source.slice("json:".length));
      rhs = pyAccessor(`j${call.index}`, segments);
    } else if (dep.source.startsWith("cookie:")) {
      rhs = `_cookie_value(r${call.index}.headers.get("set-cookie"))`;
    } else if (dep.source.startsWith("header:")) {
      const headerName = dep.source.slice("header:".length);
      rhs = `r${call.index}.headers.get(${pyStringLiteral(headerName)}, "")`;
    } else {
      // Every source kind produced by extractProduced ("json:", "cookie:", "header:") is
      // handled above; this only fires if that set grows without a matching case here.
      lines.push(`# TODO: extract ${dep.source} for ${dep.varName} (unrecognized source kind)`);
      continue;
    }
    let decodeExpr = rhs;
    if (decodeB64) {
      const decodeFn = base64Encoding(model, dep).urlSafe ? "base64.urlsafe_b64decode" : "base64.b64decode";
      // Both b64decode and urlsafe_b64decode require correct padding (Python raises
      // binascii.Error otherwise); a captured wire literal is often padding-stripped, so pad
      // via the shared helper rather than assuming the RHS expression already has it.
      decodeExpr = `${decodeFn}(_b64pad(${rhs})).decode()`;
    }
    lines.push(`${dep.varName} = ${decodeExpr}`);
  }
  return lines;
}

const COOKIE_HELPER_LINES = [
  "def _cookie_value(set_cookie):",
  "    if not set_cookie:",
  '        return ""',
  '    pair = set_cookie.split(";")[0]',
  '    if "=" not in pair:',
  '        return ""',
  '    return pair.split("=", 1)[1]',
  "",
];

/** Pad a (possibly padding-stripped) base64/base64url string to a multiple of 4 -- both
 *  `base64.b64decode` and `base64.urlsafe_b64decode` raise `binascii.Error` on a short input,
 *  and a captured wire literal is often padding-stripped (common for url-safe tokens). */
const B64PAD_HELPER_LINES = ["def _b64pad(s):", '    return s + "=" * (-len(s) % 4)', ""];

/** Every stdlib import a model's transforms/redaction require, sorted (excludes "requests", which is always first). */
function collectExtraImports(model: FlowModel, redactActive: boolean): string[] {
  const imports = new Set<string>();
  for (const dep of model.deps) {
    if (dep.transform === "urlenc") imports.add("urllib.parse");
    if (dep.transform === "base64") imports.add("base64");
    if (dep.transform === "jwt-claim") {
      imports.add("base64");
      imports.add("json");
    }
  }
  if (redactActive) imports.add("os");
  return Array.from(imports).sort();
}

/**
 * Emit a `requests`-based Python script that replays a captured flow. Values a later call
 * consumed from an earlier call's response are extracted (`.json()["..."]` for JSON, a small
 * cookie-parsing helper for Set-Cookie, `.headers.get(...)` for response headers) and chained
 * via plain variable assignments instead of baked in as literals. A non-exact transform
 * (url-encoding, base64, a JWT claim, a value embedded in a larger string) is
 * decoded/encoded/extracted inline. Unmatched values stay literal, escaped via
 * `JSON.stringify` (a safe Python string literal for common cases — see `pyStringLiteral`) —
 * or, with `opts.redact`, replaced by a numbered `os.environ["BFA_SECRET_N"]` placeholder
 * when they look like a secret.
 */
export function emitPython(model: FlowModel, opts?: EmitOptions): string {
  const { incomingByCall, outgoingByCall } = groupDepsByCall(model.deps);
  const needsCookieHelper = model.deps.some((d) => d.source.startsWith("cookie:"));
  const needsB64PadHelper = model.deps.some(
    (d) => d.transform === "base64" && base64Direction(model, d) === "decode",
  );
  const redact = opts?.redact ? { tracker: newRedactionTracker() } : undefined;
  const extraImports = collectExtraImports(model, !!opts?.redact);

  const lines: string[] = [
    "# Extracted by browser-for-ai from a real browser session.",
    "# Unmatched values are literals -- review before use.",
    "import requests",
    ...extraImports.map((m) => `import ${m}`),
    "",
  ];

  if (needsCookieHelper) lines.push(...COOKIE_HELPER_LINES);
  if (needsB64PadHelper) lines.push(...B64PAD_HELPER_LINES);

  for (const call of model.calls) {
    const incoming = incomingByCall.get(call.index) ?? [];
    const outgoing = outgoingByCall.get(call.index) ?? [];
    const { line, preLines } = buildRequestLine(call, incoming, model, redact);
    lines.push(...preLines);
    lines.push(line);
    lines.push(...extractionLines(call, outgoing, model));
    lines.push("");
  }

  let out = `${lines.join("\n").trimEnd()}\n`;
  if (redact && redact.tracker.entries.length > 0) {
    out = `${redactionHeaderComment(redact.tracker, "#").join("\n")}\n${out}`;
  }
  return out;
}
