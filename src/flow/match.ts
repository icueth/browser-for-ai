import type { FlowDepTransform } from "./types";

export interface MatchResult {
  transform: FlowDepTransform;
  claimPath?: string;
  container?: string;
}

const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;
const LOOKS_BASE64_RE = /^[A-Za-z0-9+/=_-]{8,}$/;

/**
 * Decode a base64 (or base64url) string, verifying the round-trip so that
 * Node's lenient base64 parser (which silently drops invalid characters)
 * can't turn garbage input into a false decode. Returns the decoded text
 * only if it round-trips and is printable ASCII; null otherwise.
 */
function safeB64decode(s: string): string | null {
  for (const encoding of ["base64", "base64url"] as const) {
    try {
      const buf = Buffer.from(s, encoding);
      if (buf.length === 0) continue;
      const roundTrip = buf.toString(encoding).replace(/=+$/, "");
      const original = s.replace(/=+$/, "");
      if (roundTrip !== original) continue;
      const text = buf.toString("utf8");
      if (text.length === 0 || !PRINTABLE_ASCII_RE.test(text)) continue;
      return text;
    } catch {
      continue;
    }
  }
  return null;
}

/** Decode a JWT segment (base64url) as a JSON object, without the printable-ASCII restriction. */
function decodeJwtSegmentJson(s: string): Record<string, unknown> | null {
  try {
    const buf = Buffer.from(s, "base64url");
    if (buf.length === 0) return null;
    const parsed: unknown = JSON.parse(buf.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Depth-first search for a string leaf equal to `target`; returns its dotted path. */
function findClaimPath(obj: Record<string, unknown>, target: string, prefix = ""): string | null {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string" && value === target) return path;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = findClaimPath(value as Record<string, unknown>, target, path);
      if (nested) return nested;
    }
  }
  return null;
}

function tryUrlenc(producedValue: string, consumedValue: string): MatchResult | null {
  try {
    if (decodeURIComponent(consumedValue) === producedValue) return { transform: "urlenc" };
  } catch {
    // malformed percent-encoding — not a urlenc match
  }
  try {
    if (decodeURIComponent(producedValue) === consumedValue) return { transform: "urlenc" };
  } catch {
    // malformed percent-encoding — not a urlenc match
  }
  if (encodeURIComponent(producedValue) === consumedValue) return { transform: "urlenc" };
  if (encodeURIComponent(consumedValue) === producedValue) return { transform: "urlenc" };
  return null;
}

function tryBase64(producedValue: string, consumedValue: string): MatchResult | null {
  if (LOOKS_BASE64_RE.test(producedValue)) {
    const decoded = safeB64decode(producedValue);
    if (decoded !== null && decoded === consumedValue && decoded.length >= 8) {
      return { transform: "base64" };
    }
  }
  if (LOOKS_BASE64_RE.test(consumedValue)) {
    const decoded = safeB64decode(consumedValue);
    if (decoded !== null && decoded === producedValue && decoded.length >= 8) {
      return { transform: "base64" };
    }
  }
  return null;
}

function tryJwtClaim(producedValue: string, consumedValue: string): MatchResult | null {
  const parts = producedValue.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart] = parts;
  if (!headerPart || !payloadPart) return null;
  if (!decodeJwtSegmentJson(headerPart)) return null;
  const payload = decodeJwtSegmentJson(payloadPart);
  if (!payload) return null;
  const claimPath = findClaimPath(payload, consumedValue);
  if (!claimPath) return null;
  return { transform: "jwt-claim", claimPath };
}

function trySubstring(producedValue: string, consumedValue: string): MatchResult | null {
  if (
    producedValue.length >= 8 &&
    producedValue !== consumedValue &&
    consumedValue.includes(producedValue)
  ) {
    return { transform: "substring", container: consumedValue };
  }
  return null;
}

/**
 * Determine whether a produced value (P) and a consumed value (C) relate,
 * and via what transform. Tried in priority order, most-specific/most-
 * conservative first; returns the first match, or null if none relate.
 */
export function matchValue(producedValue: string, consumedValue: string): MatchResult | null {
  if (producedValue === consumedValue) return { transform: "exact" };
  return (
    tryUrlenc(producedValue, consumedValue) ??
    tryBase64(producedValue, consumedValue) ??
    tryJwtClaim(producedValue, consumedValue) ??
    trySubstring(producedValue, consumedValue)
  );
}
