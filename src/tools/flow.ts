import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager";
import type { Recorder } from "../recorder/recorder";
import type { FlowModel, RawCall } from "../flow/types";
import { buildFlow } from "../flow/model";
import { applyDeps } from "../flow/deps";
import { emitCurl } from "../flow/emit/curl";
import { emitTs } from "../flow/emit/ts";
import { emitPython } from "../flow/emit/python";
import { emitGo } from "../flow/emit/go";
import { emitHar } from "../flow/emit/har";
import type { EmitOptions } from "../flow/emit/shared";
import {
  planReplay,
  extractRuntimeValue,
  resolveReplayValue,
  injectDepValue,
  type ReplayStep,
  type RuntimeResponse,
} from "../flow/replay";
import { ok, fail, truncate } from "../format/compact";
import { guard } from "./guard";

const EMITTERS: Record<"curl" | "ts" | "go" | "python", (model: FlowModel, opts?: EmitOptions) => string> = {
  curl: emitCurl,
  ts: emitTs,
  go: emitGo,
  python: emitPython,
};

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

/**
 * NetEntry -> RawCall, fetching bodies lazily via CDP. The only impure part of the flow
 * pipeline — everything downstream (buildFlow/applyDeps/emit*) is pure.
 *
 * The WS handshake shows up in `recorder.network.list()` as an ordinary HTTP request (CDP
 * reports it with resourceType "WebSocket"); it doesn't fit the request/response RawCall
 * shape, so it's always excluded, includeAll or not.
 */
async function assembleRawCalls(
  recorder: Recorder,
  opts: { sinceSeq: number; includeAll?: boolean },
): Promise<RawCall[]> {
  const entries = recorder.network
    .list(opts.includeAll ? {} : { onlyXhr: true })
    .filter((e) => e.seq > opts.sinceSeq && e.resourceType !== "WebSocket");

  const calls: RawCall[] = [];
  for (const e of entries) {
    const reqBody = e.hasPostData ? ((await recorder.postDataOf(e.id)) ?? undefined) : undefined;
    const resBodyResult = await recorder.bodyOf(e.id);
    calls.push({
      method: e.method,
      url: e.url,
      reqHeaders: lowerHeaders(e.requestHeaders),
      reqBody,
      status: e.status,
      resHeaders: lowerHeaders(e.responseHeaders ?? {}),
      resBody: resBodyResult?.body,
      resBodyBase64: resBodyResult?.base64,
    });
  }
  return calls;
}

/** Secret-bearing header values (authorization/cookie), replaced so the compact JSON summary
 *  doesn't spell out live credentials — synthesized code (flow_synthesize) still gets the real
 *  values via its own dependency-chain extraction, this only affects the summary text. */
const SECRET_HEADERS = new Set(["authorization", "cookie"]);

function redactSecretHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.has(key) ? "<redacted>" : value;
  }
  return out;
}

/** Compact structured summary of a flow: ordered calls (bodies truncated to a preview) plus
 *  the detected dependency chain — the part worth reading, since it's what a plain HAR can't show. */
function summarizeFlow(model: FlowModel): string {
  const calls = model.calls.map((c) => ({
    index: c.index,
    method: c.method,
    url: c.url,
    status: c.status,
    reqHeaders: Object.keys(c.reqHeaders).length > 0 ? redactSecretHeaders(c.reqHeaders) : undefined,
    resPreview: c.resBody ? truncate(c.resBody, 300) : undefined,
  }));
  const deps = model.deps.map((d) => ({
    fromCall: d.fromCall,
    toCall: d.toCall,
    source: d.source,
    varName: d.varName,
    location: d.consumed.location,
    field: d.consumed.field,
  }));
  return JSON.stringify({ calls, deps });
}

const DEFAULT_REPLAY_TIMEOUT_MS = 10_000;
/** Overall wall-clock budget for one flow_replay call, regardless of per-step timeout -- caps
 *  how long a large captured flow can hold the tool call open. */
const MAX_REPLAY_TOTAL_MS = 60_000;
/** Hard cap on the number of calls replayed in one invocation -- defense in depth alongside the
 *  wall-clock cap above (a flood of near-instant steps could otherwise still run long). */
const MAX_REPLAY_STEPS = 200;

function tryParseJsonBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

/**
 * Node fetch's `Headers.forEach` fires ONCE PER Set-Cookie header (never comma-joined, per
 * spec, since a cookie's own value can legally contain a comma) -- a plain overwrite would keep
 * only the LAST one. Join multiple Set-Cookie occurrences with "\n" instead, preserving the
 * FIRST one at the front of the string, since that's the one `extractRuntimeValue`'s cookie
 * branch reads (matching the recorder's own convention -- see `extractProduced` in
 * `flow/model.ts`, which likewise only ever tracks the FIRST Set-Cookie's first pair).
 */
function lowerFetchHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    out[lower] = lower === "set-cookie" && out[lower] !== undefined ? `${out[lower]}\n${value}` : value;
  });
  return out;
}

/**
 * Execute one replay step against the real endpoint (Node `fetch`), resolving its chained deps
 * from `responses` (earlier steps' ACTUAL live replay responses, not anything from the original
 * capture) at runtime — this is what makes flow_replay a genuine "does the reversed flow still
 * work" check rather than a re-send of literally what was captured. Deps are applied
 * longest-needle-first (mirrors the codegen emitters' `tokenize()` ordering) so one dep's value
 * being a substring of another's can't corrupt the substitution.
 */
async function executeReplayStep(
  step: ReplayStep,
  responses: Map<number, RuntimeResponse>,
  timeoutMs: number,
): Promise<{ line: string; response?: RuntimeResponse }> {
  let url = step.url;
  let headers = { ...step.headers };
  let body = step.body;
  const depNotes: string[] = [];

  const sortedDeps = [...step.deps].sort((a, b) => b.needle.length - a.needle.length);
  for (const dep of sortedDeps) {
    const priorResp = responses.get(dep.fromStep);
    const raw = priorResp ? extractRuntimeValue(dep.extract, priorResp) : undefined;
    if (raw === undefined) {
      depNotes.push(`${dep.varName} from #${dep.fromStep}: UNRESOLVED`);
      continue;
    }
    const resolved = resolveReplayValue(dep, raw);
    const injectedResult = injectDepValue({ url, headers, body }, dep, resolved);
    url = injectedResult.url;
    headers = injectedResult.headers;
    body = injectedResult.body;
    depNotes.push(`${dep.varName} from #${dep.fromStep}${injectedResult.injected ? "" : " (not found in request)"}`);
  }

  const depSuffix = depNotes.length > 0 ? ` [deps: ${depNotes.join(", ")}]` : "";
  const recordedSuffix = step.recordedStatus !== undefined ? ` (recorded ${step.recordedStatus})` : "";

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { line: `#${step.index} ${step.method} ${url} → SKIPPED (invalid URL) ✗${depSuffix}` };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { line: `#${step.index} ${step.method} ${url} → SKIPPED (non-http(s) scheme) ✗${depSuffix}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: step.method,
      headers,
      // A GET/HEAD request with a body is rejected outright by fetch; captured GET/HEAD calls
      // never have one anyway (browsers don't send them), but guard regardless.
      body: body !== undefined && step.method !== "GET" && step.method !== "HEAD" ? body : undefined,
      signal: controller.signal,
    });
    const bodyText = await res.text();
    const stored: RuntimeResponse = {
      status: res.status,
      bodyText,
      json: tryParseJsonBody(bodyText),
      headers: lowerFetchHeaders(res.headers),
    };
    // The ✓/✗ mark reflects status-match against the recording (the "does my reversed API still
    // work" verdict) -- a dep that failed to resolve is a separate, already-visible signal (the
    // "UNRESOLVED"/"not found" note in depSuffix), not folded into this mark.
    const statusMatches = step.recordedStatus === undefined || res.status === step.recordedStatus;
    const mark = statusMatches ? "✓" : "✗";
    return {
      line: `#${step.index} ${step.method} ${url} → ${res.status}${recordedSuffix} ${mark}${depSuffix}`,
      response: stored,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { line: `#${step.index} ${step.method} ${url} → ERROR (${msg})${recordedSuffix} ✗${depSuffix}` };
  } finally {
    clearTimeout(timer);
  }
}

export function registerFlowTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "flow_mark",
    {
      description:
        "Mark the current point in the network recording as a flow's start. flow_export/flow_synthesize default their capture window to calls recorded after this mark.",
      inputSchema: {
        sessionId: z.string().optional(),
        label: z.string().optional().describe("free-text note, echoed back in the confirmation"),
      },
    },
    async ({ sessionId, label }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const seq = recorder.seqNow();
        const resolvedId = mgr.setFlowMark(sessionId, seq);
        return ok(`flow mark set at seq ${seq} for session ${resolvedId}${label ? ` (${label})` : ""}`);
      }),
  );

  server.registerTool(
    "flow_export",
    {
      description:
        "Export the captured network calls since the last flow_mark (or the whole buffer) as a compact JSON summary (calls + detected cross-call dependencies) or a HAR document. Dependency detection (exact / url-encoded / base64 / JWT-claim / substring): a value that came verbatim from an earlier response is lifted to a variable; unmatched values (base64/encoded/JWT-internal, user-supplied literals) stay literal for you to review, and a request input echoed back in a response may be over-chained.",
      inputSchema: {
        sessionId: z.string().optional(),
        sinceSeq: z.number().int().nonnegative().optional().describe("override the window start; default is the session's flow_mark, else 0"),
        includeAll: z.boolean().optional().describe("include non-XHR/Fetch resource types (default: XHR/Fetch only)"),
        format: z.enum(["json", "har"]).optional().describe("default json"),
      },
    },
    async ({ sessionId, sinceSeq, includeAll, format }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const since = sinceSeq ?? mgr.getFlowMark(sessionId) ?? 0;
        const raw = await assembleRawCalls(recorder, { sinceSeq: since, includeAll });
        if (raw.length === 0) return ok("no calls captured in this window");
        const model = applyDeps(buildFlow(raw));
        return ok(format === "har" ? emitHar(model) : summarizeFlow(model));
      }),
  );

  server.registerTool(
    "flow_synthesize",
    {
      description:
        "Synthesize replay code (curl/TypeScript/Go/Python) for the captured network calls since the last flow_mark (or the whole buffer), chaining detected dependencies (e.g. an auth token from one response into a later request) as variables instead of baked-in literals. Dependency detection (exact / url-encoded / base64 / JWT-claim / substring): a value that came verbatim from an earlier response is lifted to a variable; unmatched values (base64/encoded/JWT-internal, user-supplied literals) stay literal for you to review, and a request input echoed back in a response may be over-chained.",
      inputSchema: {
        sessionId: z.string().optional(),
        sinceSeq: z.number().int().nonnegative().optional().describe("override the window start; default is the session's flow_mark, else 0"),
        includeAll: z.boolean().optional().describe("include non-XHR/Fetch resource types (default: XHR/Fetch only)"),
        target: z.enum(["curl", "ts", "go", "python"]),
        redact: z
          .boolean()
          .optional()
          .describe(
            "replace unmatched secret-bearing HEADER values (authorization/cookie, or any header value that looks like a long opaque token) and whole-literal request bodies with numbered env placeholders instead of the live value; does NOT cover url-query params or individual JSON-body fields, and chained (dependency-resolved) values are unaffected",
          ),
      },
    },
    async ({ sessionId, sinceSeq, includeAll, target, redact }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const since = sinceSeq ?? mgr.getFlowMark(sessionId) ?? 0;
        const raw = await assembleRawCalls(recorder, { sinceSeq: since, includeAll });
        if (raw.length === 0) return fail("no calls captured in this window");
        const model = applyDeps(buildFlow(raw));
        return ok(EMITTERS[target](model, { redact }));
      }),
  );

  server.registerTool(
    "flow_replay",
    {
      description:
        "Execute the captured network calls since the last flow_mark (or the whole buffer) for real, server-side (Node fetch, NOT the browser session) -- this verifies a synthesized flow actually reproduces. Chained dependencies (e.g. an auth token) are resolved at RUNTIME from each step's live replay response, not from the original capture, so a genuinely broken reversed flow is caught here. Returns a compact per-call report: '#i METHOD url → status (recorded status) ✓/✗ [deps: ...]'. Safety: only http/https URLs are replayed, each request has a timeout (default 10s), the whole call is capped at 60s / 200 steps, and it never touches the live browser session.",
      inputSchema: {
        sessionId: z.string().optional(),
        sinceSeq: z.number().int().nonnegative().optional().describe("override the window start; default is the session's flow_mark, else 0"),
        includeAll: z.boolean().optional().describe("include non-XHR/Fetch resource types (default: XHR/Fetch only)"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(MAX_REPLAY_TOTAL_MS)
          .optional()
          .describe("per-request timeout in ms (default 10000, capped at the overall 60000ms replay budget)"),
      },
    },
    async ({ sessionId, sinceSeq, includeAll, timeoutMs }) =>
      guard(async () => {
        const recorder = mgr.recorderFor(sessionId);
        const since = sinceSeq ?? mgr.getFlowMark(sessionId) ?? 0;
        const raw = await assembleRawCalls(recorder, { sinceSeq: since, includeAll });
        if (raw.length === 0) return fail("no calls captured in this window");
        const model = applyDeps(buildFlow(raw));
        const steps = planReplay(model);
        if (steps.length > MAX_REPLAY_STEPS) {
          return fail(`too many calls to replay in one invocation (${steps.length} > ${MAX_REPLAY_STEPS})`);
        }

        const effectiveTimeout = timeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS;
        const responses = new Map<number, RuntimeResponse>();
        const lines: string[] = [];
        const deadline = Date.now() + MAX_REPLAY_TOTAL_MS;

        for (const step of steps) {
          if (Date.now() > deadline) {
            lines.push(`#${step.index} ${step.method} ${step.url} → SKIPPED (overall replay time budget exceeded)`);
            continue;
          }
          const { line, response } = await executeReplayStep(step, responses, effectiveTimeout);
          lines.push(line);
          if (response) responses.set(step.index, response);
        }

        return ok(lines.join("\n"));
      }),
  );
}
