import type { FlowCall, FlowModel } from "../types";

interface HarNameValue {
  name: string;
  value: string;
}

function toHeaders(headers: Record<string, string>): HarNameValue[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function headerCI(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function parseCookiePair(pair: string): { name: string; value: string } {
  const trimmed = pair.trim();
  const eq = trimmed.indexOf("=");
  if (eq === -1) return { name: trimmed, value: "" };
  return { name: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() };
}

/** Parse a `Cookie: a=1; b=2` request header into HAR cookie pairs. */
function requestCookies(headers: Record<string, string>): HarNameValue[] {
  const raw = headerCI(headers, "cookie");
  if (!raw) return [];
  return raw
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map(parseCookiePair);
}

/** Parse a `Set-Cookie: sid=Z9; Path=/` response header into a single HAR cookie pair. */
function responseCookies(headers: Record<string, string>): HarNameValue[] {
  const raw = headerCI(headers, "set-cookie");
  if (!raw) return [];
  const { name, value } = parseCookiePair(raw.split(";")[0] ?? "");
  return name ? [{ name, value }] : [];
}

function toQueryString(url: string): HarNameValue[] {
  try {
    const parsed = new URL(url);
    return Array.from(parsed.searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function mimeType(headers: Record<string, string>): string {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-type") return value;
  }
  return "application/octet-stream";
}

function buildEntry(call: FlowCall) {
  const request: Record<string, unknown> = {
    method: call.method,
    url: call.url,
    httpVersion: "HTTP/1.1",
    headers: toHeaders(call.reqHeaders),
    queryString: toQueryString(call.url),
    cookies: requestCookies(call.reqHeaders),
    headersSize: -1,
    bodySize: -1,
  };
  if (call.reqBody !== undefined) {
    request.postData = { mimeType: mimeType(call.reqHeaders), text: call.reqBody };
  }

  const bodyText = call.resBody ?? "";
  // Per HAR 1.2, a base64-encoded body (CDP's `base64Encoded: true` — binary responses like
  // octet-stream/protobuf) must set content.encoding, or HAR consumers (DevTools
  // import, Postman) read the base64 text as-is, i.e. corrupt. Size is unknown in that case:
  // the base64 string's length isn't the real decoded byte size, and we never decode here.
  const content: Record<string, unknown> = {
    size: call.resBodyBase64 ? -1 : bodyText.length,
    mimeType: mimeType(call.resHeaders),
    text: bodyText,
  };
  if (call.resBodyBase64) content.encoding = "base64";
  const response = {
    status: call.status ?? 0,
    statusText: "",
    httpVersion: "HTTP/1.1",
    headers: toHeaders(call.resHeaders),
    cookies: responseCookies(call.resHeaders),
    content,
    redirectURL: "",
    headersSize: -1,
    bodySize: -1,
  };

  return {
    startedDateTime: "1970-01-01T00:00:00.000Z",
    // Timings are placeholders: the recorder tracks call sequence, not wall-clock
    // duration, so there's no real timing data to report here.
    time: 0,
    request,
    response,
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  };
}

/** Emit a HAR 1.2 document (as a JSON string) capturing the flow's requests/responses. */
export function emitHar(model: FlowModel): string {
  const har = {
    log: {
      version: "1.2",
      creator: { name: "browser-for-ai", version: "0.1.0" },
      entries: model.calls.map(buildEntry),
    },
  };
  return JSON.stringify(har, null, 2);
}
