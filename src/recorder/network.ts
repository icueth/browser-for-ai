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

export class NetworkBuffer {
  private entries = new Map<string, NetEntry>();
  private order: string[] = [];
  private ws = new Map<string, WsEntry>();
  private wsOrder: string[] = [];
  private seqMax = 0;

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
    if (!this.order.includes(e.requestId)) this.order.push(e.requestId);
  }

  responseReceived(e: ResEvt): void {
    const n = this.entries.get(e.requestId); if (!n) return;
    n.status = e.response.status; n.statusText = e.response.statusText;
    n.mimeType = e.response.mimeType; n.responseHeaders = e.response.headers ?? {};
    n.fromCache = !!e.response.fromDiskCache;
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
  }

  webSocketFrame(seq: number, dir: "sent" | "recv", e: WsFrameEvt): void {
    this.seqMax = Math.max(this.seqMax, seq);
    const w = this.ws.get(e.requestId); if (!w) return;
    const f: WsFrame = { seq, dir, opcode: e.response.opcode, payload: e.response.payloadData, ts: seq };
    w.frames.push(f);
  }

  webSocketClosed(e: { requestId: string }): void {
    const w = this.ws.get(e.requestId); if (w) w.closed = true;
  }

  list(filter: NetFilter = {}): NetEntry[] {
    let rows = this.order.map((id) => this.entries.get(id)!).filter(Boolean);
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

  failures(): NetEntry[] {
    return this.list().filter((e) => e.failed || (e.status !== undefined && e.status >= 400));
  }

  pending(nowSeq: number): NetEntry[] {
    return this.list().filter((e) => !e.finished && !e.failed && e.seq <= nowSeq);
  }

  wsList(): WsEntry[] {
    return this.wsOrder.map((id) => this.ws.get(id)!).filter(Boolean);
  }

  sinceSeq(seq: number): NetEntry[] {
    return this.list().filter((e) => e.seq > seq);
  }

  maxSeq(): number { return this.seqMax; }
}
