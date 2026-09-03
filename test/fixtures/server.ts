import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { AddressInfo } from "node:net";

const PAGE = `<!doctype html><html><head><title>BFA Fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><h1 id="hello">hello bfa</h1>
<button id="openpop" onclick="window.open('/popup', '_blank')">open game</button>
<form id="login">
  <input name="user">
  <input name="pass" type="password">
  <select name="plan"><option value="free">free</option><option value="pro">pro</option></select>
  <button id="submit">Login</button>
</form>
<div id="result"></div>
<input type="file" id="fileup">
<div id="pad" style="width:220px;height:140px"></div>
<script>
  document.getElementById("pad").addEventListener("click", (e) => {
    document.getElementById("result").textContent = "pad:" + Math.round(e.offsetX) + "," + Math.round(e.offsetY);
  });
  console.log("bfa-fixture-log");
  console.error("bfa-fixture-error");
  try {
    throw new Error("bfa-fixture-thrown");
  } catch (err) {
    console.error("bfa-fixture-caught: " + err.message);
  }
  fetch("/api/ok").catch(() => {});
  fetch("/api/fail").catch(() => {});
  fetch("/api/hang").catch(() => {});
  fetch("/api/slow").catch(() => {});
  const ws = new WebSocket("ws://" + location.host + "/ws");
  ws.addEventListener("open", () => ws.send("ping"));

  document.getElementById("login").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    const user = form.user.value;
    const pass = form.pass.value;
    const plan = form.plan.value;
    fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, pass, plan }),
    })
      .then((r) => r.json())
      .then((j) => {
        document.getElementById("result").textContent = JSON.stringify(j);
        return fetch("/api/me", {
          headers: { authorization: "Bearer " + j.token },
        });
      })
      .then((r) => r.json())
      .then((me) => {
        document.getElementById("result").textContent += " " + JSON.stringify(me);
      });
  });
</script>
</body></html>`;

export interface Fixture {
  url: string;
  wsUrl: string;
  close: () => Promise<void>;
}

const WS_ACCEPT_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKeyFor(clientKey: string): string {
  return createHash("sha1").update(clientKey + WS_ACCEPT_MAGIC).digest("base64");
}

function encodeTextFrame(payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Decodes a single masked client WS frame. Only handles what our short test payloads need
 *  (one unfragmented frame, no continuation) — this is a test fixture, not a full RFC6455 impl. */
function decodeClientFrame(buf: Buffer): { opcode: number; payload: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (!masked) return { opcode, payload: buf.subarray(offset, offset + len) };
  if (buf.length < offset + 4) return null;
  const mask = buf.subarray(offset, offset + 4);
  offset += 4;
  const masked_ = buf.subarray(offset, offset + len);
  const payload = Buffer.alloc(masked_.length);
  for (let i = 0; i < masked_.length; i++) payload[i] = masked_[i]! ^ mask[i % 4]!;
  return { opcode, payload };
}

export async function startFixture(): Promise<Fixture> {
  // Tracks every raw TCP socket (plain HTTP incl. the deliberately-hung /api/hang request, and
  // upgraded WS connections) so close() can force them shut — otherwise a hung socket keeps the
  // node:http server (and the test process) alive forever.
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
      return;
    }
    if (url.startsWith("/popup")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><title>Game Popup</title></head><body><h1 id="game">GAME WINDOW</h1><script>fetch("/api/ok?frompopup").catch(()=>{});</script></body></html>`);
      return;
    }
    if (url === "/api/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === "/api/fail") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "fail" }));
      return;
    }
    if (url === "/api/hang") {
      // Deliberately never respond — the request must stay pending.
      return;
    }
    if (url.startsWith("/api/slow")) {
      const slowMs = Number(new URL(url, "http://x").searchParams.get("ms")) || 400;
      // Finishes, but only after a delay — a slow-but-finished request for net_slow.
      const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ slow: true }));
      }, slowMs);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    if (url === "/api/login" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        let user = "";
        try {
          user = (JSON.parse(body || "{}") as { user?: string }).user ?? "";
        } catch {
          // malformed body — fall through with an empty user
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, token: "T-" + user }));
      });
      return;
    }
    if (url === "/api/me" && req.method === "GET") {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ user: token.replace(/^T-/, "") }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key || Array.isArray(key)) {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`,
    );
    socket.on("data", (chunk: Buffer) => {
      const frame = decodeClientFrame(chunk);
      if (frame && frame.opcode === 0x1) socket.write(encodeTextFrame(frame.payload)); // echo text frames
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
