import type { FlowConsumedValue, FlowDep, FlowDepTransform, FlowModel } from "./types";
import { SKIP_HEADERS, base64Direction, base64Encoding, findProducedLiteral, parseJsonPath, urlencDirection } from "./emit/shared";

/** Where a dep's resolved value gets injected in the request being replayed. */
export interface ReplayInto {
  location: FlowConsumedValue["location"];
  field: string;
}

/**
 * A chained dependency for one replay step, with everything the (impure) executor needs
 * precomputed here, purely, from the model — so the executor never needs `FlowModel` access,
 * only this plan plus the responses it has actually captured while replaying.
 */
export interface ReplayDep {
  /** Which earlier step's response this value is extracted from. */
  fromStep: number;
  /** Producer source, same shape as `FlowDep.source`: "json:$.path" | "cookie:name" | "header:name". */
  extract: string;
  transform: FlowDepTransform;
  /** Dotted claim path within a decoded JWT payload (only set when transform is "jwt-claim"). */
  claimPath?: string;
  /** Human-readable name for the report line (e.g. "token"). */
  varName: string;
  into: ReplayInto;
  /**
   * The literal text to search for (and replace) in the recorded request at `into` — the
   * shorter produced value for "substring" (so only the embedded piece is replaced, not the
   * whole container), else the originally recorded consumed literal. Mirrors
   * `resolveSearchValue` in emit/shared.ts.
   */
  needle: string;
  /**
   * Precomputed (pure, from the model) transform direction/alphabet — mirrors `urlencDirection`/
   * `base64Direction`/`base64Encoding` in emit/shared.ts, resolved once here since a live replay
   * response may not exist yet (or may differ) when the executor needs to decide how to
   * transform whatever it actually extracts at runtime.
   */
  opDirection?: "encode" | "decode";
  base64UrlSafe?: boolean;
  base64Padded?: boolean;
}

export interface ReplayStep {
  index: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  recordedStatus?: number;
  deps: ReplayDep[];
}

function toReplayDep(model: FlowModel, dep: FlowDep): ReplayDep {
  const needle = dep.transform === "substring" ? (findProducedLiteral(model, dep) ?? dep.consumed.value) : dep.consumed.value;

  const base: ReplayDep = {
    fromStep: dep.fromCall,
    extract: dep.source,
    transform: dep.transform,
    claimPath: dep.claimPath,
    varName: dep.varName,
    into: { location: dep.consumed.location, field: dep.consumed.field },
    needle,
  };

  if (dep.transform === "urlenc") {
    base.opDirection = urlencDirection(model, dep);
  } else if (dep.transform === "base64") {
    base.opDirection = base64Direction(model, dep);
    const enc = base64Encoding(model, dep);
    base.base64UrlSafe = enc.urlSafe;
    base.base64Padded = enc.padded;
  }

  return base;
}

function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SKIP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Build a pure, resolved replay plan from a captured+dependency-detected flow: for each call, the
 * request as recorded (method/url/headers/body, minus headers the HTTP client sets itself) plus
 * its chained deps, each carrying everything (`needle`, `opDirection`, alphabet) the executor
 * needs to resolve a live value from a prior replay response and inject it in place of the
 * originally recorded literal. Pure — no fetch, no I/O.
 */
export function planReplay(model: FlowModel): ReplayStep[] {
  return model.calls.map((call) => ({
    index: call.index,
    method: call.method,
    url: call.url,
    headers: filterHeaders(call.reqHeaders),
    body: call.reqBody,
    recordedStatus: call.status,
    deps: model.deps.filter((d) => d.toCall === call.index).map((d) => toReplayDep(model, d)),
  }));
}

// --- Runtime extraction/transform/injection (pure — used by the impure executor) -----------

export interface RuntimeResponse {
  status: number;
  bodyText: string;
  /** Parsed JSON body, when bodyText parses as JSON — undefined otherwise. */
  json?: unknown;
  /** Lowercased response headers. */
  headers: Record<string, string>;
}

/** Walk a parsed JSON value along jsonLeaves-style path segments ("$.data[0].id"), returning
 *  the leaf as a string (numbers stringified) or undefined if the path doesn't resolve to a
 *  scalar. */
function walkJsonPath(root: unknown, source: string): string | undefined {
  const segments = parseJsonPath(source.slice("json:".length));
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (seg.type === "index") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg.index];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[seg.name];
    }
  }
  if (typeof cur === "string") return cur;
  if (typeof cur === "number") return String(cur);
  return undefined;
}

/** Extract a raw runtime value from a prior replay response, per a dep's `extract` source. */
export function extractRuntimeValue(source: string, resp: RuntimeResponse): string | undefined {
  if (source.startsWith("json:")) {
    if (resp.json === undefined) return undefined;
    return walkJsonPath(resp.json, source);
  }
  if (source.startsWith("cookie:")) {
    const name = source.slice("cookie:".length);
    const setCookie = resp.headers["set-cookie"];
    if (!setCookie) return undefined;
    // Multiple Set-Cookie occurrences arrive joined with "\n" (see lowerFetchHeaders in
    // tools/flow.ts) -- split on that FIRST, before splitting on ";", so a second cookie's
    // name=value can't bleed into the first cookie's pair when the first cookie has no
    // ";"-delimited attributes of its own (e.g. "sid=ABC\ncsrf=XYZ; Path=/" must read as
    // "sid=ABC", not "sid=ABC\ncsrf=XYZ"). Only the first cookie is ever read, matching the
    // recorder's own convention (see extractProduced in model.ts).
    const firstCookie = setCookie.split("\n")[0] ?? "";
    const firstPair = firstCookie.split(";")[0] ?? "";
    const eq = firstPair.indexOf("=");
    const pairName = (eq === -1 ? firstPair : firstPair.slice(0, eq)).trim();
    if (pairName !== name) return undefined;
    return eq === -1 ? "" : firstPair.slice(eq + 1).trim();
  }
  if (source.startsWith("header:")) {
    const name = source.slice("header:".length);
    return resp.headers[name.toLowerCase()];
  }
  return undefined;
}

/** base64-encode `raw` matching a captured wire literal's exact alphabet+padding style — same
 *  fixup the TS emitter's `tsBase64EncodeExpr` applies at codegen time (see ts.ts), just
 *  computed directly here instead of rendered as source. */
function base64EncodeMatchingWire(raw: string, urlSafe: boolean, padded: boolean): string {
  const mode = urlSafe ? "base64url" : "base64";
  const out = Buffer.from(raw).toString(mode);
  if (urlSafe && padded) return out + "=".repeat((4 - (out.length % 4)) % 4);
  if (!urlSafe && !padded) return out.replace(/=+$/, "");
  return out;
}

/** Decode a JWT payload segment (base64url) as JSON, without throwing. */
function decodeJwtPayload(seg: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(seg, "base64url").toString());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/**
 * Apply a dep's transform to a freshly-extracted runtime value, honoring the direction/alphabet
 * precomputed by `planReplay` — mirrors what each codegen emitter renders (ts.ts/python.ts/
 * go.ts/curl.ts), just executed directly instead of generated as source:
 * - exact / substring: the extracted value IS what's needed at the injection site.
 * - urlenc: encode or decode per `dep.opDirection`.
 * - base64: decode (in the recorded alphabet) or re-encode (matching the recorded alphabet AND
 *   padding style) per `dep.opDirection`.
 * - jwt-claim: decode the JWT's payload segment (always base64url, per RFC 7515) and pull out
 *   `dep.claimPath`; falls back to the raw token, honestly, if the value isn't parseable as a
 *   JWT or the claim path doesn't resolve (mirrors the Go/curl emitters' fallback).
 */
export function resolveReplayValue(dep: ReplayDep, rawValue: string): string {
  if (dep.transform === "urlenc") {
    if (dep.opDirection === "decode") {
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
    return encodeURIComponent(rawValue);
  }
  if (dep.transform === "base64") {
    if (dep.opDirection === "decode") {
      try {
        return Buffer.from(rawValue, dep.base64UrlSafe ? "base64url" : "base64").toString();
      } catch {
        return rawValue;
      }
    }
    return base64EncodeMatchingWire(rawValue, dep.base64UrlSafe ?? false, dep.base64Padded ?? true);
  }
  if (dep.transform === "jwt-claim") {
    const seg = rawValue.split(".")[1];
    if (!seg) return rawValue;
    const payload = decodeJwtPayload(seg);
    if (!payload) return rawValue;
    let cur: unknown = payload;
    for (const key of (dep.claimPath ?? "").split(".").filter((s) => s.length > 0)) {
      if (cur === null || typeof cur !== "object") return rawValue;
      cur = (cur as Record<string, unknown>)[key];
    }
    return typeof cur === "string" ? cur : rawValue;
  }
  // exact / substring
  return rawValue;
}

export interface ReplayRequest {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface InjectResult extends ReplayRequest {
  /** Whether `dep.needle` was actually found (and replaced) at `dep.into` — false means the
   *  request is unchanged (the original literal it was supposed to replace isn't there anymore,
   *  e.g. a header the flow no longer sends), which the caller should report as unresolved. */
  injected: boolean;
}

/**
 * Substitute `dep.needle` with `resolvedValue` at `dep.into` (url query string / a specific
 * header / the Cookie header / the raw body text) — a plain text search-and-replace, same
 * mechanism the codegen emitters use (see `resolveSearchValue`/`tokenize` in emit/shared.ts),
 * just applied directly to a live request instead of to generated source.
 */
export function injectDepValue(req: ReplayRequest, dep: ReplayDep, resolvedValue: string): InjectResult {
  const headers = { ...req.headers };
  let url = req.url;
  let body = req.body;
  let injected = false;

  const replaceIn = (text: string): { text: string; changed: boolean } => {
    if (!dep.needle || !text.includes(dep.needle)) return { text, changed: false };
    return { text: text.split(dep.needle).join(resolvedValue), changed: true };
  };

  if (dep.into.location === "url-query") {
    const r = replaceIn(url);
    url = r.text;
    injected = r.changed;
  } else if (dep.into.location === "header") {
    const existing = headers[dep.into.field];
    if (existing !== undefined) {
      const r = replaceIn(existing);
      headers[dep.into.field] = r.text;
      injected = r.changed;
    }
  } else if (dep.into.location === "cookie") {
    const existing = headers["cookie"];
    if (existing !== undefined) {
      const r = replaceIn(existing);
      headers["cookie"] = r.text;
      injected = r.changed;
    }
  } else if (dep.into.location === "body-json") {
    if (body !== undefined) {
      const r = replaceIn(body);
      body = r.text;
      injected = r.changed;
    }
  }

  return { url, headers, body, injected };
}
