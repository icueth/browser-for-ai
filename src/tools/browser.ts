import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEVICE_PRESETS } from "../session/manager";
import type { SessionManager } from "../session/manager";
import { ok, fail, table } from "../format/compact";
import { guard } from "./guard";

export function registerBrowserTools(server: McpServer, mgr: SessionManager): void {
  server.registerTool(
    "browser_launch",
    {
      description:
        "Open a browser session. Choose the mode by what the task needs:\n" +
        '• mode:"fresh" (default choice) — launch our own throwaway Chrome; add incognito:true for a clean slate. ' +
        "Best for reverse-engineering a public flow or any site that does NOT need your existing login. No setup.\n" +
        '• mode:"attach" — connect to a Chrome the user already started with a debug port (default 9222). Use when you ' +
        "need REAL logins/cookies, or a human-looking browser (navigator.webdriver=false, real profile & fingerprint, " +
        "passes basic bot checks). Requires starting Chrome first: `./bfa-chrome 9222` (Chrome 136+ needs a non-default " +
        "profile — bfa-chrome handles that). You canNOT attach to an already-open normal Chrome; it has no debug port.\n" +
        "Multiple concurrent sessions are supported. In attach mode only `port` is used — `profile`, `headless`, " +
        "`incognito` applies to fresh mode only. The session you launch becomes the ACTIVE one " +
        "(tools without sessionId target it). In fresh mode bfa auto-follows a tab the page opens " +
        "(so a game that launches in a new window keeps being driven); use browser_use_tab to switch " +
        "manually. For phone/PG games pass device:\"mobile\" for a stable viewport.",
      inputSchema: {
        mode: z.enum(["fresh", "attach"]).describe("fresh = launch our own; attach = connect to a debug-port Chrome"),
        url: z.string().url().optional().describe("optional URL to open immediately"),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe("attach: Chrome remote-debugging port (default 9222)"),
        profile: z.string().optional().describe("fresh: profile name under ~/.bfa/profiles"),
        incognito: z.boolean().optional().describe("fresh: isolated context with no prior state"),
        headless: z.boolean().optional().describe("fresh: run headless (default false)"),
        device: z
          .enum(["mobile", "desktop"])
          .optional()
          .describe(
            'device preset. "mobile" = a STABLE 390x844 phone viewport (dpr 3, mobile layout + iPhone UA) that does not track the OS window, so it never self-shrinks and your click coordinates stay put — use this for phone/PG-style games. "desktop" = 1280x800. Overridden by an explicit `viewport`.',
          ),
        viewport: z
          .object({
            width: z.number().int().min(1),
            height: z.number().int().min(1),
            deviceScaleFactor: z.number().optional(),
            mobile: z.boolean().optional(),
            hasTouch: z.boolean().optional(),
          })
          .optional()
          .describe(
            "page viewport. Default is 800x600 landscape, which letterboxes PORTRAIT canvas/WebGL games (Cocos) and lets their full-screen overlay swallow coordinate clicks. Set e.g. {width:390,height:844} so the canvas fills the viewport and page_click_at lands on the game. Keep hasTouch:false (default) so mouse clicks drive games that listen for mouse input.",
          ),
      },
    },
    async (args) =>
      guard(async () => {
        const info = await mgr.launch(args);
        const inc = info.incognito ? " incognito" : "";
        return ok(`session ${info.sessionId} (${info.mode}${inc}) → ${info.url ?? "about:blank"}\nnow the active session: tools without sessionId target ${info.sessionId}`);
      }),
  );

  server.registerTool(
    "browser_sessions",
    { description: "List all open browser sessions.", inputSchema: {} },
    async () =>
      guard(async () => {
        const rows = mgr.sessions().map((s) => [
          s.active ? `* ${s.sessionId}` : `  ${s.sessionId}`,
          s.mode + (s.incognito ? "/incognito" : ""),
          s.url ?? "-",
        ]);
        if (rows.length === 0) return ok("no open sessions");
        return ok(table(["id", "mode", "url"], rows));
      }),
  );

  server.registerTool(
    "browser_use",
    { description: "Set the active session that other tools target by default.", inputSchema: { sessionId: z.string() } },
    async ({ sessionId }) =>
      guard(async () => (mgr.use(sessionId) ? ok(`active → ${sessionId}`) : fail(`no session "${sessionId}"`))),
  );

  server.registerTool(
    "page_set_viewport",
    {
      description:
        "Resize an existing session's viewport without relaunching. Use a portrait size (e.g. {width:390,height:844}) for canvas/WebGL games so the game fills the screen and page_click_at coordinates land on it. Keep hasTouch:false (default) so mouse clicks drive the game; set hasTouch:true only for games that require touch input.",
      inputSchema: {
        device: z.enum(["mobile", "desktop"]).optional().describe('preset: "mobile" = 390x844 dpr3 phone (+mobile UA), "desktop" = 1280x800. Overridden by explicit width/height.'),
        width: z.number().int().min(1).optional(),
        height: z.number().int().min(1).optional(),
        deviceScaleFactor: z.number().optional(),
        mobile: z.boolean().optional().describe("emulate a mobile device (default false)"),
        hasTouch: z.boolean().optional().describe("emulate touch input (default false; mouse clicks won't drive touch-only games)"),
        sessionId: z.string().optional(),
      },
    },
    async ({ device, width, height, deviceScaleFactor, mobile, hasTouch, sessionId }) =>
      guard(async () => {
        const preset = device ? DEVICE_PRESETS[device] : undefined;
        const w = width ?? preset?.width;
        const h = height ?? preset?.height;
        if (w === undefined || h === undefined) return fail("page_set_viewport needs a device preset or explicit width+height");
        const page = mgr.pageFor(sessionId);
        const ua = preset?.userAgent;
        if (ua) await page.setUserAgent(ua).catch(() => {});
        await page.setViewport({
          width: w,
          height: h,
          deviceScaleFactor: deviceScaleFactor ?? preset?.deviceScaleFactor ?? 1,
          isMobile: mobile ?? preset?.mobile ?? false,
          hasTouch: hasTouch ?? preset?.hasTouch ?? false,
        });
        return ok(`viewport → ${w}x${h}${ua ? " (mobile UA)" : ""}`);
      }),
  );

  server.registerTool(
    "browser_tabs",
    { description: "List tabs/targets of a session.", inputSchema: { sessionId: z.string().optional() } },
    async ({ sessionId }) =>
      guard(async () => {
        const tabs = await mgr.tabs(sessionId);
        const rows = tabs.map((t) => [
          t.active ? `* ${t.index}` : `  ${t.index}`,
          t.title || "-",
          t.url,
        ]);
        return ok(table(["#", "title", "url"], rows));
      }),
  );

  server.registerTool(
    "browser_use_tab",
    {
      description:
        "Switch the session's DRIVEN tab to another one (index from browser_tabs), carrying the network/console recorder and any intercept rules across. Use it to drive a tab the page opened that bfa did not auto-follow, or to go back to the opener. In fresh mode bfa already auto-follows tabs the page opens.",
      inputSchema: { index: z.number().int().min(0), sessionId: z.string().optional() },
    },
    async ({ index, sessionId }) =>
      guard(async () => {
        const info = await mgr.useTab(index, sessionId);
        return ok(`driving tab ${index} → ${info.url ?? "about:blank"}`);
      }),
  );

  server.registerTool(
    "browser_close",
    {
      description: "Close one session, or all sessions with all=true.",
      inputSchema: { sessionId: z.string().optional(), all: z.boolean().optional() },
    },
    async ({ sessionId, all }) =>
      guard(async () => {
        // An explicit id that does not exist is an error, not a no-op: reporting success would
        // tell the caller a stale session was cleaned up when nothing happened. Matches
        // browser_use. "nothing to close" stays reserved for "no id given and nothing open".
        if (sessionId && !all && !mgr.has(sessionId)) return fail(`no session "${sessionId}"`);
        const closed = await mgr.close(sessionId, all ?? false);
        return closed.length ? ok(`closed: ${closed.join(", ")}`) : ok("nothing to close");
      }),
  );
}
