import type { Browser, BrowserContext, Page } from "puppeteer-core";
import type { Recorder } from "./recorder/recorder";

export type SessionId = string;
export type LaunchMode = "fresh" | "attach";

export interface LaunchOptions {
  mode: LaunchMode;
  url?: string;
  /** attach: Chrome remote-debugging port (default 9222). */
  port?: number;
  /** fresh: profile name under ~/.bfa/profiles. */
  profile?: string;
  /** fresh: use an isolated (incognito) browser context. */
  incognito?: boolean;
  /** fresh: run headless (default false). */
  headless?: boolean;
  /** fresh/attach: a device preset. "mobile" = a stable 390x844 phone viewport (dpr 3, mobile
   *  layout + UA) that does NOT track — and therefore never self-shrinks with — the OS window,
   *  which is the usual cause of drifting click coordinates. Overridden by an explicit `viewport`. */
  device?: "mobile" | "desktop";
  /** fresh/attach: page viewport. Puppeteer defaults to 800x600 landscape, which
   *  letterboxes portrait canvas games (Cocos/WebGL) and lets their full-screen
   *  overlay swallow coordinate clicks. Set e.g. {width:390,height:844} so the
   *  canvas fills the viewport and page_click_at lands on it. Keep hasTouch:false
   *  (default) so mouse clicks drive games that listen for mouse input. */
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
    hasTouch?: boolean;
  };
}

export interface SessionInfo {
  sessionId: SessionId;
  mode: LaunchMode;
  incognito: boolean;
  url: string | null;
  title: string | null;
  active: boolean;
}

export interface Session {
  id: SessionId;
  mode: LaunchMode;
  incognito: boolean;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  recorder: Recorder;
  /** true for fresh (we launched it → we may close the browser); false for attach (disconnect only). */
  ownsBrowser: boolean;
  /** set when launchFresh created an ephemeral userDataDir (no profile given); removed on teardown. */
  tempDir?: string;
  /** detaches browser-level listeners (e.g. the targetcreated dialog guard) on teardown. */
  cleanup?: () => void;
}

// Deliberately a `type` alias, not an `interface`. McpServer's registerTool callback return
// type (CallToolResult, zod-inferred) carries an index signature, and TS only grants an
// *implicit* index signature to type aliases — so this assigns cleanly without declaring an
// explicit `[x: string]: unknown`, which would switch off excess-property checking and let
// typos like `isEror: true` compile silently.
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};
