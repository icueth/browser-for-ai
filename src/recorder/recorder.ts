import type { CDPSession, Page } from "puppeteer-core";
import { NetworkBuffer } from "./network";
import { ConsoleBuffer } from "./console";

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
    await client.send("Network.enable");
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

  async clearCache(origin?: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.send("Network.clearBrowserCache");
    } catch {
      /* */
    }
    try {
      await this.client.send("Network.clearBrowserCookies");
    } catch {
      /* */
    }
    const org = origin ?? safeOrigin(this.page.url());
    if (org) {
      try {
        await this.client.send("Storage.clearDataForOrigin", { origin: org, storageTypes: "all" });
      } catch {
        /* */
      }
    }
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
