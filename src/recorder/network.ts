import type { NetEntry, WsEntry, WsFrame, NetFilter } from "./types";

type ReqEvt = { requestId: string; type?: string; initiator?: { type?: string }; timestamp?: number; wallTime?: number;
  request: { url: string; method: string; headers?: Record<string, string>; hasPostData?: boolean };
  redirectResponse?: { url: string; status: number } };
type ResEvt = { requestId: string; response: { status: number; statusText?: string; headers?: Record<string, string>;
  mimeType?: string; fromDiskCache?: boolean } };
type FinEvt = { requestId: string; encodedDataLength?: number; timestamp?: number };
type FailEvt = { requestId: string; errorText?: string; blockedReason?: string; canceled?: boolean; timestamp?: number };
type WsCreatedEvt = { requestId: string; url: string };
type WsFrameEvt = { requestId: string; response: { opcode: number; payloadData: string } };
// ExtraInfo events carry the ACTUAL on-the-wire header set (Cookie, and anything the network
// stack injects) which the plain requestWillBeSent/responseReceived can omit or leave provisional.
type ReqExtraEvt = { requestId: string; headers?: Record<string, string> };
type ResExtraEvt = { requestId: string; headers?: Record<string, string> };

/** Case-insensitive header merge: `extra` (the on-the-wire ExtraInfo set) overrides `base` on
 *  same-name headers and contributes the ones base never saw (e.g. Cookie), while keeping base's
 *  original key casing so a single header can never appear twice under two casings. */
function mergeHeaders(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...base };
  const lowerToKey = new Map(Object.keys(base).map((k) => [k.toLowerCase(), k] as const));
  for (const [k, v] of Object.entries(extra)) {
    const existing = lowerToKey.get(k.toLowerCase());
    if (existing !== undefined) {
      out[existing] = v;
    } else {
      out[k] = v;
      lowerToKey.set(k.toLowerCase(), k);
    }
  }
  return out;
}

// Ring bounds: a long attach session (hours of browsing, media streams, chatty WebSockets) must
// not grow the MCP server — or the Chrome bodies it pins — without limit. Oldest entries go first.
const MAX_ENTRIES = 3000;
const MAX_WS = 200;
const MAX_WS_FRAMES = 500;
const MAX_WS_PAYLOAD = 4096;

export class NetworkBuffer {
  private entries = new Map<string, NetEntry>();
  private order: string[] = [];
  private ws = new Map<string, WsEntry>();
  private wsOrder: string[] = [];
  private seqMax = 0;
  // ExtraInfo can arrive before OR after its request/response, so headers seen early are held
  // here until the entry exists, then merged in. Bounded so an orphan id can't leak forever.
  private pendingReqExtra = new Map<string, Record<string, string>>();
  private pendingResExtra = new Map<string, Record<string, string>>();
  // Main-frame navigations (and tab switches), newest last, so callers can scope a listing to
  // "this page load" — the buffer deliberately accumulates across navigations for flow capture,
  // which otherwise leaves stale requests from earlier pages mixed into every net_list.
  private navs: { afterSeq: number; url: string }[] = [];

  /** Record a main-frame navigation to `url`. The mark is placed just BEFORE that page's own
   *  document request when we can find it, so a since-navigation listing includes the HTML fetch. */
  markNavigation(seq: number, url: string): void {
    let afterSeq = seq;
    for (let i = this.order.length - 1, seen = 0; i >= 0 && seen < 50; i--, seen++) {
      const e = this.entries.get(this.order[i]!);
      if (e && e.resourceType === "Document" && e.url === url) {
        afterSeq = e.seq - 1;
        break;
      }
    }
    this.navs.push({ afterSeq, url });
    if (this.navs.length > 50) this.navs.shift();
  }

  /** The most recent navigation mark, or null before any navigation was recorded. */
  lastNavigation(): { afterSeq: number; url: string } | null {
    return this.navs[this.navs.length - 1] ?? null;
  }

  requestWillBeSent(seq: number, e: ReqEvt): void {
    this.seqMax = Math.max(this.seqMax, seq);
    // Redirects reuse the requestId; before overwriting, capture the hop that just
    // completed (the previous entry's url, or redirectResponse.url if none existed)
    // so the chain accumulates across multiple hops. Keep the newest request line.
    const existing = this.entries.get(e.requestId);
    const redirects = [...(existing?.redirects ?? [])];
    if (e.redirectResponse) {
      redirects.push({ url: existing?.url ?? e.redirectResponse.url, status: e.redirectResponse.status });
    }
    this.entries.set(e.requestId, {
      id: e.requestId, seq,
      method: e.request.method, url: e.request.url, resourceType: e.type ?? "Other",
      requestHeaders: e.request.headers ?? {}, hasPostData: !!e.request.hasPostData,
      startTs: seq, wallStart: e.wallTime, tsStart: e.timestamp,
      finished: false, failed: false, initiatorType: e.initiator?.type,
      ...(redirects.length > 0 ? { redirects } : {}),
    });
    if (!existing) this.order.push(e.requestId);
    // Drain any ExtraInfo that raced ahead of this request.
    const extra = this.pendingReqExtra.get(e.requestId);
    if (extra) {
      this.pendingReqExtra.delete(e.requestId);
      const n = this.entries.get(e.requestId)!;
      n.requestHeaders = mergeHeaders(n.requestHeaders, extra);
    }
    while (this.order.length > MAX_ENTRIES) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  responseReceived(e: ResEvt): void {
    const n = this.entries.get(e.requestId); if (!n) return;
    n.status = e.response.status; n.statusText = e.response.statusText;
    n.mimeType = e.response.mimeType; n.responseHeaders = e.response.headers ?? {};
    n.fromCache = !!e.response.fromDiskCache;
    // responseReceivedExtraInfo usually precedes this — fold in the raw wire headers (all
    // Set-Cookie values, any header responseReceived normalized away).
    const extra = this.pendingResExtra.get(e.requestId);
    if (extra) {
      this.pendingResExtra.delete(e.requestId);
      n.responseHeaders = mergeHeaders(n.responseHeaders, extra);
    }
  }

  /** Network.requestWillBeSentExtraInfo — the real request headers as sent (Cookie included). */
  requestWillBeSentExtraInfo(e: ReqExtraEvt): void {
    if (!e.headers) return;
    const n = this.entries.get(e.requestId);
    if (n) {
      n.requestHeaders = mergeHeaders(n.requestHeaders, e.headers);
    } else {
      this.stash(this.pendingReqExtra, e.requestId, e.headers);
    }
  }

  /** Network.responseReceivedExtraInfo — the raw response headers (every Set-Cookie, etc.). */
  responseReceivedExtraInfo(e: ResExtraEvt): void {
    if (!e.headers) return;
    const n = this.entries.get(e.requestId);
    if (n && n.responseHeaders !== undefined) {
      n.responseHeaders = mergeHeaders(n.responseHeaders, e.headers);
    } else {
      this.stash(this.pendingResExtra, e.requestId, e.headers);
    }
  }

  private stash(map: Map<string, Record<string, string>>, id: string, headers: Record<string, string>): void {
    if (map.size >= 1024 && !map.has(id)) map.delete(map.keys().next().value as string);
    const prev = map.get(id);
    map.set(id, prev ? mergeHeaders(prev, headers) : headers);
  }

  loadingFinished(e: FinEvt): void {
    const n = this.entries.get(e.requestId); if (!n) return;
    n.finished = true; n.endTs = ++this.seqMax; n.encodedDataLength = e.encodedDataLength;
    this.applyTiming(n, e.timestamp);
  }

  loadingFailed(e: FailEvt): void {
    const n = this.entries.get(e.requestId); if (!n) return;
    n.finished = true; n.failed = true; n.errorText = e.errorText; n.blockedReason = e.blockedReason; n.endTs = ++this.seqMax;
    this.applyTiming(n, e.timestamp);
  }

  private applyTiming(n: NetEntry, tsEnd?: number): void {
    if (tsEnd === undefined) return;
    n.tsEnd = tsEnd;
    if (n.tsStart !== undefined) n.durationMs = (tsEnd - n.tsStart) * 1000;
  }

  webSocketCreated(seq: number, e: WsCreatedEvt): void {
    this.seqMax = Math.max(this.seqMax, seq);
    this.ws.set(e.requestId, { id: e.requestId, seq, url: e.url, frames: [], closed: false });
    this.wsOrder.push(e.requestId);
    while (this.wsOrder.length > MAX_WS) {
      const oldest = this.wsOrder.shift();
      if (oldest !== undefined) this.ws.delete(oldest);
    }
  }

  webSocketFrame(seq: number, dir: "sent" | "recv", e: WsFrameEvt): void {
    this.seqMax = Math.max(this.seqMax, seq);
    const w = this.ws.get(e.requestId); if (!w) return;
    const raw = e.response.payloadData ?? "";
    const payload = raw.length > MAX_WS_PAYLOAD ? `${raw.slice(0, MAX_WS_PAYLOAD)}…(+${raw.length - MAX_WS_PAYLOAD} chars)` : raw;
    const f: WsFrame = { seq, dir, opcode: e.response.opcode, payload, ts: seq };
    w.frames.push(f);
    if (w.frames.length > MAX_WS_FRAMES) w.frames.splice(0, w.frames.length - MAX_WS_FRAMES);
  }

  webSocketClosed(e: { requestId: string }): void {
    const w = this.ws.get(e.requestId); if (w) w.closed = true;
  }

  list(filter: NetFilter = {}): NetEntry[] {
    let rows = this.order.map((id) => this.entries.get(id)!).filter(Boolean);
    if (filter.afterSeq !== undefined) rows = rows.filter((e) => e.seq > filter.afterSeq!);
    if (filter.onlyXhr) rows = rows.filter((e) => e.resourceType === "XHR" || e.resourceType === "Fetch");
    if (filter.urlIncludes) rows = rows.filter((e) => e.url.includes(filter.urlIncludes!));
    if (filter.method) rows = rows.filter((e) => e.method.toUpperCase() === filter.method!.toUpperCase());
    if (filter.type) rows = rows.filter((e) => e.resourceType.toLowerCase() === filter.type!.toLowerCase());
    if (filter.status !== undefined) rows = rows.filter((e) => e.status === filter.status);
    return rows;
  }

  get(idOrUrl: string): NetEntry | undefined {
    const byId = this.entries.get(idOrUrl);
    if (byId) return byId;
    // Walk newest-first: the buffer accumulates across reloads/navigations, so a url substring
    // that recurs across multiple page loads (e.g. after page_goto re-issues the same fetch)
    // should resolve to the CURRENT request, not whichever one happened to load first.
    const rows = this.list();
    for (let i = rows.length - 1; i >= 0; i--) {
      const e = rows[i]!;
      if (e.url.includes(idOrUrl)) return e;
    }
    return undefined;
  }

  failures(afterSeq?: number): NetEntry[] {
    return this.list({ afterSeq }).filter((e) => e.failed || (e.status !== undefined && e.status >= 400));
  }

  pending(nowSeq: number, afterSeq?: number): NetEntry[] {
    return this.list({ afterSeq }).filter((e) => !e.finished && !e.failed && e.seq <= nowSeq);
  }

  wsList(): WsEntry[] {
    return this.wsOrder.map((id) => this.ws.get(id)!).filter(Boolean);
  }

  sinceSeq(seq: number): NetEntry[] {
    return this.list().filter((e) => e.seq > seq);
  }

  maxSeq(): number { return this.seqMax; }
}
