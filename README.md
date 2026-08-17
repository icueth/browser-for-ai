# browser-for-ai (bfa)

A **CDP-native MCP server** that lets an AI agent (Claude Code and any other MCP
client) drive a real Chrome browser at full depth — not just open pages and take
screenshots, but read the network and console the way a human does with DevTools
open, operate the page robustly, run many isolated sessions, and **reverse-engineer
a site's API flow into runnable code**.

It talks to Chrome directly over the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
(via `puppeteer-core`) and exposes ~40 compact tools over stdio.

---

## What it does

- **Deep network read.** Every request is buffered with full request/response
  **bodies** (text and base64 binary), headers, timing, redirect hops, and
  WebSocket frames. Dedicated tools surface **failures** (4xx/5xx + transport
  errors), **hangs** (still-pending requests), and **slow** calls — the things
  shallow screenshot-only tools can't see.
- **Robust interaction.** Click / type / fill / select / hover / scroll / key by
  a stable element **ref** or CSS selector, plus **coordinate** and **touch**
  interaction (`page_click_at` / `page_tap_at` / `page_drag`) for `<canvas>` /
  WebGL surfaces that have no DOM to target. Every action reports the
  network/console/URL **delta** it caused.
- **Multiple sessions & clean state.** Launch many concurrent sessions
  (fresh / incognito / attach to a debug-port Chrome), each isolated. Complete
  cache clearing and hard reload. Ephemeral profiles by default; named profiles
  when you want a login to persist. **Save/restore** a session's cookies +
  storage.
- **API-flow extraction → runnable code.** Mark a point, perform a flow in the
  browser, then export it as **HAR / JSON**, or **synthesize replay code**
  (`curl` / TypeScript / Go / Python) that automatically **chains dependencies**
  — an auth token from one response is lifted into a variable and re-used in the
  next request instead of being baked in as a literal. `flow_replay` then runs
  the reversed flow for real to prove it still works.

---

## Requirements

- **Node.js ≥ 20**
- **Google Chrome** installed (or set `BFA_CHROME_PATH` to your Chrome binary)

## Install & build

```bash
npm install
npm run build      # → dist/server.js
```

## Register with Claude Code

```bash
claude mcp add browser-for-ai -- node /absolute/path/to/browser-for-ai/dist/server.js
```

Use `--scope user` to make it available in every project:

```bash
claude mcp add browser-for-ai --scope user -- node /absolute/path/to/browser-for-ai/dist/server.js
```

> If `node` on your machine is provided by a version manager (nvm, asdf, …), pass
> the **absolute** path to the node binary (e.g.
> `~/.nvm/versions/node/vXX.Y.Z/bin/node`) — the MCP server is spawned by a
> non-interactive shell that won't resolve shell aliases.

Verify: `claude mcp get browser-for-ai` should report **✔ Connected**. The tools
load into a **new** session, so start a fresh Claude Code session after registering.

---

## Quick start

```jsonc
// 1. open a real Chrome window on the page you want to work with
browser_launch { "mode": "fresh", "url": "https://example.com" }

// 2. see what it looks like / what happened
page_screenshot
net_list                       // recent requests
net_failures                   // anything that errored
net_pending                    // anything still hanging

// 3. drive the page (ref comes from page_snapshot; a CSS selector also works)
page_snapshot                  // compact, ref-annotated view of the DOM
page_click  { "selector": "#login" }
page_type   { "selector": "#user", "text": "alice" }

// 4. inspect one call in full
net_get { "url": "/api/login" }   // headers + request body + response body

// 5. close when done
browser_close { "all": true }
```

---

## Sessions

`browser_launch { mode, url?, port?, profile?, incognito?, headless?, viewport? }`

- **`mode: "fresh"`** — launch our own Chrome. Headful by default (set
  `headless: true` for no window).
- **`mode: "attach"`** — connect to a Chrome already started with
  `--remote-debugging-port` (only `port` is used; default `9222`).
- **`incognito: true`** — isolated context with no prior state.
- **Profiles.** Omitting `profile` gives an **ephemeral** profile in a temp dir
  that is deleted on close — nothing persists. Naming one
  (`{ "profile": "work" }`) **persists** it under `~/.bfa/profiles/work`, so
  cookies/logins survive across sessions. Two concurrent sessions on the *same
  named* profile collide (Chrome allows one process per user-data dir); unnamed
  sessions are always safe.
- **Viewport.** `viewport: { width, height, deviceScaleFactor?, mobile?, hasTouch? }`
  at launch, or `page_set_viewport { … }` on a live session.

Manage them with `browser_sessions`, `browser_use { sessionId }`,
`browser_tabs`, and `browser_close { sessionId?, all? }`. Most tools accept an
optional `sessionId`; without it they target the active session.

---

## Tool reference

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
| `page_set_viewport` | resize the viewport of a live session |
| `page_snapshot` | compact, ref-annotated DOM view (source of element **refs**) |
| `page_observe` | diff since last observe — new console/network/URL/DOM |
| `page_screenshot` | PNG of the viewport, full page, or one element |
| `page_eval` | evaluate JS in the page and return the result |

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
| `page_click_at` | click at raw `{x, y}` coordinates (canvas/WebGL) |
| `page_tap_at` | touch-tap at `{x, y}` (touchstart→touchend) |
| `page_drag` | drag from one point/element to another |

### Network (deep read)
| tool | purpose |
|---|---|
| `net_list` | recent requests (filter by url/method/type/status) |
| `net_get` | one request in full: headers, request & response bodies |
| `net_failures` | 4xx/5xx + transport-level failures with error detail |
| `net_pending` | requests still in flight (hang candidates) |
| `net_slow` | finished requests slower than a threshold |
| `net_ws` | WebSocket connections + recent frames |
| `net_wait` | wait until a matching request appears / settles |

### Network (intercept & shape)
| tool | purpose |
|---|---|
| `net_intercept_add` | block / mock / modify matching requests (CDP Fetch) |
| `net_intercept_list` | list active intercept rules |
| `net_intercept_clear` | remove intercept rules |

### Console
| tool | purpose |
|---|---|
| `console_list` | console messages (filterable) |
| `console_errors` | errors + uncaught exceptions with stacks |

### API-flow extraction
| tool | purpose |
|---|---|
| `flow_mark` | mark the start of a flow in the recording |
| `flow_export` | export captured calls as JSON summary or HAR |
| `flow_synthesize` | generate replay code (`curl`/`ts`/`go`/`python`) with deps chained |
| `flow_replay` | execute the reversed flow for real (Node fetch) to verify it |

### Session persistence
| tool | purpose |
|---|---|
| `session_save` | save cookies + local/session storage to `~/.bfa/state` |
| `session_restore` | re-apply a saved session (origin-scoped) |

---

## Reverse-engineering an API flow → runnable code

The flagship workflow. Say a page logs in with `POST /api/login` (which returns a
`token`) and then calls `GET /api/me` with `Authorization: Bearer <token>`.

```jsonc
browser_launch { "mode": "fresh", "url": "https://app.example.com/login" }

flow_mark { "label": "login flow" }        // start capturing here
page_fill { "fields": [
  { "selector": "#user", "value": "alice" },
  { "selector": "#pass", "value": "s3cret" }
]}
page_click { "selector": "#submit" }        // fires /api/login then /api/me

flow_synthesize { "target": "curl" }
```

produces:

```bash
# call 0: POST /api/login
resp0=$(curl -s -X POST 'https://app.example.com/api/login' \
  -H 'content-type: application/json' \
  -d '{"user":"alice","pass":"s3cret"}')
token=$(echo "$resp0" | jq -r '.token')      # ← lifted from the response

# call 1: GET /api/me
curl -s -X GET 'https://app.example.com/api/me' \
  -H "authorization: Bearer $token"          # ← re-used, not a baked-in literal
```

The `token` was **detected** as a cross-call dependency and turned into a
variable — so the generated code re-derives it at run time. `flow_synthesize`
also emits **TypeScript / Go / Python**, and `flow_replay` runs the sequence for
real (with dependencies resolved from each live response) and reports
`✓ / ✗` per call so you know the reversal actually reproduces.

**Secrets.** Pass `flow_synthesize { "redact": true }` to replace unmatched
secret-bearing **header** values and whole-token request bodies with numbered
env placeholders (chained/dependency values are unaffected).

> Dependency detection is heuristic (exact / url-encoded / base64 / JWT-claim /
> substring matching). A value that can't be matched stays a literal for you to
> review, and an input echoed back in a response may be over-chained — always
> read the generated code before shipping it.

---

## Canvas / WebGL games

Puppeteer defaults to an **800×600 landscape** viewport. A *portrait*
canvas/WebGL game then renders letterboxed inside it, and its full-screen input
overlay can swallow coordinate clicks — so `page_click_at` on a Start/Spin button
does nothing.

Launch (or resize) with a **portrait viewport** so the canvas fills the screen:

```jsonc
browser_launch { "mode": "fresh", "incognito": true, "url": "…",
                 "viewport": { "width": 390, "height": 844 } }
// or on a live session:
page_set_viewport { "width": 390, "height": 844 }
```

Keep `hasTouch:false` (default) so `page_click_at` (a real **mouse** click)
drives games that listen for mouse input. For games that listen only for
**touch**, set the viewport `hasTouch:true` and use `page_tap_at { x, y }`
(dispatches touchstart→touchend) instead.

---

## Attach to a real, logged-in Chrome

```bash
./bin/bfa-chrome 9222            # dedicated profile
./bin/bfa-chrome 9222 "$HOME/Library/Application Support/Google/Chrome"  # your real profile
```

Then: `browser_launch { "mode": "attach", "port": 9222 }`.

> ⚠️ **Pointing `bfa-chrome` at your real Chrome profile (the second form) hands
> the agent every logged-in session on your machine** — email, cloud consoles,
> banking, source control, anything with a live cookie. It can read those pages
> and act as you in them. Prefer the dedicated-profile form, and use the real
> profile only when you specifically need an existing login and accept that blast
> radius.

Attaching requires Chrome to have been started with `--remote-debugging-port`.

---

## Clearing state

- `browser_clear_cache { sessionId? }` — clears HTTP cache, cookies, and storage
  for the session.
- `browser_hard_reload { sessionId? }` — reloads bypassing the cache.
- Ephemeral (unnamed) profiles are wiped on `browser_close` automatically.

---

## Notes & limitations

- The agent gets whatever the attached/launched browser can see. Treat an
  attached real-profile Chrome as full access to your logged-in accounts.
- `flow_replay` only replays `http`/`https`, times out per request, and is capped
  overall (60 s / 200 steps). It uses Node `fetch` server-side and never touches
  the live browser session.
- Dependency detection and secret redaction are best-effort heuristics — review
  generated code and exported HAR before sharing or running against production.

## Development

```bash
npm run typecheck
npm test          # unit + real-Chrome integration + in-memory MCP e2e
npm run build
```
