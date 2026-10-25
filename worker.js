/**
 * VLGO Relay + Admin Web Panel
 * Deploy: Cloudflare Workers (free)
 * Login password: set PASS below (default from request)
 *
 * API (compatible with VLGO script ntfy-style):
 *   POST /:topic          body = raw text/json
 *   GET  /:topic/json?since=90s
 *
 * Admin:
 *   GET  /                login + dashboard
 *   POST /api/login       { password }
 *   GET  /api/players     list presence + hwid
 *   POST /api/ban         { name, hwid, kind, action }
 *   GET  /api/bans
 *   POST /api/cmd         { cmd, target, extra }  -> pushed to topic vlgo-cmd-web
 */

const PASS = "0956625960";
const STORE = new Map(); // topic -> [{t, message}]
const PLAYERS = new Map(); // nameLower -> { name, userId, hwid, last, placeId, jobId }
const BANS = { decode: {}, music: {}, full: {}, hwid: {} };
const SESSIONS = new Map(); // token -> exp

function push(topic, body) {
  const arr = STORE.get(topic) || [];
  arr.push({ t: Date.now(), message: String(body) });
  while (arr.length > 300) arr.shift();
  STORE.set(topic, arr);
}

function poll(topic, sinceMs) {
  const arr = STORE.get(topic) || [];
  const cut = Date.now() - (sinceMs || 90000);
  return arr.filter((x) => x.t >= cut);
}

function parseSince(s) {
  if (!s) return 90000;
  if (s.endsWith("s")) return parseInt(s) * 1000;
  if (s.endsWith("m")) return parseInt(s) * 60000;
  if (s.endsWith("h")) return parseInt(s) * 3600000;
  return parseInt(s) || 90000;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
  });
}

function html(body) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function token() {
  return crypto.randomUUID().replace(/-/g, "") + Date.now().toString(36);
}

function auth(req) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  const t = m ? m[1] : "";
  const exp = SESSIONS.get(t);
  if (exp && exp > Date.now()) return true;
  return false;
}

function ingestPresence(msg) {
  try {
    let data = msg;
    if (typeof msg === "string") {
      try {
        data = JSON.parse(msg);
      } catch {
        // plain name beacon
        if (/^[\w_]{3,20}$/.test(msg.trim())) {
          const name = msg.trim();
          const prev = PLAYERS.get(name.toLowerCase()) || {};
          PLAYERS.set(name.toLowerCase(), {
            ...prev,
            name,
            last: Date.now(),
          });
        }
        return;
      }
    }
    // signed cmd wrapper {p,t,s}
    if (data && data.p) {
      try {
        data = JSON.parse(data.p);
      } catch {}
    }
    if (data && data.cmd === "presence_ping" && data.extra) {
      const name = String(data.extra.name || "");
      if (name) {
        const prev = PLAYERS.get(name.toLowerCase()) || {};
        PLAYERS.set(name.toLowerCase(), {
          ...prev,
          name,
          last: Date.now(),
          hwid: data.extra.hwid || prev.hwid || "",
          userId: data.extra.userId || prev.userId || 0,
          placeId: data.extra.placeId || prev.placeId || "",
          jobId: data.extra.jobId || prev.jobId || "",
        });
      }
    }
    if (data && data.cmd === "hwid_reply" && data.extra) {
      const name = String(data.extra.name || "");
      const hwid = String(data.extra.hwid || "");
      if (name) {
        const prev = PLAYERS.get(name.toLowerCase()) || {};
        PLAYERS.set(name.toLowerCase(), {
          ...prev,
          name,
          hwid: hwid || prev.hwid,
          userId: data.extra.userId || prev.userId || 0,
          last: Date.now(),
        });
      }
    }
    // report bundle
    if (data && data.type === "vlgo_player") {
      const name = String(data.name || "");
      if (name) {
        PLAYERS.set(name.toLowerCase(), {
          name,
          userId: data.userId || 0,
          hwid: data.hwid || "",
          placeId: data.placeId || "",
          jobId: data.jobId || "",
          last: Date.now(),
        });
      }
    }
  } catch {}
}

const DASH = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VLGO Admin</title>
<style>
*{box-sizing:border-box;font-family:system-ui,sans-serif}
body{margin:0;background:#0b0b0b;color:#eee}
.wrap{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 12px}
.card{background:#161616;border:1px solid #333;border-radius:12px;padding:14px;margin-bottom:14px}
input,select,button,textarea{border-radius:8px;border:1px solid #444;background:#222;color:#fff;padding:8px 10px}
button{cursor:pointer;background:#fff;color:#000;border:none;font-weight:600}
button.danger{background:#c62828;color:#fff}
button.ok{background:#2e7d32;color:#fff}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px;border-bottom:1px solid #333;text-align:left;vertical-align:middle}
tr:hover{background:#1e1e1e}
.avatar{width:36px;height:36px;border-radius:8px;background:#000}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.muted{color:#999;font-size:12px}
.hidden{display:none}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:#333}
.badge.on{background:#1b5e20}
.badge.off{background:#444}
</style>
</head>
<body>
<div class="wrap">
  <div id="login" class="card">
    <h1>VLGO Admin Login</h1>
    <div class="row">
      <input id="pw" type="password" placeholder="รหัสผ่าน" style="min-width:220px"/>
      <button onclick="doLogin()">เข้าสู่ระบบ</button>
    </div>
    <p class="muted">แผงจัดการผู้เล่น / HWID / แบน</p>
  </div>

  <div id="app" class="hidden">
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <h1>VLGO จัดการผู้เล่น</h1>
      <div class="row">
        <button onclick="refresh()">รีเฟรช</button>
        <button onclick="logout()">ออก</button>
      </div>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <strong>ผู้เล่นออนไลน์ (รายงานจากสคริปต์)</strong>
        <span class="muted" id="stat"></span>
      </div>
      <table>
        <thead>
          <tr>
            <th></th><th>ชื่อ</th><th>UserId</th><th>HWID</th><th>ล่าสุด</th><th>จัดการ</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>

    <div class="card">
      <strong>แบนด้วยชื่อ / HWID</strong>
      <div class="row" style="margin-top:8px">
        <input id="banName" placeholder="ชื่อผู้เล่น"/>
        <input id="banHwid" placeholder="HWID (ถ้ามี)" style="min-width:240px"/>
        <select id="banKind">
          <option value="decode">แบนดึงไอดี</option>
          <option value="music">แบนเปิดเพลง</option>
          <option value="full">ระงับถาวร</option>
        </select>
        <button class="danger" onclick="ban(true)">แบน</button>
        <button class="ok" onclick="ban(false)">ปลดแบน</button>
      </div>
      <pre id="banList" class="muted" style="white-space:pre-wrap;margin-top:10px"></pre>
    </div>

    <div class="card">
      <strong>ส่งคำสั่ง / โค้ดไปยังคนรัน VLGO</strong>
      <div class="row" style="margin-top:8px">
        <input id="cmdTarget" placeholder="target ชื่อ หรือ all" value="all"/>
        <select id="cmdName">
          <option value="announce">announce</option>
          <option value="request_hwid">request_hwid</option>
          <option value="kill">kill</option>
          <option value="run_code">run_code</option>
        </select>
      </div>
      <textarea id="cmdExtra" rows="3" style="width:100%;margin-top:8px" placeholder='extra JSON เช่น {"message":"สวัสดี","kind":"yellow"} หรือ {"code":"print(1)"}'></textarea>
      <div class="row" style="margin-top:8px">
        <button onclick="sendCmd()">ส่งคำสั่ง</button>
      </div>
    </div>
  </div>
</div>
<script>
let TOKEN = localStorage.getItem("vlgo_tok") || "";
async function api(path, opt={}) {
  const headers = Object.assign({"content-type":"application/json"}, opt.headers||{});
  if (TOKEN) headers["authorization"] = "Bearer " + TOKEN;
  const r = await fetch(path, Object.assign({}, opt, { headers }));
  if (r.status === 401) { logout(); throw new Error("auth"); }
  return r.json();
}
function showApp(on) {
  document.getElementById("login").classList.toggle("hidden", on);
  document.getElementById("app").classList.toggle("hidden", !on);
}
async function doLogin() {
  const password = document.getElementById("pw").value;
  const r = await api("/api/login", { method:"POST", body: JSON.stringify({ password }) });
  if (!r.ok) return alert("รหัสผิด");
  TOKEN = r.token;
  localStorage.setItem("vlgo_tok", TOKEN);
  showApp(true);
  refresh();
}
function logout() {
  TOKEN = "";
  localStorage.removeItem("vlgo_tok");
  showApp(false);
}
function ago(ms) {
  if (!ms) return "-";
  const s = Math.floor((Date.now()-ms)/1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s/60) + "m";
  return Math.floor(s/3600) + "h";
}
async function refresh() {
  const data = await api("/api/players");
  const bans = await api("/api/bans");
  const tb = document.getElementById("tbody");
  tb.innerHTML = "";
  let on = 0;
  for (const p of data.players) {
    const online = (Date.now() - p.last) < 120000;
    if (online) on++;
    const av = p.userId ? ("https://www.roblox.com/headshot-thumbnail/image?userId=" + p.userId + "&width=48&height=48&format=png") : "";
    const tr = document.createElement("tr");
    tr.innerHTML = \`
      <td>\${av ? '<img class="avatar" src="'+av+'"/>' : ''}</td>
      <td><b>\${p.name||"-"}</b> <span class="badge \${online?"on":"off"}">\${online?"online":"off"}</span></td>
      <td>\${p.userId||"-"}</td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis" title="\${p.hwid||""}">\${p.hwid||"-"}</td>
      <td>\${ago(p.last)}</td>
      <td class="row">
        <button onclick="fillBan('\${p.name||""}','\${(p.hwid||"").replace(/'/g,"")}')">เลือก</button>
        <button onclick="reqHwid('\${p.name||""}')">ขอ HWID</button>
      </td>\`;
    tb.appendChild(tr);
  }
  document.getElementById("stat").textContent = "ออนไลน์ ~" + on + " / ทั้งหมด " + data.players.length;
  document.getElementById("banList").textContent = JSON.stringify(bans, null, 2);
}
function fillBan(name, hwid) {
  document.getElementById("banName").value = name || "";
  document.getElementById("banHwid").value = hwid || "";
}
async function ban(on) {
  const body = {
    name: document.getElementById("banName").value,
    hwid: document.getElementById("banHwid").value,
    kind: document.getElementById("banKind").value,
    action: on ? "ban" : "unban",
  };
  await api("/api/ban", { method:"POST", body: JSON.stringify(body) });
  refresh();
}
async function reqHwid(name) {
  await api("/api/cmd", { method:"POST", body: JSON.stringify({ cmd:"request_hwid", target:name, extra:{} }) });
  alert("ส่งขอ HWID แล้ว");
}
async function sendCmd() {
  let extra = {};
  try { extra = JSON.parse(document.getElementById("cmdExtra").value || "{}"); } catch { return alert("extra ต้องเป็น JSON"); }
  await api("/api/cmd", {
    method:"POST",
    body: JSON.stringify({
      cmd: document.getElementById("cmdName").value,
      target: document.getElementById("cmdTarget").value || "all",
      extra,
    }),
  });
  alert("ส่งแล้ว");
}
if (TOKEN) { showApp(true); refresh(); setInterval(refresh, 8000); }
else setInterval(() => { if (TOKEN) refresh(); }, 8000);
</script>
</body>
</html>`;

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
        },
      });
    }

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // ----- Admin API -----
    if (path === "/api/login" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (String(body.password || "") !== PASS) return json({ ok: false }, 403);
      const t = token();
      SESSIONS.set(t, Date.now() + 12 * 3600 * 1000);
      return json({ ok: true, token: t });
    }

    if (path === "/api/players") {
      if (!auth(req)) return json({ ok: false }, 401);
      const players = [...PLAYERS.values()].sort((a, b) => (b.last || 0) - (a.last || 0));
      return json({ players });
    }

    if (path === "/api/bans") {
      if (!auth(req)) return json({ ok: false }, 401);
      return json(BANS);
    }

    if (path === "/api/ban" && req.method === "POST") {
      if (!auth(req)) return json({ ok: false }, 401);
      const body = await req.json().catch(() => ({}));
      const kind = ["decode", "music", "full"].includes(body.kind) ? body.kind : "full";
      const name = String(body.name || "").toLowerCase();
      const hwid = String(body.hwid || "");
      const on = body.action !== "unban";
      if (name) {
        if (on) BANS[kind][name] = true;
        else delete BANS[kind][name];
      }
      if (hwid) {
        const e = BANS.hwid[hwid] || { name: body.name || "" };
        e.name = body.name || e.name || "";
        if (on) e[kind] = true;
        else delete e[kind];
        if (!e.decode && !e.music && !e.full) delete BANS.hwid[hwid];
        else BANS.hwid[hwid] = e;
      }
      // publish ban snapshot to topic for scripts
      push("vlgo-ban-web", JSON.stringify({ type: "bans", bans: BANS, t: Date.now() }));
      return json({ ok: true, bans: BANS });
    }

    if (path === "/api/cmd" && req.method === "POST") {
      if (!auth(req)) return json({ ok: false }, 401);
      const body = await req.json().catch(() => ({}));
      const payload = JSON.stringify({
        cmd: body.cmd || "announce",
        target: body.target || "all",
        extra: body.extra || {},
      });
      const wrapped = JSON.stringify({ p: payload, t: Math.floor(Date.now() / 1000), s: "web" });
      push("vlgo-cmd-web", wrapped);
      return json({ ok: true });
    }

    // ----- ntfy-compatible relay -----
    // POST /topic
    // GET /topic/json?since=90s
    const parts = path.replace(/^\/+/, "").split("/");
    if (parts[0] && parts[0] !== "api") {
      const topic = parts[0];
      if (req.method === "POST") {
        const body = await req.text();
        push(topic, body);
        ingestPresence(body);
        return new Response("ok", {
          status: 200,
          headers: { "access-control-allow-origin": "*" },
        });
      }
      if (parts[1] === "json") {
        const since = parseSince(url.searchParams.get("since") || "90s");
        const lines = poll(topic, since).map((x) =>
          JSON.stringify({ event: "message", message: x.message })
        );
        return new Response(lines.join("\n"), {
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
        });
      }
      return new Response("VLGO relay topic=" + topic, { status: 200 });
    }

    if (path === "/" || path === "") return html(DASH);
    return new Response("not found", { status: 404 });
  },
};
