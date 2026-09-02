import type { CDPSession, Page } from "puppeteer-core";
import type { Recorder } from "./recorder";

export type InterceptAction = "block" | "mock" | "modify";

export interface Rule {
  id: number;
  urlPattern: string;
  action: InterceptAction;
  status?: number;
  body?: string;
  contentType?: string;
  setHeaders?: Record<string, string>;
}

type RequestPausedEvt = {
  requestId: string;
  request: { url: string; headers?: Record<string, string> };
  // Only present when a matching Network.requestWillBeSent fired for this request — which it
  // does here, since the Recorder always keeps its own Network domain enabled. This is the id
  // the Recorder's NetworkBuffer actually keys entries by; `requestId` above is a *separate*
  // Fetch-domain interception id, valid only for the Fetch.* calls in this file.
  networkId?: string;
};

/**
 * Owns a dedicated CDPSession for `Fetch` interception, kept separate from the Recorder's own
 * CDPSession (src/recorder/recorder.ts) so enabling/disabling Fetch never disturbs the
 * Network/Runtime/Log domains the recorder depends on.
 *
 * Fetch is only kept enabled while at least one rule exists: with Fetch on, EVERY request of the
 * tab is held in Chrome until we answer it, so a bfa process that is stopped (not killed) or a
 * rule set that was cleared but left the domain on would wedge the whole page.
 */
export class Interceptor {
  private client: CDPSession | null = null;
  private enabling: Promise<void> | null = null;
  private rules: Rule[] = [];
  private nextId = 1;

  // `recorder` is optional and used only to seed the response-body cache for mocked requests
  // (see the comment on Recorder.presetBody) — Interceptor works without it, just without
  // net_get being able to show a mock's body.
  constructor(
    private page: Page,
    private recorder?: Recorder,
  ) {}

  /** Idempotent AND concurrency-safe: an MCP client can pipeline two net_intercept_add calls
   *  without awaiting the first, so two enable() calls can overlap. Memoizing the in-flight
   *  promise ensures only one CDPSession/listener/Fetch.enable ever happens — without this, the
   *  loser of the race would leak an orphaned CDPSession (never stored, never disable()d) that
   *  also double-handles every paused request. */
  async enable(): Promise<void> {
    if (this.client) return;
    if (this.enabling) return this.enabling;
    this.enabling = (async () => {
      const client = await this.page.createCDPSession();
      // Register the handler BEFORE enabling Fetch, matching the Recorder's own ordering, so no
      // paused request can arrive before something is listening to resolve it. The handler
      // closes over THIS session (not this.client) so a request paused before this.client is
      // published — or after it is cleared — is still continued rather than left hanging.
      client.on("Fetch.requestPaused", (e) => {
        this.onPaused(client, e as RequestPausedEvt).catch(() => {
          // onPaused already guards its own body and best-effort continues on error; this catch
          // only exists so a rejected promise from the event handler never becomes an unhandled
          // rejection that could crash the process.
        });
      });
      await client.send("Fetch.enable", {});
      this.client = client;
    })();
    try {
      await this.enabling;
    } finally {
      this.enabling = null;
    }
  }

  add(rule: Omit<Rule, "id">): Rule {
    const full: Rule = { ...rule, id: this.nextId++ };
    this.rules.push(full);
    return full;
  }

  list(): Rule[] {
    return [...this.rules];
  }

  /** Empties the rule set AND turns Fetch off (see the class comment) — the next add() re-enables
   *  it lazily via enable(). */
  async clear(): Promise<void> {
    this.rules = [];
    await this.disable();
  }

  async disable(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.send("Fetch.disable");
    } catch {
      // session may already be gone
    }
    try {
      await client.detach();
    } catch {
      // best-effort teardown
    }
  }

  /** Forget the session without detaching — for teardown paths that close/disconnect the whole
   *  browser connection anyway (see Recorder.abandon). */
  abandon(): void {
    this.client = null;
    this.enabling = null;
  }

  private async onPaused(client: CDPSession, e: RequestPausedEvt): Promise<void> {
    try {
      const rule = this.rules.find((r) => e.request.url.includes(r.urlPattern));
      if (!rule) {
        await client.send("Fetch.continueRequest", { requestId: e.requestId });
        return;
      }
      switch (rule.action) {
        case "block":
          await client.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" });
          return;
        case "mock":
          await client.send("Fetch.fulfillRequest", {
            requestId: e.requestId,
            responseCode: rule.status ?? 200,
            responseHeaders: [{ name: "content-type", value: rule.contentType ?? "application/json" }],
            body: Buffer.from(rule.body ?? "").toString("base64"),
          });
          // Network.getResponseBody never returns a body for a Fetch-fulfilled request (Chromium
          // doesn't populate the network loader's cache for a synthesized response) — seed the
          // recorder directly so net_get can still show what was served. Keyed by networkId, the
          // id the Recorder's NetworkBuffer actually uses (not the Fetch-domain requestId above).
          if (e.networkId) this.recorder?.presetBody(e.networkId, rule.body ?? "", false);
          return;
        case "modify": {
          const merged = { ...(e.request.headers ?? {}), ...(rule.setHeaders ?? {}) };
          const headers = Object.entries(merged).map(([name, value]) => ({ name, value }));
          await client.send("Fetch.continueRequest", { requestId: e.requestId, headers });
          return;
        }
      }
    } catch {
      // A paused request left unresolved stalls the whole page — always fall back to letting
      // it through, even if the rule lookup or the primary CDP call above failed.
      try {
        await client.send("Fetch.continueRequest", { requestId: e.requestId });
      } catch {
        // best-effort: the request/session may already be gone
      }
    }
  }
}
