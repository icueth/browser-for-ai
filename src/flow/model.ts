import type {
  FlowCall,
  FlowConsumedValue,
  FlowModel,
  FlowProducedValue,
  RawCall,
} from "./types";

export interface JsonLeaf {
  path: string;
  value: string;
}

/** Walk an object/array and yield leaf string/number values as {path, value}. */
export function jsonLeaves(obj: unknown, prefix = "$"): JsonLeaf[] {
  const out: JsonLeaf[] = [];
  walkLeaves(obj, prefix, out);
  return out;
}

function walkLeaves(obj: unknown, path: string, out: JsonLeaf[]): void {
  if (obj === null || obj === undefined || typeof obj === "boolean") return;
  if (typeof obj === "string") {
    if (obj.length >= 4) out.push({ path, value: obj });
    return;
  }
  if (typeof obj === "number") {
    const s = String(obj);
    if (s.length >= 4) out.push({ path, value: s });
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => walkLeaves(item, `${path}[${i}]`, out));
    return;
  }
  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      walkLeaves(value, `${path}.${key}`, out);
    }
  }
}

function headerLookup(headers: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    map.set(key.toLowerCase(), value);
  }
  return map;
}

function parseCookiePair(pair: string): { name: string; value: string } {
  const trimmed = pair.trim();
  const eq = trimmed.indexOf("=");
  if (eq === -1) return { name: trimmed, value: "" };
  return { name: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() };
}

function tryParseJson(body: string | undefined, headers: Map<string, string>): unknown {
  if (!body) return undefined;
  const contentType = headers.get("content-type");
  if (!contentType || !contentType.includes("json")) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function extractProduced(
  callIndex: number,
  resJson: unknown,
  resHeaders: Map<string, string>,
): FlowProducedValue[] {
  const out: FlowProducedValue[] = [];

  for (const leaf of jsonLeaves(resJson)) {
    out.push({ callIndex, source: `json:${leaf.path}`, value: leaf.value });
  }

  const setCookie = resHeaders.get("set-cookie");
  if (setCookie) {
    const firstPair = setCookie.split(";")[0] ?? "";
    const { name, value } = parseCookiePair(firstPair);
    if (name) out.push({ callIndex, source: `cookie:${name}`, value });
  }

  const location = resHeaders.get("location");
  if (location) out.push({ callIndex, source: "header:location", value: location });

  return out;
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

function extractConsumed(
  url: string,
  reqHeaders: Map<string, string>,
  reqJson: unknown,
): FlowConsumedValue[] {
  const out: FlowConsumedValue[] = [];

  try {
    const parsed = new URL(url);
    for (const [field, value] of parsed.searchParams.entries()) {
      out.push({ location: "url-query", field, value });
    }
  } catch {
    // not an absolute/parseable URL — no query params to extract
  }

  for (const [name, value] of reqHeaders.entries()) {
    if (name === "cookie") {
      for (const pair of value.split(";")) {
        if (!pair.trim()) continue;
        const { name: field, value: cvalue } = parseCookiePair(pair);
        if (field) out.push({ location: "cookie", field, value: cvalue });
      }
      continue;
    }
    if (name === "authorization") {
      out.push({ location: "header", field: "authorization", value });
      const bearer = BEARER_RE.exec(value);
      if (bearer?.[1]) {
        out.push({ location: "header", field: "authorization", value: bearer[1] });
      }
      continue;
    }
    if (name.startsWith("x-")) {
      out.push({ location: "header", field: name, value });
    }
  }

  for (const leaf of jsonLeaves(reqJson)) {
    out.push({ location: "body-json", field: leaf.path, value: leaf.value });
  }

  return out;
}

/** Parse raw captured calls into a FlowModel. deps is left empty (filled by detectDeps). */
export function buildFlow(raw: RawCall[]): FlowModel {
  const calls: FlowCall[] = raw.map((r, index) => {
    const reqHeaderMap = headerLookup(r.reqHeaders);
    const resHeaderMap = headerLookup(r.resHeaders);
    const reqJson = tryParseJson(r.reqBody, reqHeaderMap);
    // A base64 body is binary, not text — never mine it for JSON produced values.
    const resJson = r.resBodyBase64 ? undefined : tryParseJson(r.resBody, resHeaderMap);

    return {
      index,
      method: r.method,
      url: r.url,
      reqHeaders: r.reqHeaders,
      reqBody: r.reqBody,
      reqJson,
      status: r.status,
      resHeaders: r.resHeaders,
      resBody: r.resBody,
      resBodyBase64: r.resBodyBase64,
      resJson,
      produced: extractProduced(index, resJson, resHeaderMap),
      consumed: extractConsumed(r.url, reqHeaderMap, reqJson),
    };
  });

  return { calls, deps: [] };
}
