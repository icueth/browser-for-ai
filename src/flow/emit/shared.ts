import type { FlowConsumedValue, FlowDep, FlowModel } from "../types";

/** Headers that are unsafe/meaningless to set explicitly on an outgoing request (set by the HTTP client itself). */
export const SKIP_HEADERS = new Set(["host", "content-length", "connection"]);

/** Shared options every emitter accepts. */
export interface EmitOptions {
  /** When true, unmatched secret-bearing literals are replaced with numbered env placeholders. */
  redact?: boolean;
}

export function findAllIncoming(deps: FlowDep[], location: FlowConsumedValue["location"]): FlowDep[] {
  return deps.filter((d) => d.consumed.location === location);
}

/** Dedupe outgoing deps by (source, varName) — one extraction per produced value, even if several later calls consume it. */
export function dedupeOutgoing(deps: FlowDep[]): FlowDep[] {
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

/** Group a flow's deps by the call they're consumed in (incoming) and the call they're produced by (outgoing). */
export function groupDepsByCall(deps: FlowDep[]): {
  incomingByCall: Map<number, FlowDep[]>;
  outgoingByCall: Map<number, FlowDep[]>;
} {
  const incomingByCall = new Map<number, FlowDep[]>();
  const outgoingByCall = new Map<number, FlowDep[]>();
  for (const dep of deps) {
    const inList = incomingByCall.get(dep.toCall) ?? [];
    inList.push(dep);
    incomingByCall.set(dep.toCall, inList);

    const outList = outgoingByCall.get(dep.fromCall) ?? [];
    outList.push(dep);
    outgoingByCall.set(dep.fromCall, outList);
  }
  return { incomingByCall, outgoingByCall };
}

export type TemplatePart = { type: "text"; text: string } | { type: "var"; dep: FlowDep };

// Plain, printable marker strings (not control characters — those don't survive some tool
// pipelines intact) that are astronomically unlikely to appear in real captured HTTP text.
// Distinct open/close markers, rather than one repeated delimiter, avoid any ambiguity when
// scanning back out.
const MARK_OPEN = "@@FLOWVAR_OPEN@@";
const MARK_CLOSE = "@@FLOWVAR_CLOSE@@";

/** Look up the raw literal value a dep's producer actually emitted (from the captured call graph). */
export function findProducedLiteral(model: FlowModel, dep: FlowDep): string | undefined {
  const call = model.calls.find((c) => c.index === dep.fromCall);
  return call?.produced.find((p) => p.source === dep.source)?.value;
}

/**
 * The literal substring to search for in raw captured text when locating this dep's occurrence.
 * For "substring" transform, that's the (shorter) produced value sitting inside the consumed
 * container, NOT the whole consumed.value (which IS the container) — searching for the
 * container itself would swallow the surrounding literal text the container carries.
 * Every other transform's consumed.value already IS the exact literal to find.
 */
export function resolveSearchValue(model: FlowModel, dep: FlowDep): string {
  if (dep.transform === "substring") {
    const produced = findProducedLiteral(model, dep);
    if (produced) return produced;
  }
  return dep.consumed.value;
}

/**
 * Split `raw` into alternating literal-text and variable-reference parts, substituting each
 * matching dep's search value (see `resolveSearchValue`) with a marker-delimited reference to
 * the dep itself — callers render the final language-specific expression for each var part
 * (bare reference, `encodeURIComponent(...)`, a JWT-claim decode, etc.) based on `dep.transform`.
 *
 * Same escape-then-inject shape as the curl emitter's `substituteForDoubleQuote`: deps are
 * applied longest-search-value-first, so one var's value being a substring of another's can't
 * mangle the result.
 */
export function tokenize(raw: string, deps: FlowDep[], model: FlowModel): TemplatePart[] {
  const matching = deps
    .map((d) => ({ dep: d, searchValue: resolveSearchValue(model, d) }))
    .filter((x) => x.searchValue.length > 0 && raw.includes(x.searchValue));
  if (matching.length === 0) return [{ type: "text", text: raw }];

  const byVarName = new Map<string, FlowDep>();
  for (const m of matching) byVarName.set(m.dep.varName, m.dep);

  const sorted = [...matching].sort((a, b) => b.searchValue.length - a.searchValue.length);
  let working = raw;
  for (const { dep, searchValue } of sorted) {
    working = working.split(searchValue).join(`${MARK_OPEN}${dep.varName}${MARK_CLOSE}`);
  }

  const parts: TemplatePart[] = [];
  const placeholderRe = new RegExp(`${MARK_OPEN}(.*?)${MARK_CLOSE}`, "g");
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = placeholderRe.exec(working))) {
    if (m.index > lastIndex) parts.push({ type: "text", text: working.slice(lastIndex, m.index) });
    const varName = m[1] ?? "";
    const dep = byVarName.get(varName);
    // Every marker was just generated from a dep in `byVarName` above, so this is always found;
    // the fallback keeps TypeScript happy without an assertion.
    parts.push(dep ? { type: "var", dep } : { type: "text", text: `${MARK_OPEN}${varName}${MARK_CLOSE}` });
    lastIndex = placeholderRe.lastIndex;
  }
  if (lastIndex < working.length) parts.push({ type: "text", text: working.slice(lastIndex) });
  return parts;
}

export type JsonPathSegment = { type: "prop"; name: string } | { type: "index"; index: number };

/** Parse a jsonLeaves-style path ("$.data[0].id", "$.token", "$") into segments after the leading "$". */
export function parseJsonPath(path: string): JsonPathSegment[] {
  const body = path.startsWith("$") ? path.slice(1) : path;
  const segments: JsonPathSegment[] = [];
  const re = /\.([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) segments.push({ type: "prop", name: m[1] });
    else if (m[2] !== undefined) segments.push({ type: "index", index: Number(m[2]) });
  }
  return segments;
}

export const JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Render a JS/TS property-access chain: dot notation for valid identifiers, bracket notation otherwise. */
export function jsAccessor(base: string, segments: JsonPathSegment[]): string {
  let out = base;
  for (const seg of segments) {
    if (seg.type === "index") out += `[${seg.index}]`;
    else out += JS_IDENT_RE.test(seg.name) ? `.${seg.name}` : `[${JSON.stringify(seg.name)}]`;
  }
  return out;
}

/** Render a Python subscript chain: dicts/lists always use bracket notation. */
export function pyAccessor(base: string, segments: JsonPathSegment[]): string {
  let out = base;
  for (const seg of segments) {
    out += seg.type === "index" ? `[${seg.index}]` : `[${JSON.stringify(seg.name)}]`;
  }
  return out;
}

/** Build a map from body-json JSON-path (the dep's `consumed.field`) to the dep consuming it, for this call's incoming deps. */
export function bodyJsonDepsByField(incoming: FlowDep[]): Map<string, FlowDep> {
  const map = new Map<string, FlowDep>();
  for (const dep of incoming) {
    if (dep.consumed.location === "body-json") map.set(dep.consumed.field, dep);
  }
  return map;
}

/** Try decoding `s` as base64 (both alphabets), returning the decoded text if it equals `target`. */
function base64DecodeMatches(s: string, target: string): boolean {
  for (const encoding of ["base64", "base64url"] as const) {
    try {
      if (Buffer.from(s, encoding).toString("utf8") === target) return true;
    } catch {
      // not decodable under this alphabet — try the next
    }
  }
  return false;
}

/**
 * Which direction a "base64" dep's transform runs, using the actual captured values (match.ts's
 * MatchResult doesn't record direction — see task-3.7-brief.md): "decode" when the producer's
 * raw value is the base64 blob and the consumer used its decoded form (decode at extraction is
 * then correct — the extracted var IS the plaintext everywhere it's used); "encode" when the
 * producer's raw value is already the plaintext and the consumer needed a base64 form of it
 * (encode at each use site instead, since the extracted var stays the plaintext).
 */
export function base64Direction(model: FlowModel, dep: FlowDep): "decode" | "encode" {
  const produced = findProducedLiteral(model, dep);
  if (produced !== undefined && base64DecodeMatches(produced, dep.consumed.value)) return "decode";
  return "encode";
}

/**
 * The actual base64 alphabet (and padding style) the wire literal uses, for a "base64" dep —
 * distinct from `base64Direction`: match.ts's `LOOKS_BASE64_RE`/`safeB64decode` accept BOTH the
 * standard (+/) and url-safe (-_) alphabets, but every emitter used to hardcode the standard
 * one. A url-safe blob decoded with a standard-only codec (`atob`, `base64.b64decode`, Go's
 * `base64.StdEncoding`, BSD/macOS `base64 -d`) throws, silently corrupts, or — on BSD `base64
 * -d` — produces outright garbage instead of erroring. Inspect whichever side of the dep IS the
 * base64 blob (the producer's raw value on "decode", the consumer's literal on "encode" — same
 * side `base64Direction` already identifies) for `-`/`_` (url-safe-only characters) and a
 * trailing `=` (padded).
 */
export function base64Encoding(model: FlowModel, dep: FlowDep): { urlSafe: boolean; padded: boolean } {
  const direction = base64Direction(model, dep);
  const blob = direction === "decode" ? findProducedLiteral(model, dep) : dep.consumed.value;
  return {
    urlSafe: blob !== undefined && /[-_]/.test(blob),
    padded: blob !== undefined && blob.endsWith("="),
  };
}

export type UrlencDirection = "encode" | "decode";

/**
 * Which operation turns a "urlenc" dep's extracted var (which holds the PRODUCER's raw literal)
 * into what the consumer actually needs on the wire — match.ts's `tryUrlenc` is bidirectional
 * and its `MatchResult` doesn't record which side was already encoded (same gap `base64Direction`
 * closes for base64). "encode": the producer's raw value is plain and the consumer's literal is
 * its percent-encoded form (encode at the use site — the common case). "decode": the producer's
 * raw value is ALREADY percent-encoded and the consumer's literal is the decoded form (decoding
 * at the use site is then correct; unconditionally encoding here would double-encode it).
 */
export function urlencDirection(model: FlowModel, dep: FlowDep): UrlencDirection {
  const produced = findProducedLiteral(model, dep);
  if (produced === undefined) return "encode";
  try {
    if (decodeURIComponent(produced) === dep.consumed.value) return "decode";
  } catch {
    // produced isn't valid percent-encoding itself -- it can't be the encoded side.
  }
  return "encode";
}

function sanitizeClaimSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

/** A collision-safe local variable name for a jwt-claim dep's decoded claim (namespaced by both the source var and the claim path, so two different claims off two different JWTs never collide). */
export function claimVarName(dep: FlowDep): string {
  const path = dep.claimPath ?? "claim";
  const safe = path.split(".").map(sanitizeClaimSegment).join("_") || "claim";
  return `${dep.varName}_${safe}`;
}

/** claimPath ("user.id") as property-access segments — findClaimPath (match.ts) only ever walks plain object keys, never arrays, so these are always "prop" segments. */
export function claimPathSegments(dep: FlowDep): JsonPathSegment[] {
  const path = dep.claimPath ?? "";
  return path
    .split(".")
    .filter((s) => s.length > 0)
    .map((name) => ({ type: "prop", name }) as JsonPathSegment);
}

// --- Redaction -------------------------------------------------------------

export interface RedactionTracker {
  entries: { placeholder: string; location: string }[];
}

export function newRedactionTracker(): RedactionTracker {
  return { entries: [] };
}

/** Register a new secret, returning its numbered placeholder name (e.g. "BFA_SECRET_1"). */
export function registerSecret(tracker: RedactionTracker, location: string): string {
  const placeholder = `BFA_SECRET_${tracker.entries.length + 1}`;
  tracker.entries.push({ placeholder, location });
  return placeholder;
}

// Opaque-looking token: long, no whitespace, drawn from the usual token/base64/hex alphabet.
const TOKEN_LIKE_RE = /^[A-Za-z0-9_\-.+/=]{20,}$/;

export function looksTokenLike(text: string): boolean {
  return TOKEN_LIKE_RE.test(text);
}

/** Whether an unmatched literal in this spot should be redacted: always for a secret-bearing location (authorization/cookie), otherwise only if it looks like an opaque token. */
export function shouldRedact(text: string, isSecretLocation: boolean): boolean {
  if (!text) return false;
  return isSecretLocation || looksTokenLike(text);
}

/** A header comment block listing every placeholder this emit produced and what it replaced, or `[]` if none were redacted. */
export function redactionHeaderComment(tracker: RedactionTracker, commentPrefix: string): string[] {
  if (tracker.entries.length === 0) return [];
  const lines = [`${commentPrefix} Redacted secrets -- set these in your environment before running:`];
  for (const e of tracker.entries) lines.push(`${commentPrefix}   ${e.placeholder}  <-  ${e.location}`);
  return lines;
}
