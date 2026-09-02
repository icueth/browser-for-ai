# browser-for-ai (bfa)

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)
![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)
![Tools](https://img.shields.io/badge/tools-50-0a8fa6.svg)

**English** · [ภาษาไทย](README.th.md)

A **CDP-native MCP server** that lets an AI agent (Claude Code and any other MCP
client) drive a real Chrome at full depth — reading the network and console the
way a human does with DevTools open, operating the page robustly, and
**reverse-engineering a site's API flow into runnable code**.

---

## Why bfa

The things a screenshot-only browser tool can't do:

- **⭐ Turn a real session into runnable code.** Mark a flow, perform it in the
  browser, and bfa **synthesizes replay code** (curl / TypeScript / Go / Python)
  with cross-call **dependencies chained automatically** — an auth token from one
  response becomes a variable the next request re-uses, not a baked-in literal.
  `flow_replay` then runs it for real to prove the reversal reproduces.
- **🔬 See the whole network.** Full request/response **bodies** (text *and* binary
  base64), the **complete on-the-wire headers** (`Cookie` and custom signing headers
  included, merged from CDP ExtraInfo), timing, redirect hops, and WebSocket frames —
  surfaced by the exact question you're asking: `failures`, `pending` (hangs), `slow`.
- **🎮 Drive anything — by ref, by sight, or by pixel.** Ref / CSS interaction, raw
  **coordinate + touch** for `<canvas>` / WebGL, and **see-then-click**: `page_look` returns a
  screenshot with a numbered badge on every clickable element (Set-of-Mark), 1:1 with CSS px,
  so the model reads the picture and clicks by number — no coordinate math, no misclicks.
  Every action reports the network / console / URL **delta** it caused.
- **🧪 Shape traffic.** Block / mock / modify requests, and **throttle** to
  Slow 3G / offline / custom bandwidth with CPU slowdown.
- **🗂️ Real sessions.** Many concurrent sessions, incognito, **attach to your
  logged-in Chrome**, save/restore cookies + storage, and complete cache clearing.
- **⚡ Fast, and it never hangs.** `page_batch` runs a whole sequence in one round-trip and
  can end with a look; actions settle on *quiet* instead of fixed sleeps; `page_wait_for` /
  `net_wait` return the moment a condition holds. Every call is time-bounded: a runaway
  script is terminated (`page_eval` budget, `browser_recover`), `browser_close` force-kills
  an owned Chrome that won't exit, and the recorder is ring-bounded for day-long sessions.

### How it compares

| Capability | bfa | typical browser MCPs |
|---|:---:|:---:|
| Reverse a captured flow → runnable code, dependency-chained + replay-verified | ✅ | ✗ (at most Playwright-script codegen from UI actions) |
| Full response **bodies** (text + binary) & WebSocket frames, on by default | ✅ | mostly metadata only |
| Secret **redaction** in the emitted code | ✅ | ✗ |
| Coordinate **+ touch** interaction for canvas / WebGL | ✅ | some (vision mode) |
| Attach to your **logged-in** Chrome | ✅ | ✅ (common) |
| Network / CPU throttling presets | ✅ | some |
| Multi-step batch + see-the-result in ONE call; bounded calls, runaway-script recovery | ✅ | rare |
| Cloud-scaled browsers · stealth · proxies · CAPTCHA | ✗ *(local by design)* | some cloud tools |

bfa is a **local, developer-facing inspection & reverse-engineering** tool, not a
cloud scraping farm — that focus is why the first three rows are rare elsewhere.

---

## Requirements

- **Node.js ≥ 20**
- **Google Chrome** installed (or set `BFA_CHROME_PATH` to your Chrome binary)

## Install

Published on npm as **[`browser-for-ai`](https://www.npmjs.com/package/browser-for-ai)** — no clone or build required.

```bash
# zero-install (recommended) — pulls the latest and runs on demand
npx -y browser-for-ai

# …or install globally, exposing a `browser-for-ai` command
npm install -g browser-for-ai
```

<details><summary>Build from source instead</summary>

```bash
git clone https://github.com/icueth/browser-for-ai.git
cd browser-for-ai
npm install
npm run build      # → dist/server.js
```
</details>

## Register with an MCP client

**Claude Code** — via the published package (no path needed):

```bash
claude mcp add browser-for-ai --scope user -- npx -y browser-for-ai
```

Verify with `claude mcp get browser-for-ai` (should say **✔ Connected**). Tools load into a **new** session, so start a fresh Claude Code session afterward.

**AgentSpace** ships `browser-for-ai` as a **default** MCP server (`npx -y browser-for-ai`) — it appears under **Settings → MCP / Integrations** out of the box.

**Any MCP client** (raw stdio config):

```jsonc
{ "command": "npx", "args": ["-y", "browser-for-ai"] }
```

<details><summary>Register a local build instead of the npm package</summary>

```bash
claude mcp add browser-for-ai --scope user -- node /absolute/path/to/browser-for-ai/dist/server.js
```

> If `node` comes from a version manager (nvm, asdf, …), pass the **absolute** path to the node binary — the MCP server is spawned by a non-interactive shell that won't resolve aliases.
</details>

---

## Quick start

```jsonc
browser_launch { "mode": "fresh", "url": "https://example.com" }   // real window
page_screenshot
net_list            // recent requests
net_failures        // anything that errored
net_pending         // anything still hanging
page_snapshot       // ref-annotated DOM
page_click { "selector": "#login" }
net_get { "url": "/api/login" }   // one call in full: headers + bodies
browser_close { "all": true }
```

---

## Sessions

`browser_launch { mode, url?, port?, profile?, incognito?, headless?, viewport? }`

- **`fresh`** — launch our own Chrome (headful by default; `headless: true` for none).
- **`attach`** — connect to a Chrome started with `--remote-debugging-port`
  (only `port` is used; default `9222`).
- **`incognito: true`** — isolated context, no prior state.
- **Profiles.** No `profile` → ephemeral temp profile wiped on close. A named
  `{ "profile": "work" }` persists under `~/.bfa/profiles/work` so logins survive.
  Two concurrent sessions on the *same named* profile collide; unnamed ones are
  always safe.
- **Viewport** at launch, or `page_set_viewport` on a live session.

Manage with `browser_sessions`, `browser_use { sessionId }`, `browser_tabs`,
`browser_close`. Most tools accept an optional `sessionId`; without it they target
the active session.

---

## Tool reference (50)

### Sessions & lifecycle
| tool | purpose |
|---|---|
| `browser_launch` | launch fresh / attach a session |
| `browser_sessions` | list open sessions |
| `browser_use` | set the default session |
| `browser_tabs` | list a session's tabs/targets |
| `browser_close` | close one session, or `all` |
| `browser_clear_cache` | clear cache + cookies + storage |
| `browser_hard_reload` | bypass-cache reload |
| `browser_recover` | unfreeze a page whose JS is pinned (terminate script → scripts off → still readable/closable) |

### Navigation, state & read
| tool | purpose |
|---|---|
| `page_goto` | navigate to a URL |
| `page_state` | url, title, readyState, viewport |
| `page_set_viewport` | resize a live session's viewport |
| `page_snapshot` | compact, ref-annotated DOM (source of element **refs**) |
| `page_find` | find element(s) by text / ARIA role / CSS → refs (targeted vs snapshot) |
| `page_read` | read/search the page's **text content** (optionally by selector + query) |
| `page_look` | **see-then-click**: 1:1 screenshot with numbered badges on every clickable element + legend → `page_click {ref}` |
| `page_wait_for` | wait until a selector / text / URL / network-idle condition holds (instead of sleeping) |
| `page_observe` | delta since last observe — new console/network/URL/DOM |
| `page_screenshot` | PNG of viewport, full page, or one element |
| `page_eval` | evaluate JS in the page, return the value |

### Interaction
| tool | purpose |
|---|---|
| `page_click` | click a ref / selector (reports the delta) |
| `page_type` | type into a field (`clear:true` to replace) |
| `page_fill` | fill several fields in one call |
| `page_select` | choose an `<option>` by value |
| `page_key` | press a key or combo (e.g. `"Enter"`, `"Control+A"`) |
| `page_hover` | hover an element |
| `page_scroll` | scroll the window, or an element into view |
| `page_upload` | attach file(s) to a file `<input>` |
| `page_click_at` | click at raw `{x, y}` (canvas/WebGL) |
| `page_tap_at` | touch-tap at `{x, y}` |
| `page_drag` | drag between two points/elements |
| `page_batch` | **many steps in one call** (fill → click → wait_for …, target by selector/text/ref), one combined delta, optional final look |

### Network (deep read)
| tool | purpose |
|---|---|
| `net_list` | recent requests (filter by url/method/type/status) |
| `net_get` | one request in full: headers, request & response bodies |
| `net_failures` | 4xx/5xx + transport failures with error detail |
| `net_pending` | requests still in flight (hang candidates) |
| `net_slow` | finished requests slower than a threshold |
| `net_ws` | WebSocket connections + recent frames |
| `net_wait` | wait until a matching request appears / settles |

### Traffic shaping & emulation
| tool | purpose |
|---|---|
| `net_intercept_add` | block / mock / modify matching requests (CDP Fetch) |
| `net_intercept_list` | list active intercept rules |
| `net_intercept_clear` | remove intercept rules |
| `net_throttle` | emulate network (offline / 3G / 4G / custom) + CPU slowdown |

### Console
| tool | purpose |
|---|---|
| `console_list` | console messages (filterable by regex) |
| `console_errors` | errors + uncaught exceptions with stacks |

### API-flow extraction
| tool | purpose |
|---|---|
| `flow_mark` | mark the start of a flow in the recording |
| `flow_export` | export captured calls as JSON summary or HAR |
| `flow_synthesize` | generate replay code (curl/ts/go/python) with deps chained |
| `flow_replay` | execute the reversed flow for real (Node fetch) to verify |

### Session persistence
| tool | purpose |
|---|---|
| `session_save` | save cookies + local/session storage to `~/.bfa/state` |
| `session_restore` | re-apply a saved session (origin-scoped) |

---

## Reverse-engineering an API flow → runnable code

The flagship workflow. A page logs in with `POST /api/login` (returns a `token`),
then calls `GET /api/me` with `Authorization: Bearer <token>`:

```jsonc
browser_launch { "mode": "fresh", "url": "https://app.example.com/login" }
flow_mark { "label": "login flow" }
page_fill { "fields": [
  { "selector": "#user", "value": "alice" },
  { "selector": "#pass", "value": "s3cret" }
]}
page_click { "selector": "#submit" }
flow_synthesize { "target": "curl" }
```

produces:

```bash
resp0=$(curl -s -X POST 'https://app.example.com/api/login' \
  -H 'content-type: application/json' \
  -d '{"user":"alice","pass":"s3cret"}')
token=$(echo "$resp0" | jq -r '.token')      # ← lifted from the response

curl -s -X GET 'https://app.example.com/api/me' \
  -H "authorization: Bearer $token"          # ← re-used, not a literal
```

`flow_synthesize` also emits TypeScript / Go / Python, `flow_replay` runs the
sequence for real (deps resolved from each live response) and reports `✓ / ✗`
per call, and `{ "redact": true }` swaps secret-bearing header values and
whole-token bodies for env placeholders.

> Dependency detection is heuristic (exact / url-encoded / base64 / JWT-claim /
> substring). Unmatched values stay literal for you to review; always read the
> generated code before shipping it.

---

## Cookbook

### A. Debug a slow or hung page

```jsonc
browser_launch { "mode": "fresh", "url": "https://myapp.com" }
net_pending                      // the request that never finishes → the hang
net_slow { "thresholdMs": 1000 } // finished-but-slow calls, slowest first
net_failures                     // 4xx/5xx + transport errors
console_errors                   // the thrown stack trace
net_get { "url": "/api/user" }   // the failing call in full
```

### B. Reverse-engineer an API into runnable code

```jsonc
browser_launch { "mode": "fresh", "url": "https://app.com/login" }
flow_mark { "label": "login+fetch" }
page_fill { "fields": [
  { "selector": "#user", "value": "me" },
  { "selector": "#pass", "value": "pw" }
]}
page_click { "selector": "#submit" }
flow_synthesize { "target": "python" }      // code with the token chained in
flow_replay                                  // ✓/✗ per call — verified
```

### C. Stay logged in across runs

```jsonc
session_save { "name": "myapp" }             // first run, after logging in
// later:
browser_launch { "mode": "fresh" }
session_restore { "name": "myapp" }          // back in, no re-login
```

### D. Drive a canvas / WebGL app

```jsonc
browser_launch { "mode": "fresh", "incognito": true, "url": "https://game.example",
                 "viewport": { "width": 390, "height": 844 } }  // portrait
page_click_at { "x": 195, "y": 700 }         // press a button drawn on the canvas
net_ws                                        // read the app's WebSocket frames
net_pending                                   // catch asset-load hangs
```

### E. Test under a bad network / mocked endpoint

```jsonc
net_throttle { "preset": "slow-3g", "cpuRate": 4 }   // degrade the connection + CPU
net_intercept_add { "urlIncludes": "/api/config", "action": "mock",
                    "status": 200, "body": "{\"feature_x\":true}" }
browser_hard_reload
net_slow                                              // see what drags under 3G
net_throttle { "preset": "none" }                    // reset to full speed
```

### F. Upload a file through a form

```jsonc
page_snapshot
page_upload { "selector": "input[type=file]", "files": ["/abs/path/resume.pdf"] }
page_click { "selector": "#submit" }
net_get { "url": "/upload" }                  // confirm the multipart request
```

### G. See it, then click it (vision mode)

```jsonc
page_look                                    // screenshot with badges 1,2,3… on every clickable element + legend
// legend: [e7] button "ชำระเงิน" — read the picture, pick the badge, click the ref:
page_click { "ref": "e7" }

page_look { "text": "สมัคร" }                // badge only the elements whose text matches
page_screenshot                              // plain 1:1 image; any point (x,y) you read IS the click coord
page_click_at { "x": 640, "y": 412 }
```

### H. A whole flow in one round-trip (`page_batch`)

```jsonc
page_batch { "steps": [
  { "action": "fill",     "selector": "#user", "value": "alice" },
  { "action": "fill",     "selector": "#pass", "value": "s3cret" },
  { "action": "click",    "text": "Login" },                 // target by visible text
  { "action": "wait_for", "url": "/dashboard", "timeoutMs": 8000 }
], "look": true }
// → one combined network/console/url delta + a badged screenshot of the dashboard,
//   so the next page_click {ref} is chosen from the same reply. Stops at the first failing step.
```

---

## Canvas / WebGL games

Puppeteer defaults to an **800×600 landscape** viewport. A *portrait* game then
renders letterboxed, and its full-screen input overlay can swallow coordinate
clicks. Launch (or resize) with a **portrait viewport** so the canvas fills the
screen:

```jsonc
browser_launch { "mode": "fresh", "incognito": true, "url": "…",
                 "viewport": { "width": 390, "height": 844 } }
page_set_viewport { "width": 390, "height": 844 }   // on a live session
```

Keep `hasTouch:false` (default) so `page_click_at` (a real **mouse** click) drives
games listening for mouse input. For touch-only games, set the viewport
`hasTouch:true` and use `page_tap_at { x, y }`.

---

## Which mode do I want?

- **`fresh`** (default) — a throwaway Chrome, zero setup. Use for reverse-engineering
  a public flow or any site that does **not** need your existing login.
- **`attach`** — connect to a Chrome you started with a debug port. Use when you need
  **real logins/cookies** or a **human-looking** browser: `navigator.webdriver` is
  `false`, real profile & fingerprint, so it passes basic bot checks that a
  puppeteer-launched Chrome fails. Setup below.

## Attach to a real, logged-in Chrome

A normally-opened Chrome has **no** debug port, and **Chrome 136+ refuses one on the
*default* profile** (an anti-cookie-theft hardening) — so attach always uses a
*separate* profile:

```bash
# dedicated profile (recommended) — a window opens; log in there once, it persists
./bfa-chrome 9222

# …or reuse your existing logins via a COPY of your profile (a non-default dir)
cp -R "$HOME/Library/Application Support/Google/Chrome" "$HOME/.bfa/real-copy"
./bfa-chrome 9222 "$HOME/.bfa/real-copy"
```

Then: `browser_launch { "mode": "attach", "port": 9222 }`. (If the port isn't up, the
tool's error tells you this exact recipe.)

> ⚠️ A **copied real profile** hands the agent every logged-in session it contains —
> email, cloud consoles, banking, source control. It can read those pages and act as
> you. Prefer the dedicated profile; use a real-profile copy only when you need those
> logins and accept that blast radius.
>
> Do **not** point `bfa-chrome` at your live default profile: on Chrome 136+ the debug
> port silently won't open, and it would also collide with your running Chrome
> (one process per profile dir).

---

## Roadmap

Gaps we know about, in rough priority order:

- **iframe-aware refs** — `page_snapshot` / interaction currently resolve the top
  document only; cross-frame ref support is the next correctness item.
- **Device emulation presets** — bundle UA + viewport + touch + geolocation +
  permission grants into one call.
- **PDF export** — `Page.printToPDF` for report/invoice-style pages.
- **Playwright/Puppeteer test emission** — a new `flow_synthesize` target that
  outputs a runnable test script, not just replay code.
- **Natural-language element targeting** — an optional LLM-assisted layer over the
  existing deterministic ref model.
- **Performance tracing** — a thin `Tracing.start/stop` wrapper.

Out of scope by design: cloud-scaled browsers, stealth/anti-bot, and residential
proxies — bfa stays a local inspection tool.

---

## Notes & limitations

- The agent sees whatever the attached/launched browser sees. Treat an attached
  real-profile Chrome as full access to your logged-in accounts.
- **Persistent logins:** a **named** profile keeps the real OS keystore, so its
  cookies/logins survive across launches. (Puppeteer's default `--use-mock-keychain` /
  `--password-store=basic` can't decrypt real-keystore cookies and makes Chrome wipe the
  whole jar — a silent logout; bfa drops those for named profiles. The first launch may
  prompt for keychain access.) Ephemeral profiles don't persist and keep the mock store.
- **Automation fingerprint:** a `fresh` (puppeteer-launched) Chrome has
  `navigator.webdriver === true` and automation switches, so bot-detection can spot it.
  An **`attach`ed** Chrome is an ordinary browser (`navigator.webdriver === false`, real
  profile & fingerprint). bfa ships **no** fingerprint spoofing or anti-bot evasion by
  design — if a site blocks automation and you're authorized to operate there, use
  `attach` (a genuine browser), not a spoofing trick.
- **Never hangs, never needs a force-quit.** Native `alert`/`confirm` are dismissed, but
  `beforeunload` is **accepted** (= leave) so your own Cmd+W / Cmd+Q / reload is never
  vetoed. CDP calls time out at 30 s; `page_eval` has a budget and terminates a busy loop;
  `browser_recover` unfreezes a page whose own script spins; `browser_close` / shutdown are
  bounded and force-kill an owned Chrome that won't exit (attach sessions are only
  disconnected). `net_throttle` CPU is capped at 20x and any active throttle shows in
  `page_state`; Fetch interception is switched off when no rules remain.
- **Bounded memory.** The recorder keeps the newest 3000 requests / 200 sockets × 500 frames /
  2000 console lines, and asks Chrome to retain at most 64 MB of response bodies — a day-long
  attach session no longer grows until the browser crawls.
- `browser_clear_cache` defaults to the current origin in attach mode (your real profile);
  pass `scope:"all"` to wipe the whole profile's cache + cookies.
- `flow_replay` only replays `http`/`https`, times out per request, is capped
  overall (60 s / 200 steps), and never touches the live browser session.
- Headers are captured from the **actual wire** (CDP ExtraInfo), so `Cookie` and
  network-added headers are recorded — not just what `requestWillBeSent` first saw —
  and `net_get` shows **every** one, including custom signing headers
  (`x-api-key`, `x-signature`, `agent`, …), not just a well-known subset.
- Dependency detection and secret redaction are best-effort heuristics — review
  generated code and exported HAR before sharing or running against production.
  A **computed** value bfa can't reverse (e.g. a signature like
  `MD5(secret + timestamp)`) stays a literal; a failing `flow_replay` usually means
  exactly such a header still needs to be reproduced in your own code.

## Development

```bash
npm run typecheck
npm test          # unit + real-Chrome integration + in-memory MCP e2e
npm run build
```

## License

[MIT](LICENSE)
