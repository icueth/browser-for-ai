import type { CDPSession, Page } from "puppeteer-core";
import { NetworkBuffer } from "./network";
import { ConsoleBuffer } from "./console";

/** Bound a single CDP call for best-effort operations (cache clearing, recovery) — never throws. */
async function boundedSend(client: CDPSession, method: string, params: Record<string, unknown>, ms: number): Promise<void> {
  let t: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.send(method as never, params as never).catch(() => undefined),
      new Promise<void>((r) => {
        t = setTimeout(r, ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export class Recorder {
  readonly network = new NetworkBuffer();
  readonly console = new ConsoleBuffer();
  private client: CDPSession | null = null;
  private seq = 0;
  private bodyCache = new Map<string, { body: string; base64: boolean }>();

  constructor(private page: Page) {}

  private next(): number {
    return ++this.seq;
  }
  seqNow(): number {
    return this.seq;
  }

  /** Contain any throw inside a buffer method so a single bad event can't escape
   *  puppeteer's event dispatch as an unhandled rejection and crash the recorder. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* swallow: recording is best-effort */
    }
  }

  async start(): Promise<void> {
    const client = await this.page.createCDPSession();
    this.client = client;
    // Register handlers BEFORE enabling the domains so events emitted during the
    // enable round-trips (e.g. attaching to an already-live page) aren't dropped.
    client.on("Network.requestWillBeSent", (e) => this.safe(() => this.network.requestWillBeSent(this.next(), e as never)));
    // ExtraInfo events carry the complete on-the-wire headers (Cookie + network-stack additions)
    // that requestWillBeSent/responseReceived can omit — merge them so captures are faithful.
    client.on("Network.requestWillBeSentExtraInfo", (e) => this.safe(() => this.network.requestWillBeSentExtraInfo(e as never)));
    client.on("Network.responseReceived", (e) => this.safe(() => this.network.responseReceived(e as never)));
    client.on("Network.responseReceivedExtraInfo", (e) => this.safe(() => this.network.responseReceivedExtraInfo(e as never)));
    client.on("Network.loadingFinished", (e) => this.safe(() => this.network.loadingFinished(e as never)));
    client.on("Network.loadingFailed", (e) => this.safe(() => this.network.loadingFailed(e as never)));
    client.on("Network.webSocketCreated", (e) => this.safe(() => this.network.webSocketCreated(this.next(), e as never)));
    client.on("Network.webSocketFrameSent", (e) => this.safe(() => this.network.webSocketFrame(this.next(), "sent", e as never)));
    client.on("Network.webSocketFrameReceived", (e) => this.safe(() => this.network.webSocketFrame(this.next(), "recv", e as never)));
    client.on("Network.webSocketClosed", (e) => this.safe(() => this.network.webSocketClosed(e as never)));
    client.on("Runtime.consoleAPICalled", (e) => this.safe(() => this.console.consoleAPICalled(this.next(), e as never)));
    client.on("Runtime.exceptionThrown", (e) => this.safe(() => this.console.exceptionThrown(this.next(), e as never)));
    client.on("Log.entryAdded", (e) => this.safe(() => this.console.logEntry(this.next(), e as never)));
    // Bound the response bodies Chrome retains for us: with no limit, DevTools keeps every body of
    // the session in memory (a long attach session streaming media grows Chrome until it crawls —
    // the "cache hang" users see). Bodies beyond the budget are simply unavailable to net_get.
    await client.send("Network.enable", {
      maxTotalBufferSize: 64 * 1024 * 1024,
      maxResourceBufferSize: 8 * 1024 * 1024,
      maxPostDataSize: 1024 * 1024,
    });
    await client.send("Runtime.enable");
    await client.send("Log.enable");
  }

  async stop(): Promise<void> {
    try {
      await this.client?.detach();
    } catch {
      /* best-effort */
    }
    this.client = null;
  }

  /** Forget the CDP session WITHOUT detaching — for teardown paths that are about to close or
   *  disconnect the whole browser connection (which tears the session down anyway). Awaiting a
   *  detach on a wedged renderer can stall for the entire protocol timeout. */
  abandon(): void {
    this.client = null;
  }

  /** Abort JavaScript currently executing in the page — the escape hatch for a renderer pinned by
   *  a busy loop. Must go over THIS session (attached before the hang): a session created during
   *  the hang never gets through. Harmless when nothing is running. */
  async terminateExecution(): Promise<void> {
    if (!this.client) return;
    await boundedSend(this.client, "Runtime.terminateExecution", {}, 1500);
  }

  /** Turn the page's own script execution off/on (DevTools evaluate still works while off) — the
   *  second-line recovery when a page-owned script keeps re-spinning after termination. */
  async setScriptsEnabled(enabled: boolean): Promise<void> {
    if (!this.client) return;
    await boundedSend(this.client, "Emulation.setScriptExecutionDisabled", { value: !enabled }, 2000);
  }

  /** Switch page scripts OFF while the JS thread is pinned. A plain Emulation command is a Blink-
   *  domain task that queues behind the spinning script forever, so we do what DevTools does:
   *  Debugger.pause is delivered by V8 interrupt and parks the thread in a nested loop that DOES
   *  process queued commands — there we disable scripts, mark the paused task for termination, and
   *  resume; the spinning task dies and, with scripts off, no timer can start the next one. */
  async disableScriptsHard(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    await boundedSend(c, "Debugger.enable", {}, 1500);
    await boundedSend(c, "Debugger.pause", {}, 1500);
    await boundedSend(c, "Emulation.setScriptExecutionDisabled", { value: true }, 2500);
    await boundedSend(c, "Runtime.terminateExecution", {}, 1500);
    await boundedSend(c, "Debugger.resume", {}, 1500);
    await boundedSend(c, "Debugger.disable", {}, 1500);
  }

  async bodyOf(id: string): Promise<{ body: string; base64: boolean } | null> {
    if (this.bodyCache.has(id)) return this.bodyCache.get(id)!;
    if (!this.client) return null;
    try {
      const r = (await this.client.send("Network.getResponseBody", { requestId: id })) as {
        body: string;
        base64Encoded: boolean;
      };
      this.cacheBody(id, r.body, r.base64Encoded);
      return this.bodyCache.get(id)!;
    } catch {
      return null;
    }
  }

  /** Seed the body cache directly, bypassing `Network.getResponseBody`. Needed for requests
   *  fulfilled via CDP `Fetch.fulfillRequest` (see Interceptor): Chromium never populates the
   *  network loader's body cache for a synthesized response, so `Network.getResponseBody`
   *  reliably returns nothing for them even though the caller already knows the exact body. */
  presetBody(id: string, body: string, base64: boolean): void {
    this.cacheBody(id, body, base64);
  }

  private cacheBody(id: string, body: string, base64: boolean): void {
    if (this.bodyCache.size >= 64) this.bodyCache.delete(this.bodyCache.keys().next().value as string);
    this.bodyCache.set(id, { body, base64 });
  }

  async postDataOf(id: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const r = (await this.client.send("Network.getRequestPostData", { requestId: id })) as { postData: string };
      return r.postData;
    } catch {
      return null;
    }
  }

  /** Clear storage for `origin` (default: the page's origin); with `profileWide` also the HTTP
   *  cache and ALL cookies of the whole profile. Every call is bounded so a huge profile can't
   *  turn this into a multi-minute stall. */
  async clearCache(origin?: string, profileWide = true): Promise<void> {
    if (!this.client) return;
    if (profileWide) {
      await boundedSend(this.client, "Network.clearBrowserCache", {}, 8000);
      await boundedSend(this.client, "Network.clearBrowserCookies", {}, 8000);
    }
    const org = origin ?? safeOrigin(this.page.url());
    if (org) await boundedSend(this.client, "Storage.clearDataForOrigin", { origin: org, storageTypes: "all" }, 8000);
  }

  async hardReload(): Promise<void> {
    if (!this.client) {
      await this.page.reload();
      return;
    }
    await this.client.send("Page.reload", { ignoreCache: true });
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
