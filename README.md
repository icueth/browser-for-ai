# browser-for-ai (bfa)

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)
![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)
![Tools](https://img.shields.io/badge/tools-44-0a8fa6.svg)

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
  base64), headers, timing, redirect hops, and WebSocket frames — surfaced by the
  exact question you're asking: `failures`, `pending` (hangs), `slow`.
- **🎮 Drive anything.** Ref / CSS interaction *and* raw **coordinate + touch**
  for `<canvas>` / WebGL surfaces with no DOM. Every action reports the
  network / console / URL **delta** it caused.
- **🧪 Shape traffic.** Block / mock / modify requests, and **throttle** to
  Slow 3G / offline / custom bandwidth with CPU slowdown.
- **🗂️ Real sessions.** Many concurrent sessions, incognito, **attach to your
  logged-in Chrome**, save/restore cookies + storage, and complete cache clearing.

### How it compares

| Capability | bfa | typical browser MCPs |
|---|:---:|:---:|
| Reverse a captured flow → runnable code, dependency-chained + replay-verified | ✅ | ✗ (at most Playwright-script codegen from UI actions) |
| Full response **bodies** (text + binary) & WebSocket frames, on by default | ✅ | mostly metadata only |
| Secret **redaction** in the emitted code | ✅ | ✗ |
| Coordinate **+ touch** interaction for canvas / WebGL | ✅ | some (vision mode) |
| Attach to your **logged-in** Chrome | ✅ | ✅ (common) |
| Network / CPU throttling presets | ✅ | some |
| Cloud-scaled browsers · stealth · proxies · CAPTCHA | ✗ *(local by design)* | some cloud tools |

bfa is a **local, developer-facing inspection & reverse-engineering** tool, not a
cloud scraping farm — that focus is why the first three rows are rare elsewhere.

---

## Requirements

- **Node.js ≥ 20**
- **Google Chrome** installed (or set `BFA_CHROME_PATH` to your Chrome binary)

## Install & build

```bash
git clone https://github.com/icueth/browser-for-ai.git
cd browser-for-ai
npm install
npm run build      # → dist/server.js
```

## Register with Claude Code

```bash
claude mcp add browser-for-ai --scope user -- node /absolute/path/to/browser-for-ai/dist/server.js
```

> If `node` comes from a version manager (nvm, asdf, …), pass the **absolute**
> path to the node binary — the MCP server is spawned by a non-interactive shell
> that won't resolve aliases.

Verify with `claude mcp get browser-for-ai` (should say **✔ Connected**). Tools
load into a **new** session, so start a fresh Claude Code session afterward.

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

## Tool reference (44)

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

### Navigation, state & read
| tool | purpose |
|---|---|
| `page_goto` | navigate to a URL |
| `page_state` | url, title, readyState, viewport |
| `page_set_viewport` | resize a live session's viewport |
| `page_snapshot` | compact, ref-annotated DOM (source of element **refs**) |
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

## Attach to a real, logged-in Chrome

```bash
./bin/bfa-chrome 9222            # dedicated profile
./bin/bfa-chrome 9222 "$HOME/Library/Application Support/Google/Chrome"  # your real profile
```

Then: `browser_launch { "mode": "attach", "port": 9222 }`.

> ⚠️ **Pointing `bfa-chrome` at your real Chrome profile hands the agent every
> logged-in session on your machine** — email, cloud consoles, banking, source
> control. It can read those pages and act as you. Prefer the dedicated-profile
> form; use the real profile only when you need an existing login and accept that
> blast radius.

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
- Native dialogs (`alert` / `confirm` / `beforeunload`) are **auto-dismissed** so
  the session never hangs on one.
- `flow_replay` only replays `http`/`https`, times out per request, is capped
  overall (60 s / 200 steps), and never touches the live browser session.
- Dependency detection and secret redaction are best-effort heuristics — review
  generated code and exported HAR before sharing or running against production.

## Development

```bash
npm run typecheck
npm test          # unit + real-Chrome integration + in-memory MCP e2e
npm run build
```

## License

[MIT](LICENSE)
