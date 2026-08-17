import type { FlowCall, FlowConsumedValue, FlowDep, FlowModel } from "../types";
import {
  base64Direction,
  base64Encoding,
  newRedactionTracker,
  redactionHeaderComment,
  registerSecret,
  resolveSearchValue,
  shouldRedact,
  type EmitOptions,
  type RedactionTracker,
} from "./shared";

const SKIP_HEADERS = new Set(["host", "content-length", "connection"]);

/** Single-quote a string for bash, escaping embedded single quotes. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Escape a string for embedding inside a double-quoted bash string: `\`, `$`,
 * `"`, and `` ` `` all have special meaning there and must be neutralized.
 * Backslash MUST be escaped first so we don't double-escape the backslashes
 * this function itself introduces for the other three characters.
 */
function shDoubleEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/"/g, '\\"').replace(/`/g, "\\`");
}

function findAllIncoming(deps: FlowDep[], location: FlowConsumedValue["location"]): FlowDep[] {
  return deps.filter((d) => d.consumed.location === location);
}

/**
 * The shell reference for a dep at its use site, honoring its transform:
 * - exact / substring / urlenc / base64 (decode-direction) / jwt-claim: a bare `$varName`.
 *   urlenc leaves the raw var as-is (curl sends bytes verbatim; a note explains the field is
 *   url-encoded on the wire — see `curlNoteLines`). jwt-claim falls back to the raw JWT var
 *   with a `# TODO jwt-claim` note (a full JWT decode in bash is verbose — see the brief).
 * - base64 (encode-direction): the extracted var is plaintext; encode it inline at this use
 *   site via a `base64` command substitution, in whichever alphabet (and padding style) the
 *   wire literal actually used — see `base64Encoding`. `printf '%s'`, not `echo`, feeds the
 *   value in: `echo` appends a trailing newline that `base64` would encode as part of the
 *   input, corrupting the result.
 */
function curlVarRef(dep: FlowDep, model: FlowModel): string {
  if (dep.transform === "base64" && base64Direction(model, dep) === "encode") {
    const { urlSafe, padded } = base64Encoding(model, dep);
    // `base64` (no flags) always emits the padded standard alphabet; `padded: false` needs the
    // trailing `=` stripped regardless of alphabet -- this applied unconditionally in the
    // std-alphabet branch too (previously it only stripped when url-safe).
    const stripPadding = padded ? "" : " | tr -d '='";
    if (!urlSafe) return `$(printf '%s' "$${dep.varName}" | base64${stripPadding})`;
    return `$(printf '%s' "$${dep.varName}" | base64 | tr '+/' '-_'${stripPadding})`;
  }
  return `$${dep.varName}`;
}

/** `# note`/`# TODO` lines a call's rendered deps call for, deduped by exact text. */
function curlNoteLines(usedDeps: FlowDep[]): string[] {
  const lines: string[] = [];
  for (const dep of usedDeps) {
    if (dep.transform === "urlenc") {
      lines.push(`# note: $${dep.varName} is used url-encoded on the wire here`);
    } else if (dep.transform === "jwt-claim") {
      lines.push(
        `# TODO jwt-claim: extract "${dep.claimPath ?? ""}" from $${dep.varName} (JWT) -- using the raw token as a fallback`,
      );
    }
  }
  return lines;
}

/**
 * Build a bash-safe rendering of `raw`, substituting each matching dep's search value (see
 * `resolveSearchValue` — the produced literal for "substring", else the consumed literal) with
 * its transform-aware shell reference (see `curlVarRef`).
 *
 * Escape-then-inject: the whole string is escaped first (so any `$`/`"`/`\`/
 * backtick already present in captured data is neutralized), and only then
 * are dep values — escaped the same way, so they still line up — swapped for
 * their shell reference. This guarantees the only *unescaped* `$` in the result
 * are the ones we intentionally inject; a pre-existing literal `$` (e.g. an
 * OData `$filter` query param, or a `"$19.99"` body value) can never get
 * shell-expanded.
 *
 * Deps are applied longest-search-value-first: if one dep's value happens
 * to be a substring of another's (e.g. "abcd" inside "abcdef"), substituting
 * the shorter one first would corrupt the longer occurrence. Longest-first
 * avoids that.
 */
function substituteForDoubleQuote(
  raw: string,
  deps: FlowDep[],
  model: FlowModel,
): { text: string; hasVar: boolean; usedDeps: FlowDep[] } {
  const matching = deps
    .map((d) => ({ dep: d, searchValue: resolveSearchValue(model, d) }))
    .filter((x) => x.searchValue.length > 0 && raw.includes(x.searchValue));
  if (matching.length === 0) return { text: raw, hasVar: false, usedDeps: [] };

  const sorted = [...matching].sort((a, b) => b.searchValue.length - a.searchValue.length);
  let escaped = shDoubleEscape(raw);
  for (const { dep, searchValue } of sorted) {
    const escapedValue = shDoubleEscape(searchValue);
    escaped = escaped.split(escapedValue).join(curlVarRef(dep, model));
  }
  return { text: escaped, hasVar: true, usedDeps: matching.map((m) => m.dep) };
}

function quoteUrl(built: { text: string; hasVar: boolean }): string {
  return built.hasVar ? `"${built.text}"` : shSingleQuote(built.text);
}

function headerArg(name: string, built: { text: string; hasVar: boolean }): string {
  const content = `${name.toLowerCase()}: ${built.text}`;
  return built.hasVar ? `-H "${content}"` : `-H ${shSingleQuote(content)}`;
}

function redactedShellRef(tracker: RedactionTracker, location: string): string {
  return `$${registerSecret(tracker, location)}`;
}

/**
 * Decode a url-safe (`-`/`_`) base64 blob read from stdin, tolerant of missing padding. Plain
 * `base64 -d` on BSD/macOS doesn't understand `-`/`_` and — worse than erroring — silently
 * decodes the wrong bytes (verified: it truncates instead of raising); GNU `base64 -d` rejects
 * `-`/`_` outright. Normalizing to the standard alphabet and padding to a multiple of 4 first
 * makes this portable across both.
 */
const B64URL_DECODE_HELPER_LINES = [
  "_b64url_decode() {",
  "  local s",
  "  s=$(tr '_-' '/+')",
  "  case $(( ${#s} % 4 )) in",
  '    2) s="${s}==" ;;',
  '    3) s="${s}=" ;;',
  "  esac",
  '  printf \'%s\' "$s" | base64 -d',
  "}",
  "",
];

/** Substitute any consumed url-query values in the request URL with their shell reference. */
function buildUrl(call: FlowCall, incoming: FlowDep[], model: FlowModel, notes: Set<string>): { text: string; hasVar: boolean } {
  const built = substituteForDoubleQuote(call.url, findAllIncoming(incoming, "url-query"), model);
  for (const l of curlNoteLines(built.usedDeps)) notes.add(l);
  return built;
}

/** Build `-H` args, substituting any consumed header/cookie values with their shell reference (or a redacted placeholder, for an unmatched secret-bearing header when `redact` is on). */
function buildHeaderArgs(
  call: FlowCall,
  incoming: FlowDep[],
  model: FlowModel,
  redact: { tracker: RedactionTracker } | undefined,
  notes: Set<string>,
): string[] {
  const headerDeps = findAllIncoming(incoming, "header");
  const cookieDeps = findAllIncoming(incoming, "cookie");
  const args: string[] = [];

  for (const [name, rawValue] of Object.entries(call.reqHeaders)) {
    const lower = name.toLowerCase();
    if (SKIP_HEADERS.has(lower)) continue;

    const deps =
      lower === "cookie"
        ? // A single Cookie header can carry several chained pairs (sid=..; other=..) --
          // substituteForDoubleQuote handles multiple deps against one string already.
          cookieDeps
        : (() => {
            // detectDeps guarantees at most one dep per (call, location, field), so this
            // `find` can't silently pick the wrong one among several candidates.
            const dep = headerDeps.find((d) => d.consumed.field === lower);
            return dep ? [dep] : [];
          })();

    let built = substituteForDoubleQuote(rawValue, deps, model);
    for (const l of curlNoteLines(built.usedDeps)) notes.add(l);

    if (redact && !built.hasVar) {
      const isSecretHeader = lower === "authorization" || lower === "cookie";
      if (shouldRedact(rawValue, isSecretHeader)) {
        built = { text: redactedShellRef(redact.tracker, `header:${lower}`), hasVar: true, usedDeps: [] };
      }
    }

    args.push(headerArg(name, built));
  }

  return args;
}

/** Build the `-d` arg, substituting any consumed body-json values with their shell reference (or a redacted placeholder, for an unmatched secret-looking body when `redact` is on). */
function buildBodyArg(
  call: FlowCall,
  incoming: FlowDep[],
  model: FlowModel,
  redact: { tracker: RedactionTracker } | undefined,
  notes: Set<string>,
): string | undefined {
  if (call.reqBody === undefined) return undefined;
  let built = substituteForDoubleQuote(call.reqBody, findAllIncoming(incoming, "body-json"), model);
  for (const l of curlNoteLines(built.usedDeps)) notes.add(l);

  if (redact && !built.hasVar && shouldRedact(call.reqBody, false)) {
    built = { text: redactedShellRef(redact.tracker, "body"), hasVar: true, usedDeps: [] };
  }

  return built.hasVar ? `-d "${built.text}"` : `-d ${shSingleQuote(built.text)}`;
}

/** Dedupe outgoing deps by (source, varName) — one extraction line per produced value. */
function dedupeOutgoing(deps: FlowDep[]): FlowDep[] {
  const seen = new Set<string>();
  const out: FlowDep[] = [];
  for (const dep of deps) {
    const key = `${dep.source}::${dep.varName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dep);
  }
  return out;
}

/** Convert a produced json source like "$.token" / "$.data[0].id" / "$" into a jq filter. */
function toJqPath(source: string): string {
  let s = source.startsWith("$") ? source.slice(1) : source;
  if (s === "") return ".";
  if (!s.startsWith(".")) s = `.${s}`;
  return s;
}

function extractionLines(respRef: string, dep: FlowDep, headerDumpPath: string, model: FlowModel): string[] {
  const decodeB64 = dep.transform === "base64" && base64Direction(model, dep) === "decode";
  // BSD/macOS `base64 -d` accepts only the standard (+/) alphabet; on a url-safe (-_) blob it
  // doesn't error, it silently DECODES WRONG (drops/misreads the tail instead of raising) --
  // route through `_b64url_decode`, which normalizes the alphabet and pads before decoding.
  const b64Suffix = decodeB64 ? (base64Encoding(model, dep).urlSafe ? " | _b64url_decode" : " | base64 -d") : "";

  if (dep.source.startsWith("json:")) {
    const jqPath = toJqPath(dep.source.slice("json:".length));
    return [`${dep.varName}=$(echo "${respRef}" | jq -r '${jqPath}'${b64Suffix})`];
  }
  if (dep.source.startsWith("cookie:")) {
    const cookieName = dep.source.slice("cookie:".length);
    return [
      "# best-effort cookie extraction from the response headers dump",
      `${dep.varName}=$(grep -i '^set-cookie:' ${headerDumpPath} | head -1 | sed -E 's/.*${cookieName}=([^;]*).*/\\1/'${b64Suffix})`,
    ];
  }
  if (dep.source.startsWith("header:")) {
    const headerName = dep.source.slice("header:".length);
    return [
      "# best-effort header extraction from the response headers dump",
      `${dep.varName}=$(grep -i '^${headerName}:' ${headerDumpPath} | head -1 | cut -d':' -f2- | sed -E 's/^[[:space:]]+//; s/[[:space:]\\r]+$//'${b64Suffix})`,
    ];
  }
  // Every source kind produced by extractProduced ("json:", "cookie:", "header:") is
  // handled above; this only fires if that set grows without a matching case here.
  return [`# TODO: extract ${dep.source} for ${dep.varName} (unrecognized source kind)`];
}

function renderCall(
  call: FlowCall,
  incoming: FlowDep[],
  outgoing: FlowDep[],
  model: FlowModel,
  redact: { tracker: RedactionTracker } | undefined,
  notes: Set<string>,
): string[] {
  const unique = dedupeOutgoing(outgoing);
  const needsCapture = unique.length > 0;
  const needsHeaderDump = unique.some((d) => !d.source.startsWith("json:"));
  const headerDumpPath = `/tmp/flow_headers_${call.index}.txt`;

  const url = buildUrl(call, incoming, model, notes);
  const headerArgs = buildHeaderArgs(call, incoming, model, redact, notes);
  const bodyArg = buildBodyArg(call, incoming, model, redact, notes);

  const tokens: string[] = ["curl", "-s"];
  if (needsHeaderDump) tokens.push("-D", headerDumpPath);
  tokens.push("-X", call.method, quoteUrl(url), ...headerArgs);
  if (bodyArg) tokens.push(bodyArg);
  const cmd = tokens.join(" ");

  // Use the same (possibly substituted/escaped) url text as the command below,
  // not the raw call.url — otherwise a chained literal that the command safely
  // replaced with $varName would still leak into this comment verbatim.
  const lines: string[] = [`# call ${call.index}: ${call.method} ${url.text}`];
  if (needsCapture) {
    const respVar = `resp${call.index}`;
    const respRef = `$${respVar}`;
    lines.push(`${respVar}=$(${cmd})`);
    for (const dep of unique) {
      lines.push(...extractionLines(respRef, dep, headerDumpPath, model));
    }
  } else {
    lines.push(cmd);
  }
  return lines;
}

/**
 * Emit a bash script that replays a captured flow with curl. Values that a
 * later call consumed from an earlier call's response are extracted (jq for
 * JSON, a headers dump + grep/sed best-effort for cookies/headers) and
 * chained via shell variables instead of being baked in as literals. A
 * non-exact transform (base64, a value embedded in a larger string) is
 * decoded/extracted inline; urlenc and jwt-claim get a `# note`/`# TODO`
 * comment instead (see `curlVarRef`/`curlNoteLines`) since curl can't
 * meaningfully wrap a shell variable reference inline. Unmatched values stay
 * literal — or, with `opts.redact`, are replaced by a numbered `$BFA_SECRET_N`
 * shell variable (expected to be set in the environment) when they look like
 * a secret.
 */
export function emitCurl(model: FlowModel, opts?: EmitOptions): string {
  const incomingByCall = new Map<number, FlowDep[]>();
  const outgoingByCall = new Map<number, FlowDep[]>();
  for (const dep of model.deps) {
    const inList = incomingByCall.get(dep.toCall) ?? [];
    inList.push(dep);
    incomingByCall.set(dep.toCall, inList);

    const outList = outgoingByCall.get(dep.fromCall) ?? [];
    outList.push(dep);
    outgoingByCall.set(dep.fromCall, outList);
  }

  const redact = opts?.redact ? { tracker: newRedactionTracker() } : undefined;
  const notes = new Set<string>();
  const needsB64UrlDecodeHelper = model.deps.some(
    (d) => d.transform === "base64" && base64Direction(model, d) === "decode" && base64Encoding(model, d).urlSafe,
  );

  const callBlocks: string[][] = model.calls.map((call) => {
    const incoming = incomingByCall.get(call.index) ?? [];
    const outgoing = outgoingByCall.get(call.index) ?? [];
    return renderCall(call, incoming, outgoing, model, redact, notes);
  });

  // The shebang MUST stay the very first line for direct execution (`./script.sh`) to work —
  // unlike the other emitters' leading comment block, the redaction note is inserted AFTER it,
  // not prepended to the whole file.
  const lines: string[] = ["#!/usr/bin/env bash"];
  if (redact && redact.tracker.entries.length > 0) {
    lines.push(...redactionHeaderComment(redact.tracker, "#"));
  }
  lines.push(
    "# Extracted by browser-for-ai from a real browser session. Unmatched values are literals — review before use.",
    "set -euo pipefail",
    "",
  );

  if (needsB64UrlDecodeHelper) lines.push(...B64URL_DECODE_HELPER_LINES);

  if (notes.size > 0) {
    lines.push(...notes);
    lines.push("");
  }

  for (const block of callBlocks) {
    lines.push(...block);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
