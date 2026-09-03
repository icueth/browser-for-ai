# browser-for-ai (bfa)

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)
![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)
![Tools](https://img.shields.io/badge/tools-51-0a8fa6.svg)

[English](README.md) · **ภาษาไทย**

**MCP server แบบ CDP-native** ที่ให้ AI agent (Claude Code และ MCP client อื่นๆ)
ใช้ Chrome จริงได้ลึกเท่าที่คนเปิด DevTools ทำได้ — อ่าน network/console เต็ม,
ขับหน้าเว็บได้ทุกแบบ, และ **แกะ API flow ของเว็บออกมาเป็นโค้ดที่รันได้จริง**

---

## ทำไมต้อง bfa

สิ่งที่เครื่องมือ browser แบบถ่าย screenshot อย่างเดียวทำไม่ได้:

- **⭐ เปลี่ยน session จริงให้เป็นโค้ด** — ปักหมุด flow, ทำงานบนหน้าเว็บ แล้ว bfa
  **สังเคราะห์โค้ดรีเพลย์** (curl / TypeScript / Go / Python) พร้อม **ต่อ dependency
  ข้าม call อัตโนมัติ** — token ที่ได้จาก response แรกจะกลายเป็นตัวแปรที่ request
  ถัดไปดึงไปใช้ ไม่ใช่ค่า literal ฝังตาย จากนั้น `flow_replay` รันจริงเพื่อพิสูจน์ว่าใช้ได้
- **🔬 เห็น network ทั้งหมด** — **body เต็ม** ทั้ง request/response (ทั้ง text และ
  binary base64), **header ครบตามที่ส่งจริงบนสาย** (รวม `Cookie` และ custom signing
  header, merge จาก CDP ExtraInfo), timing, redirect, และเฟรม WebSocket — เรียกดูได้ตรง
  คำถาม: `failures`, `pending` (ค้าง), `slow`
- **🎮 ขับได้ทุกอย่าง — ด้วย ref, ด้วยสายตา, หรือด้วยพิกัด** — ref/CSS, **พิกัด + สัมผัส** สำหรับ
  `<canvas>` / WebGL, และ **เห็นแล้วคลิก**: `page_look` คืน screenshot ที่มีเลขกำกับบนทุก element
  ที่กดได้ (Set-of-Mark) ขนาด 1:1 กับ CSS px → model ดูภาพ เลือกเลข แล้วคลิก ไม่ต้องคำนวณพิกัด
  ไม่คลิกพลาด ทุก action รายงาน **delta** (network/console/URL) ที่เกิดขึ้น
- **🧪 ปั้น traffic ได้** — block / mock / แก้ request และ **throttle** เป็น Slow 3G /
  offline / bandwidth กำหนดเอง พร้อมหน่วง CPU
- **🗂️ session จริง** — หลาย session พร้อมกัน, incognito, **attach เข้า Chrome ที่
  ล็อกอินอยู่**, save/restore cookie + storage, และล้าง cache สมบูรณ์
- **🎯 ขับ tab ที่ถูกต้อง บน viewport ที่นิ่ง** — session ที่ launch คือตัว active; bfa **auto-follow tab
  ที่หน้าเปิด** (เกมที่เด้งหน้าต่างใหม่ก็ยังถูกขับต่อ) และ **self-heal** ไป tab ที่ยังเปิดอยู่แทนที่จะ error เมื่อ tab ปิด
  launch ด้วย `device:"mobile"` เพื่อ viewport มือถือ **390×844 ที่นิ่ง ไม่หด**เอง พิกัด `page_look` / `page_click_at` จึงไม่เพี้ยน
- **⚡ เร็ว และไม่มีวันค้าง** — `page_batch` ทำทั้งลำดับในรอบเดียวและปิดท้ายด้วย look ได้;
  ทุก action รอแค่จน "นิ่ง" ไม่ใช่ sleep ตายตัว; `page_wait_for` / `net_wait` คืนทันทีที่เงื่อนไขจริง
  ทุกคำสั่งมีเพดานเวลา: สคริปต์วนลูปถูกหยุด (`page_eval` มี budget, `browser_recover`),
  `browser_close` force-kill Chrome ที่เราเปิดถ้าไม่ยอมปิด, recorder เป็น ring buffer สำหรับ session ยาวๆ

### เทียบกับตัวอื่น

| ความสามารถ | bfa | browser MCP ทั่วไป |
|---|:---:|:---:|
| แกะ flow → โค้ดรันได้ + ต่อ dependency + verify ด้วย replay | ✅ | ✗ (อย่างมากแค่ codegen เป็น Playwright script จาก UI action) |
| **body เต็ม** (text + binary) และเฟรม WebSocket เป็น default | ✅ | ส่วนใหญ่ให้แค่ metadata |
| **redact** secret ในโค้ดที่สร้าง | ✅ | ✗ |
| พิกัด **+ สัมผัส** สำหรับ canvas / WebGL | ✅ | บางตัว (vision mode) |
| attach เข้า Chrome ที่ **ล็อกอินอยู่** | ✅ | ✅ (มีทั่วไป) |
| throttle network / CPU | ✅ | บางตัว |
| batch หลาย step + เห็นผลในคำสั่งเดียว; ทุกคำสั่งมีเพดานเวลา + กู้สคริปต์ค้าง | ✅ | หายาก |
| browser บน cloud · stealth · proxy · CAPTCHA | ✗ *(เป็น local โดยตั้งใจ)* | บาง cloud tool |

bfa เป็นเครื่องมือ **inspection & reverse-engineering ฝั่ง dev ที่รันในเครื่อง** ไม่ใช่
ฟาร์ม scraping บน cloud — โฟกัสตรงนี้คือเหตุผลที่ 3 แถวแรกหายากในตัวอื่น

---

## ความต้องการของระบบ

- **Node.js ≥ 20**
- ติดตั้ง **Google Chrome** (หรือกำหนด `BFA_CHROME_PATH` ชี้ไป Chrome ของคุณ)

## ติดตั้ง

อยู่บน npm แล้วในชื่อ **[`browser-for-ai`](https://www.npmjs.com/package/browser-for-ai)** — ไม่ต้อง clone หรือ build

```bash
# ไม่ต้องติดตั้ง (แนะนำ) — ดึงเวอร์ชันล่าสุดมารันเลย
npx -y browser-for-ai

# …หรือติดตั้งแบบ global ได้คำสั่ง `browser-for-ai`
npm install -g browser-for-ai
```

<details><summary>หรือ build จาก source เอง</summary>

```bash
git clone https://github.com/icueth/browser-for-ai.git
cd browser-for-ai
npm install
npm run build      # → dist/server.js
```
</details>

## ลงทะเบียนกับ MCP client

**Claude Code** — ผ่าน package บน npm (ไม่ต้องใส่ path):

```bash
claude mcp add browser-for-ai --scope user -- npx -y browser-for-ai
```

ตรวจด้วย `claude mcp get browser-for-ai` (ควรขึ้น **✔ Connected**) — tools โหลดเข้า session **ใหม่** ให้เปิด Claude Code session ใหม่หลังลงทะเบียน

**AgentSpace** ใส่ `browser-for-ai` เป็น MCP server **default** ให้อยู่แล้ว (`npx -y browser-for-ai`) — เห็นได้ที่ **Settings → MCP / Integrations** เลย

**MCP client อื่นๆ** (config stdio ดิบๆ):

```jsonc
{ "command": "npx", "args": ["-y", "browser-for-ai"] }
```

<details><summary>ลงทะเบียนจาก build ในเครื่องแทน npm</summary>

```bash
claude mcp add browser-for-ai --scope user -- node /absolute/path/to/browser-for-ai/dist/server.js
```

> ถ้า `node` มาจาก version manager (nvm, asdf, …) ให้ใส่ **absolute path** ของ binary node — เพราะ MCP server ถูกเรียกจาก shell ที่ไม่ resolve alias
</details>

---

## เริ่มใช้งานเร็ว

```jsonc
browser_launch { "mode": "fresh", "url": "https://example.com" }   // หน้าต่างจริง
page_screenshot
net_list            // request ล่าสุด
net_failures        // อันที่ error
net_pending         // อันที่ยังค้าง
page_snapshot       // DOM ที่ติด ref
page_click { "selector": "#login" }
net_get { "url": "/api/login" }   // ดู 1 call เต็ม: header + body
browser_close { "all": true }
```

---

## Session

`browser_launch { mode, url?, port?, profile?, incognito?, headless?, viewport? }`

- **`fresh`** — เปิด Chrome ของเราเอง (มีหน้าต่างเป็นค่าเริ่มต้น; `headless: true`
  ถ้าไม่ต้องการหน้าต่าง)
- **`attach`** — เกาะ Chrome ที่เปิดด้วย `--remote-debugging-port` (ใช้แค่ `port`;
  ค่าเริ่มต้น `9222`)
- **`incognito: true`** — context แยกขาด ไม่มี state เดิม
- **Profile** — ไม่ใส่ `profile` → profile ชั่วคราวในโฟลเดอร์ temp ลบเมื่อปิด ใส่ชื่อ
  `{ "profile": "work" }` → เก็บถาวรที่ `~/.bfa/profiles/work` ทำให้ login อยู่ข้ามครั้ง
  (สอง session บน profile ชื่อเดียวกันชนกัน; แบบไม่ตั้งชื่อปลอดภัยเสมอ)
- **`device: "mobile"`** — viewport มือถือ 390×844 (dpr 3, layout + UA มือถือ) ที่ **ไม่** ตามขนาดหน้าต่าง
  จึงไม่หดเอง พิกัดคลิกไม่เพี้ยน เหมาะกับเกมมือถือ/PG; `device: "desktop"` = 1280×800 ใส่ `viewport`
  เองจะทับ preset; ถ้าไม่ใส่ทั้งคู่ หน้าจะตามหน้าต่างจริง (ซึ่งหดได้)
- **Viewport** ตอน launch หรือ `page_set_viewport { device }` / `{ width, height }` บน session ที่เปิดอยู่

session ที่ launch จะเป็นตัว **active**; launch ตัวใหม่ทำให้ตัวนั้น active fresh mode จะ **auto-follow tab
ที่หน้าเปิด** และ **self-heal** ไป tab อื่นถ้า tab ที่ขับปิดไป จัดการด้วย `browser_sessions`,
`browser_use { sessionId }`, `browser_tabs`, `browser_use_tab { index }`, `browser_close` —
tool ส่วนใหญ่รับ `sessionId` (ไม่ใส่ = ใช้ session ที่ active อยู่)

---

## รายการ tools ทั้งหมด (51)

### Session & lifecycle
| tool | หน้าที่ |
|---|---|
| `browser_launch` | เปิด session ใหม่ / attach |
| `browser_sessions` | ดู session ที่เปิดอยู่ |
| `browser_use` | ตั้ง session เริ่มต้น |
| `browser_tabs` | ดู tab/target ของ session |
| `browser_use_tab` | สลับ tab ที่ขับ (ยก recorder + intercept ตามไป; fresh mode auto-follow tab ที่หน้าเปิด) |
| `browser_close` | ปิด session (หรือ `all`) |
| `browser_clear_cache` | ล้าง cache + cookie + storage |
| `browser_hard_reload` | reload ข้าม cache |
| `browser_recover` | กู้หน้าที่ JS ค้าง (หยุดสคริปต์ → ปิด scripts → ยังอ่าน/ปิดได้) |

### Navigation, state & อ่านหน้า
| tool | หน้าที่ |
|---|---|
| `page_goto` | ไปยัง URL |
| `page_state` | url, title, readyState, viewport |
| `page_set_viewport` | ปรับ viewport ของ session |
| `page_snapshot` | DOM แบบย่อ + ติด **ref** ทุก element |
| `page_find` | หา element ด้วย text / ARIA role / CSS → คืน ref (เจาะจงกว่า snapshot) |
| `page_read` | อ่าน/ค้น **ข้อความเนื้อหา** ในหน้า (เลือก selector + query ได้) |
| `page_look` | **เห็นแล้วคลิก**: screenshot 1:1 ที่มีเลขกำกับบนทุก element ที่กดได้ + legend → `page_click {ref}` |
| `page_wait_for` | รอจน selector / ข้อความ / URL / network-idle เป็นจริง (แทน sleep) |
| `page_observe` | delta ตั้งแต่ครั้งก่อน (console/network/URL/DOM) |
| `page_screenshot` | PNG ของ viewport / เต็มหน้า / element เดียว |
| `page_eval` | รัน JS ในหน้า แล้วคืนค่า |

### โต้ตอบหน้าเว็บ
| tool | หน้าที่ |
|---|---|
| `page_click` | คลิก ref / selector (รายงาน delta) |
| `page_type` | พิมพ์ลงช่อง (`clear:true` เพื่อล้างก่อน) |
| `page_fill` | กรอกหลายช่องในครั้งเดียว |
| `page_select` | เลือก `<option>` ตาม value |
| `page_key` | กดปุ่ม/คอมโบ (เช่น `"Enter"`, `"Control+A"`) |
| `page_hover` | hover element |
| `page_scroll` | เลื่อนหน้า หรือเลื่อน element เข้ามาในจอ |
| `page_upload` | แนบไฟล์ใส่ file `<input>` |
| `page_click_at` | คลิกที่พิกัด `{x, y}` (canvas/WebGL) |
| `page_tap_at` | แตะ (touch) ที่พิกัด `{x, y}` |
| `page_drag` | ลากระหว่างจุด/element |
| `page_batch` | **หลาย step ในคำสั่งเดียว** (fill → click → wait_for … ระบุเป้าด้วย selector/text/ref) delta รวม + look ปิดท้ายได้ |

### Network (อ่านลึก)
| tool | หน้าที่ |
|---|---|
| `net_list` | request ล่าสุด (กรอง url/method/type/status; `since:"nav"` = เฉพาะหน้านี้) |
| `net_get` | 1 request เต็ม: header + body ทั้ง req/resp |
| `net_failures` | 4xx/5xx + transport error พร้อมรายละเอียด |
| `net_pending` | request ที่ยังค้าง (ตัวการทำหน้าค้าง) |
| `net_slow` | request ที่ช้ากว่าที่กำหนด |
| `net_ws` | WebSocket + เฟรมล่าสุด |
| `net_wait` | รอจน request ที่ match โผล่/จบ (เฉพาะ request ตั้งแต่ action ล่าสุด) |

### ปั้น traffic & emulation
| tool | หน้าที่ |
|---|---|
| `net_intercept_add` | block / mock / แก้ request (CDP Fetch) |
| `net_intercept_list` | ดู rule ที่ทำงานอยู่ |
| `net_intercept_clear` | ลบ rule |
| `net_throttle` | จำลอง network (offline / 3G / 4G / custom) + หน่วง CPU |

### Console
| tool | หน้าที่ |
|---|---|
| `console_list` | ข้อความ console (กรองด้วย regex) |
| `console_errors` | error + uncaught exception พร้อม stack |

### แกะ API flow
| tool | หน้าที่ |
|---|---|
| `flow_mark` | ปักหมุดจุดเริ่ม flow |
| `flow_export` | export เป็น JSON summary หรือ HAR |
| `flow_synthesize` | สร้างโค้ดรีเพลย์ (curl/ts/go/python) + ต่อ dependency |
| `flow_replay` | รัน flow ที่แกะจริง (Node fetch) เพื่อ verify |

### เก็บ session ถาวร
| tool | หน้าที่ |
|---|---|
| `session_save` | เซฟ cookie + local/session storage ไป `~/.bfa/state` |
| `session_restore` | คืนค่า session ที่เซฟไว้ (origin-scoped) |

---

## แกะ API flow → โค้ดรันได้

เวิร์กโฟลว์เรือธง หน้าเว็บ login ด้วย `POST /api/login` (คืน `token`) แล้วเรียก
`GET /api/me` ด้วย `Authorization: Bearer <token>`:

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

ได้:

```bash
resp0=$(curl -s -X POST 'https://app.example.com/api/login' \
  -H 'content-type: application/json' \
  -d '{"user":"alice","pass":"s3cret"}')
token=$(echo "$resp0" | jq -r '.token')      # ← ดึงมาจาก response

curl -s -X GET 'https://app.example.com/api/me' \
  -H "authorization: Bearer $token"          # ← เอามาต่อ ไม่ใช่ literal
```

`flow_synthesize` สร้าง TypeScript / Go / Python ได้ด้วย, `flow_replay` รัน flow จริง
(resolve dep จาก response สดแต่ละ call) แล้วรายงาน `✓ / ✗` ต่อ call, และ
`{ "redact": true }` แทน secret ใน header/body ด้วย env placeholder

> การตรวจ dependency เป็น heuristic (exact / url-encoded / base64 / JWT-claim /
> substring) ค่าที่ match ไม่ได้จะปล่อยเป็น literal ให้ตรวจเอง — อ่านโค้ดที่สร้างก่อนใช้เสมอ

---

## Cookbook

### A. Debug หน้าเว็บช้า/ค้าง

```jsonc
browser_launch { "mode": "fresh", "url": "https://myapp.com" }
net_pending                      // request ที่ไม่จบ → ตัวค้าง
net_slow { "thresholdMs": 1000 } // call ที่เสร็จแต่ช้า เรียงช้าสุดก่อน
net_failures                     // 4xx/5xx + transport error
console_errors                   // stack ที่ throw
net_get { "url": "/api/user" }   // call ที่ fail เต็มๆ
```

### B. แกะ API เป็นโค้ดรันได้

```jsonc
browser_launch { "mode": "fresh", "url": "https://app.com/login" }
flow_mark { "label": "login+fetch" }
page_fill { "fields": [
  { "selector": "#user", "value": "me" },
  { "selector": "#pass", "value": "pw" }
]}
page_click { "selector": "#submit" }
flow_synthesize { "target": "python" }      // โค้ดที่ต่อ token ให้แล้ว
flow_replay                                  // ✓/✗ ต่อ call — verify แล้ว
```

### C. คง login ข้ามครั้ง

```jsonc
session_save { "name": "myapp" }             // ครั้งแรก หลัง login
// ครั้งต่อไป:
browser_launch { "mode": "fresh" }
session_restore { "name": "myapp" }          // กลับมาล็อกอินอยู่ ไม่ต้อง login ใหม่
```

### D. ขับเกม canvas / WebGL

```jsonc
browser_launch { "mode": "fresh", "incognito": true, "url": "https://game.example",
                 "viewport": { "width": 390, "height": 844 } }  // แนวตั้ง
page_click_at { "x": 195, "y": 700 }         // กดปุ่มที่วาดบน canvas
net_ws                                        // อ่านเฟรม WebSocket ของเกม
net_pending                                   // จับ asset-load ที่ค้าง
```

### E. ทดสอบบน network แย่ๆ / mock endpoint

```jsonc
net_throttle { "preset": "slow-3g", "cpuRate": 4 }   // ลดความเร็ว + หน่วง CPU
net_intercept_add { "urlIncludes": "/api/config", "action": "mock",
                    "status": 200, "body": "{\"feature_x\":true}" }
browser_hard_reload
net_slow                                              // ดูอะไรอืดใต้ 3G
net_throttle { "preset": "none" }                    // รีเซ็ตเต็มสปีด
```

### F. อัปโหลดไฟล์ผ่านฟอร์ม

```jsonc
page_snapshot
page_upload { "selector": "input[type=file]", "files": ["/abs/path/resume.pdf"] }
page_click { "selector": "#submit" }
net_get { "url": "/upload" }                  // ยืนยัน request multipart
```

### G. เห็นแล้วคลิก (vision mode)

```jsonc
page_look                                    // screenshot ที่มีเลข 1,2,3… บนทุก element ที่กดได้ + legend
// legend: [e7] button "ชำระเงิน" — ดูภาพ เลือกเลข แล้วคลิก ref นั้น:
page_click { "ref": "e7" }

page_look { "text": "สมัคร" }                // ใส่เลขเฉพาะ element ที่ข้อความตรง
page_screenshot                              // ภาพ 1:1 — จุด (x,y) ที่อ่านจากภาพคือพิกัดคลิกได้เลย
page_click_at { "x": 640, "y": 412 }
```

### H. ทั้ง flow ในรอบเดียว (`page_batch`)

```jsonc
page_batch { "steps": [
  { "action": "fill",     "selector": "#user", "value": "alice" },
  { "action": "fill",     "selector": "#pass", "value": "s3cret" },
  { "action": "click",    "text": "Login" },                 // ระบุเป้าด้วยข้อความที่เห็น
  { "action": "wait_for", "url": "/dashboard", "timeoutMs": 8000 }
], "look": true }
// → delta รวมทั้ง network/console/url + screenshot ติดเลขของหน้า dashboard
//   เลือก page_click {ref} ถัดไปได้จากคำตอบเดียวกัน หยุดที่ step แรกที่ล้ม
```

### I. เกมมือถือ / PG (viewport นิ่ง + auto-follow tab)

```jsonc
browser_launch { "mode": "fresh", "device": "mobile", "url": "https://game.example/lobby" }
// viewport มือถือ 390x844 ที่ไม่หดเอง; session นี้เป็น active แล้ว
page_look                       // screenshot ติดเลข ตรง 1:1 กับพิกัด page_click_at
page_click { "selector": ".play" }   // เปิดเกมใน tab ใหม่ → bfa auto-follow ให้เอง
page_state                      // ยืนยันว่าอยู่ tab เกมแล้ว
// ถ้า tab เกมปิดไป tool ตัวถัดไป self-heal ไป tab ที่ยังเปิดอยู่แทนที่จะ error
net_list { "since": "nav" }     // เฉพาะ request ของหน้านี้ ซ่อน polling ของ lobby เดิม
```

---

## เกม Canvas / WebGL

Puppeteer ตั้ง viewport เริ่มต้น **800×600 แนวนอน** เกมแนวตั้งจะถูก letterbox และ
overlay รับ input เต็มจอจะกลืนคลิกพิกัด ให้ launch (หรือ resize) เป็น **viewport แนวตั้ง**
ให้ canvas เต็มจอ:

```jsonc
browser_launch { "mode": "fresh", "incognito": true, "url": "…",
                 "viewport": { "width": 390, "height": 844 } }
page_set_viewport { "width": 390, "height": 844 }   // บน session ที่เปิดอยู่
```

คง `hasTouch:false` (ค่าเริ่มต้น) เพื่อให้ `page_click_at` (คลิก **เมาส์** จริง) ขับเกมที่
ฟังเมาส์ ส่วนเกมที่ฟัง **touch** อย่างเดียว ให้ตั้ง viewport `hasTouch:true` แล้วใช้
`page_tap_at { x, y }`

---

## เลือกโหมดไหนดี?

- **`fresh`** (ค่าเริ่มต้น) — Chrome ชั่วคราว ไม่ต้อง setup ใช้แกะ flow เว็บสาธารณะ หรือเว็บที่
  **ไม่ต้อง**ใช้ login เดิมของคุณ
- **`attach`** — เชื่อมกับ Chrome ที่คุณเปิดด้วย debug port ใช้เมื่อต้องการ **login/cookie จริง**
  หรือ browser ที่**ดูเหมือนคนจริง**: `navigator.webdriver` เป็น `false`, profile/fingerprint จริง
  จึงผ่าน bot-check พื้นฐานที่ Chrome แบบ puppeteer-launch ไม่ผ่าน (วิธี setup ด้านล่าง)

## Attach เข้า Chrome ที่ล็อกอินอยู่จริง

Chrome ที่เปิดปกติ**ไม่มี** debug port และ **Chrome 136+ ปฏิเสธ debug port บน profile *หลัก***
(มาตรการกันมัลแวร์ขโมย cookie) — attach จึงต้องใช้ profile **แยก** เสมอ:

```bash
# profile เฉพาะ (แนะนำ) — หน้าต่างเด้งมา ล็อกอินในนั้นครั้งเดียว จำไว้เลย
./bfa-chrome 9222

# …หรือใช้ login เดิม ด้วยการ COPY profile ไป dir ใหม่ (ไม่ใช่ default)
cp -R "$HOME/Library/Application Support/Google/Chrome" "$HOME/.bfa/real-copy"
./bfa-chrome 9222 "$HOME/.bfa/real-copy"
```

แล้ว: `browser_launch { "mode": "attach", "port": 9222 }` (ถ้า port ยังไม่ขึ้น error ของ tool จะ
บอกสูตรนี้ให้เอง)

> ⚠️ **profile จริงที่ copy มา = มอบทุก session ที่ล็อกอินอยู่ให้ agent** — อีเมล, cloud console,
> ธนาคาร, source control มันอ่าน/ทำแทนคุณได้ แนะนำ profile เฉพาะ ใช้ copy ของ profile จริงเฉพาะ
> ตอนจำเป็นและรับความเสี่ยงได้
>
> **อย่า**ชี้ `bfa-chrome` ไป default profile ที่ใช้อยู่: บน Chrome 136+ debug port จะไม่เปิดเงียบๆ
> และชนกับ Chrome ที่รันอยู่ (หนึ่ง process ต่อหนึ่ง profile dir)

---

## Roadmap

ช่องว่างที่รู้อยู่ เรียงตามความสำคัญคร่าวๆ:

- **iframe-aware refs** — ตอนนี้ `page_snapshot` / การโต้ตอบ resolve เฉพาะ top
  document การรองรับ ref ข้าม frame คือ correctness item ถัดไป
- **Device emulation presets** — รวม UA + viewport + touch + geolocation +
  permission ในคำสั่งเดียว
- **PDF export** — `Page.printToPDF` สำหรับหน้าแบบรายงาน/ใบแจ้งหนี้
- **Emit Playwright/Puppeteer test** — target ใหม่ของ `flow_synthesize` ที่ออกมาเป็น
  test script รันได้ ไม่ใช่แค่โค้ดรีเพลย์
- **Natural-language element targeting** — เลเยอร์เสริมด้วย LLM ทับ ref model เดิม
- **Performance tracing** — wrapper บางๆ ของ `Tracing.start/stop`

นอก scope โดยตั้งใจ: browser บน cloud, stealth/anti-bot, residential proxy — bfa ยังคง
เป็นเครื่องมือ inspection ที่รันในเครื่อง

---

## หมายเหตุ & ข้อจำกัด

- agent เห็นทุกอย่างที่ browser ที่ launch/attach เห็น ให้ถือว่า Chrome profile จริงที่
  attach = เข้าถึงทุกบัญชีที่ล็อกอินอยู่
- **คง login ถาวร:** profile แบบ **ตั้งชื่อ** ใช้ OS keystore จริง cookie/login จึงอยู่ข้าม
  ครั้งได้ (default ของ puppeteer `--use-mock-keychain` / `--password-store=basic` ถอดรหัส
  cookie ที่เข้ารหัสด้วย keystore จริงไม่ได้ → Chrome ล้าง cookie ทั้งชุด = หลุด login เงียบๆ;
  bfa ตัด 2 flag นี้ให้ named profile ครั้งแรกอาจ prompt ขอ keychain) profile ชั่วคราวไม่คงค่า
  และคง mock store ไว้
- **Automation fingerprint:** Chrome แบบ `fresh` (เปิดด้วย puppeteer) มี
  `navigator.webdriver === true` + automation switch → bot-detection จับได้ ส่วน **`attach`**
  เป็น browser ธรรมดา (`navigator.webdriver === false`, profile/fingerprint จริง) — bfa **ไม่มี**
  fingerprint spoofing / anti-bot evasion โดยตั้งใจ ถ้าเว็บบล็อก automation และคุณมีสิทธิ์ใช้งาน
  ที่นั่น ให้ใช้ `attach` (browser จริง) ไม่ใช่ trick ปลอม fingerprint
- **ไม่ค้าง ไม่ต้อง force-quit** — `alert`/`confirm` ถูก dismiss แต่ `beforeunload` ถูก **accept**
  (= ออกจากหน้า) จึงไม่เคย veto การกด Cmd+W / Cmd+Q / reload ของคุณเอง; CDP call หมดเวลาที่ 30 วิ;
  `page_eval` มี budget และหยุด busy loop; `browser_recover` กู้หน้าที่สคริปต์ของเว็บวนเอง;
  `browser_close` / shutdown มีเพดานและ force-kill Chrome ที่เราเปิดถ้าไม่ยอมปิด (attach = แค่ disconnect)
  `net_throttle` CPU สูงสุด 20x และ throttle ที่ค้างอยู่โชว์ใน `page_state`; Fetch intercept ปิดเมื่อไม่มี rule
- **แรมมีเพดาน** — recorder เก็บ 3000 request / 200 socket × 500 frame / 2000 บรรทัด console ล่าสุด
  และให้ Chrome เก็บ response body ไม่เกิน 64 MB — attach ทั้งวันไม่บวมจนเบราว์เซอร์อืด
- `browser_clear_cache` ใน attach mode ล้างเฉพาะ origin ปัจจุบัน (profile จริงของคุณ) ใส่ `scope:"all"`
  ถ้าจะล้าง cache+cookie ทั้ง profile
- `flow_replay` รีเพลย์เฉพาะ `http`/`https`, มี timeout ต่อ request, จำกัดรวม
  (60 วิ / 200 step), และไม่แตะ browser session สด
- header ถูกเก็บจาก **สายจริง** (CDP ExtraInfo) จึงได้ `Cookie` และ header ที่ network
  เติม ไม่ใช่แค่ที่ `requestWillBeSent` เห็นตอนแรก และ `net_get` แสดง **ทุกตัว** รวม
  custom signing header (`x-api-key`, `x-signature`, `agent`, …) ไม่ใช่แค่ชุดที่รู้จัก
- การตรวจ dependency และ redact secret เป็น heuristic — ตรวจโค้ดที่สร้างและ HAR ก่อน
  แชร์หรือรันกับ production ค่าที่ **คำนวณ** และ bfa ย้อนกลับไม่ได้ (เช่นลายเซ็นแบบ
  `MD5(secret + timestamp)`) จะคงเป็น literal — ถ้า `flow_replay` ไม่ผ่าน มักแปลว่ายังต้อง
  สร้าง header นั้นเองในโค้ด

## การพัฒนา

```bash
npm run typecheck
npm test          # unit + real-Chrome integration + in-memory MCP e2e
npm run build
```

## License

[MIT](LICENSE)
