import type { FlowCall, FlowDep, FlowModel } from "../types";
import {
  JS_IDENT_RE,
  SKIP_HEADERS,
  base64Direction,
  base64Encoding,
  bodyJsonDepsByField,
  claimPathSegments,
  claimVarName,
  dedupeOutgoing,
  findAllIncoming,
  groupDepsByCall,
  jsAccessor,
  newRedactionTracker,
  parseJsonPath,
  redactionHeaderComment,
  registerSecret,
  shouldRedact,
  tokenize,
  urlencDirection,
  type EmitOptions,
  type RedactionTracker,
} from "./shared";

/** A plain JS string literal, safely escaped via JSON.stringify (quotes/backslashes/newlines/`$` all handled). */
function jsStringLiteral(text: string): string {
  return JSON.stringify(text);
}

/**
 * Escape literal text for embedding inside a JS template literal: backslash, backtick, and
 * `$` all need neutralizing so pre-existing data (e.g. a literal `${...}`-looking substring,
 * or an OData `$filter`) can never be read as real interpolation. `\$` is a valid escape for
 * a literal `$` in JS, so this is always safe — mirrors the curl emitter's shell-escaping.
 */
function tsEscapeTemplateText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

/**
 * The base64-encode expression for a plaintext var, matching BOTH the alphabet and padding
 * style the wire literal actually used (`base64Encoding`). Node's `Buffer#toString` fixes
 * padding per alphabet — `"base64url"` NEVER pads, `"base64"` ALWAYS pads when the input length
 * isn't a multiple of 3 — so the two combinations that don't match Node's default need an
 * explicit fixup: url-safe-but-padded pads the (naturally unpadded) base64url output back out;
 * standard-but-unpadded strips the padding `"base64"` always adds.
 */
function tsBase64EncodeExpr(varName: string, urlSafe: boolean, padded: boolean): string {
  const mode = jsStringLiteral(urlSafe ? "base64url" : "base64");
  if (urlSafe && padded) {
    return `(() => { const s = Buffer.from(${varName}).toString(${mode}); return s + "=".repeat((4 - (s.length % 4)) % 4); })()`;
  }
  if (!urlSafe && !padded) {
    return `Buffer.from(${varName}).toString(${mode}).replace(/=+$/, "")`;
  }
  return `Buffer.from(${varName}).toString(${mode})`;
}

/**
 * The JS expression (and any setup statement(s) it needs beforehand) that refer to a dep's
 * value, honoring its transform:
 * - exact / substring / base64-decode-direction: the extracted var is already the right value
 *   (decode, when needed, happens once at extraction — see `extractionLines`), so a bare
 *   reference suffices.
 * - urlenc: encode (or, when the producer's literal was already percent-encoded and the
 *   consumer used the decoded form, decode) at this use site — see `urlencDirection`.
 * - base64 (encode-direction): the extracted var is plaintext; encode at this use site, in
 *   whichever alphabet AND padding style the wire literal actually used (`base64Encoding`,
 *   `tsBase64EncodeExpr`) — `Buffer`, not `btoa`, since `btoa` has no url-safe mode and this
 *   script already requires Node.
 * - jwt-claim: emit a one-line inline JWT-payload decode + claim access as a preLine, then
 *   reference the resulting claim var. JWT segments are ALWAYS base64url (RFC 7515) regardless
 *   of what any other base64 dep in this flow looks like, so this is unconditional — and uses
 *   `Buffer.from(seg, "base64url")`, not `atob` (which throws on `-`/`_`).
 */
function tsVarRef(model: FlowModel, dep: FlowDep): { expr: string; preLines: string[] } {
  if (dep.transform === "urlenc") {
    const dir = urlencDirection(model, dep);
    const call = dir === "decode" ? "decodeURIComponent" : "encodeURIComponent";
    return { expr: `${call}(${dep.varName})`, preLines: [] };
  }
  if (dep.transform === "base64" && base64Direction(model, dep) === "encode") {
    const { urlSafe, padded } = base64Encoding(model, dep);
    return { expr: tsBase64EncodeExpr(dep.varName, urlSafe, padded), preLines: [] };
  }
  if (dep.transform === "jwt-claim") {
    const cvar = claimVarName(dep);
    const accessor = jsAccessor("", claimPathSegments(dep));
    return {
      expr: cvar,
      preLines: [
        `const ${cvar} = JSON.parse(Buffer.from(${dep.varName}.split(".")[1], "base64url").toString())${accessor};`,
      ],
    };
  }
  return { expr: dep.varName, preLines: [] };
}

function addPreLines(target: string[], lines: string[]): void {
  for (const l of lines) if (!target.includes(l)) target.push(l);
}

/**
 * Render a raw string with dep substitutions: a plain string literal if nothing matched, a
 * bare expression if the whole string is a single (possibly transform-wrapped) var, else a
 * template literal with `${expr}` interpolation. Any setup statement(s) a referenced dep needs
 * (e.g. a JWT claim decode) are appended to `preLines`.
 */
function renderTemplateExpr(raw: string, deps: FlowDep[], model: FlowModel, preLines: string[]): string {
  const parts = tokenize(raw, deps, model);
  if (parts.length === 1 && parts[0]?.type === "text") return jsStringLiteral(raw);
  if (parts.length === 1 && parts[0]?.type === "var") {
    const { expr, preLines: pl } = tsVarRef(model, parts[0].dep);
    addPreLines(preLines, pl);
    return expr;
  }
  const body = parts
    .map((p) => {
      if (p.type === "text") return tsEscapeTemplateText(p.text);
      const { expr, preLines: pl } = tsVarRef(model, p.dep);
      addPreLines(preLines, pl);
      return `\${${expr}}`;
    })
    .join("");
  return `\`${body}\``;
}

function renderKey(key: string): string {
  return JS_IDENT_RE.test(key) ? key : jsStringLiteral(key);
}

/**
 * Recursively render a parsed JSON value as a JS object/array/literal expression, substituting
 * any leaf whose json-path matches a body-json dep with its (bare, unquoted) transform-aware
 * expression instead of its literal value. NOTE: unlike headers/url, this substitutes the
 * whole leaf rather than tokenizing it against a raw string, so a "substring" transform here
 * still falls back to a bare var (losing the surrounding literal the value was embedded in) —
 * a known, narrow limitation left for a follow-up (JSON-body leaves rarely carry `substring`
 * matches in practice; headers/url/cookie, the common case, are handled precisely).
 */
function renderJsValue(
  value: unknown,
  path: string,
  depsByField: Map<string, FlowDep>,
  model: FlowModel,
  preLines: string[],
): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => renderJsValue(v, `${path}[${i}]`, depsByField, model, preLines)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${renderKey(k)}: ${renderJsValue(v, `${path}.${k}`, depsByField, model, preLines)}`,
    );
    return entries.length > 0 ? `{ ${entries.join(", ")} }` : "{}";
  }
  const dep = depsByField.get(path);
  if (dep) {
    const { expr, preLines: pl } = tsVarRef(model, dep);
    addPreLines(preLines, pl);
    return expr;
  }
  if (typeof value === "string") return jsStringLiteral(value);
  return String(value);
}

function redactedLiteralExpr(tracker: RedactionTracker, location: string): string {
  return `process.env.${registerSecret(tracker, location)}`;
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

    entries.push(`${renderKey(lower)}: ${expr}`);
  }

  return entries.length > 0 ? `{ ${entries.join(", ")} }` : undefined;
}

/** Render the fetch `body` option: a `JSON.stringify(...)` object literal when the request body is JSON (with chained deps substituted at their leaf), else a plain string literal (or a redacted placeholder, when `redact` is on and it looks like a secret). */
function buildBodyExpr(
  call: FlowCall,
  incoming: FlowDep[],
  model: FlowModel,
  preLines: string[],
  redact: { tracker: RedactionTracker } | undefined,
): string | undefined {
  if (call.reqBody === undefined) return undefined;
  if (call.reqJson !== undefined) {
    const depsByField = bodyJsonDepsByField(incoming);
    return `JSON.stringify(${renderJsValue(call.reqJson, "$", depsByField, model, preLines)})`;
  }
  // extractConsumed only emits body-json deps when reqJson parses, so a non-JSON body can never
  // have a chained var — it's always fully literal, and thus a safe, simple redaction target.
  if (redact && shouldRedact(call.reqBody, false)) {
    return redactedLiteralExpr(redact.tracker, "body");
  }
  return jsStringLiteral(call.reqBody);
}

function buildFetchLines(
  call: FlowCall,
  incoming: FlowDep[],
  model: FlowModel,
  redact: { tracker: RedactionTracker } | undefined,
): { lines: string[]; preLines: string[] } {
  const preLines: string[] = [];
  const urlExpr = buildUrlExpr(call, incoming, model, preLines);
  const headersExpr = buildHeadersExpr(call, incoming, model, preLines, redact);
  const bodyExpr = buildBodyExpr(call, incoming, model, preLines, redact);

  const optionLines: string[] = [`  method: ${jsStringLiteral(call.method)},`];
  if (headersExpr) optionLines.push(`  headers: ${headersExpr},`);
  if (bodyExpr) optionLines.push(`  body: ${bodyExpr},`);

  return { lines: [`const r${call.index} = await fetch(${urlExpr}, {`, ...optionLines, "});"], preLines };
}

function extractionLines(call: FlowCall, outgoing: FlowDep[], model: FlowModel): string[] {
  const unique = dedupeOutgoing(outgoing);
  if (unique.length === 0) return [];

  const lines: string[] = [];
  if (unique.some((d) => d.source.startsWith("json:"))) {
    lines.push(`const j${call.index} = await r${call.index}.json();`);
  }

  for (const dep of unique) {
    const decodeB64 = dep.transform === "base64" && base64Direction(model, dep) === "decode";
    let rhs: string;
    if (dep.source.startsWith("json:")) {
      const segments = parseJsonPath(dep.source.slice("json:".length));
      rhs = jsAccessor(`j${call.index}`, segments);
    } else if (dep.source.startsWith("cookie:")) {
      rhs = `readCookieValue(r${call.index}.headers.get("set-cookie"))`;
    } else if (dep.source.startsWith("header:")) {
      const headerName = dep.source.slice("header:".length);
      rhs = `r${call.index}.headers.get(${jsStringLiteral(headerName)}) ?? ""`;
    } else {
      // Every source kind produced by extractProduced ("json:", "cookie:", "header:") is
      // handled above; this only fires if that set grows without a matching case here.
      lines.push(`// TODO: extract ${dep.source} for ${dep.varName} (unrecognized source kind)`);
      continue;
    }
    const decodeExpr = decodeB64
      ? `Buffer.from(${rhs}, ${jsStringLiteral(base64Encoding(model, dep).urlSafe ? "base64url" : "base64")}).toString()`
      : rhs;
    lines.push(`const ${dep.varName} = ${decodeExpr};`);
  }
  return lines;
}

const COOKIE_HELPER_LINES = [
  "function readCookieValue(setCookieHeader) {",
  '  if (!setCookieHeader) return "";',
  '  const pair = setCookieHeader.split(";")[0] ?? "";',
  '  const eq = pair.indexOf("=");',
  '  return eq === -1 ? "" : pair.slice(eq + 1);',
  "}",
  "",
];

/**
 * Emit a Node (18+, global fetch) script that replays a captured flow. Values a later call
 * consumed from an earlier call's response are extracted (`.json()` + a property-access
 * chain for JSON, a small cookie-parsing helper for Set-Cookie, `.headers.get(...)` for
 * response headers) and chained via `const` bindings instead of baked in as literals. A
 * non-exact transform (url-encoding, base64, a JWT claim, a value embedded in a larger
 * string) is decoded/encoded/extracted inline. Unmatched values stay literal, escaped via
 * `JSON.stringify` for string safety — or, with `opts.redact`, replaced by a numbered
 * `process.env.BFA_SECRET_N` placeholder when they look like a secret.
 */
export function emitTs(model: FlowModel, opts?: EmitOptions): string {
  const { incomingByCall, outgoingByCall } = groupDepsByCall(model.deps);
  const needsCookieHelper = model.deps.some((d) => d.source.startsWith("cookie:"));
  const redact = opts?.redact ? { tracker: newRedactionTracker() } : undefined;

  const lines: string[] = [
    "// Extracted by browser-for-ai from a real browser session.",
    "// Unmatched values are literals -- review before use.",
    "// Requires Node 18+ (global fetch).",
    "",
  ];

  if (needsCookieHelper) lines.push(...COOKIE_HELPER_LINES);

  lines.push("async function run() {");
  for (const call of model.calls) {
    const incoming = incomingByCall.get(call.index) ?? [];
    const outgoing = outgoingByCall.get(call.index) ?? [];
    const { lines: fetchLines, preLines } = buildFetchLines(call, incoming, model, redact);
    for (const l of preLines) lines.push(`  ${l}`);
    for (const l of fetchLines) lines.push(`  ${l}`);
    for (const l of extractionLines(call, outgoing, model)) lines.push(`  ${l}`);
    lines.push("");
  }
  lines.push("}");
  lines.push("");
  lines.push("run();");

  let out = `${lines.join("\n").trimEnd()}\n`;
  if (redact && redact.tracker.entries.length > 0) {
    out = `${redactionHeaderComment(redact.tracker, "//").join("\n")}\n${out}`;
  }
  return out;
}
