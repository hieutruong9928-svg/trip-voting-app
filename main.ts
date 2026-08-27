// Vote chuyến đi — Deno Deploy app (Deno KV lưu vote chung)
const kv = await Deno.openKv();

const LOCS = ["Phan Thiết", "Vũng Tàu", "Hồ Tràm"];
const OTHER = "Khác";
const DATES = ["19/09", "26/09"];

type Vote = { name: string; loc: string[]; other: string; dates: string[]; at: string; feedback?: string };

// Bản đầy đủ (kèm ý kiến đóng góp) — CHỈ dùng cho trang admin
async function getFullState(): Promise<{ votes: Record<string, Vote> }> {
  const votes: Record<string, Vote> = Object.create(null);
  for await (const e of kv.list<Vote>({ prefix: ["vote"] })) {
    const v = e.value;
    Object.defineProperty(votes, v.name, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return { votes };
}

// Bản công khai — LOẠI BỎ feedback để ý kiến đóng góp không lộ ra ngoài
async function getState(): Promise<{ votes: Record<string, Omit<Vote, "feedback">> }> {
  const full = await getFullState();
  const votes: Record<string, Omit<Vote, "feedback">> = Object.create(null);
  for (const k of Object.keys(full.votes)) {
    const { feedback: _fb, ...pub } = full.votes[k];
    Object.defineProperty(votes, k, { value: pub, enumerable: true, writable: true, configurable: true });
  }
  return { votes };
}

function bad(msg: string, status = 400) {
  return Response.json({ error: msg }, { status });
}

// ===== Quản trị: đổi mật khẩu bằng env ADMIN_PASS, hoặc sửa trực tiếp dòng dưới =====
const ADMIN_PASS = Deno.env.get("ADMIN_PASS") ?? "doi-mat-khau-nay";

function isAdmin(req: Request): boolean {
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)admin_pass=([^;]+)/);
  if (!m) return false;
  try { return decodeURIComponent(m[1]) === ADMIN_PASS; } catch { return false; }
}

function eh(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function htmlRes(html: string) {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const ADMIN_CSS = `<style>
:root{--bg:#F2F7FB;--card:#fff;--ink:#102A38;--muted:#5E7683;--line:#DCE8F0;--a:#06B6D4;--b:#2563EB;--soft:#E4F4FA;--err:#D4453A}
@media (prefers-color-scheme:dark){:root{--bg:#0B1720;--card:#12222E;--ink:#E7F1F6;--muted:#8CA4B2;--line:#20374A;--a:#22D3EE;--b:#60A5FA;--soft:#0E3140;--err:#F87171}}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:'Be Vietnam Pro',system-ui,sans-serif;line-height:1.5;padding:36px 16px}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:1.4rem;font-weight:800;margin-bottom:4px}
.sub{color:var(--muted);font-size:.9rem;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
tr:last-child td{border-bottom:0}
input[type=password]{width:100%;padding:11px 14px;border:1.5px solid var(--line);border-radius:11px;background:var(--bg);color:var(--ink);font:inherit;margin-bottom:12px}
button{padding:10px 16px;border:0;border-radius:11px;background:linear-gradient(94deg,var(--a),var(--b));color:#fff;font:inherit;font-weight:700;cursor:pointer}
button.small{padding:5px 12px;font-size:.8rem;font-weight:600}
button.danger{background:var(--err)}
.bar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.total{background:var(--soft);border-radius:999px;padding:5px 14px;font-weight:700;font-size:.9rem}
.err{color:var(--err);font-size:.9rem;margin-bottom:10px}
a{color:var(--b)}
.tblwrap{overflow-x:auto}
</style>`;

function loginPage(err: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quản trị vote</title>${ADMIN_CSS}</head><body><div class="wrap" style="max-width:380px">
<div class="card"><h1>🔐 Quản trị vote</h1><p class="sub">Nhập mật khẩu quản trị để xem và quản lý phiếu.</p>
${err ? `<p class="err">${eh(err)}</p>` : ""}
<form method="post" action="/admin/login"><input type="password" name="password" placeholder="Mật khẩu" autofocus><button style="width:100%">Đăng nhập</button></form>
</div></div></body></html>`;
}

function adminPage(state: { votes: Record<string, Vote> }): string {
  const names = Object.keys(state.votes);
  const rows = names
    .map((n) => state.votes[n])
    .sort((x, y) => (x.at < y.at ? 1 : -1))
    .map((v) => `<tr>
<td><b>${eh(v.name)}</b></td>
<td>${v.loc.map(eh).join(", ")}${v.other ? `<br><i style="color:var(--muted)">💬 ${eh(v.other)}</i>` : ""}</td>
<td>${v.dates.map(eh).join(", ")}</td>
<td style="max-width:220px">${v.feedback ? `<span style="color:var(--muted)">${eh(v.feedback)}</span>` : `<span style="color:var(--line)">—</span>`}</td>
<td style="white-space:nowrap;color:var(--muted)">${eh(new Date(v.at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }))}</td>
<td><form method="post" action="/admin/delete" onsubmit="return confirm('Xóa vote của ${eh(v.name).replace(/'/g, "\\'")}?')"><input type="hidden" name="name" value="${eh(v.name)}"><button class="small danger">Xóa</button></form></td>
</tr>`).join("");
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quản trị vote</title>${ADMIN_CSS}</head><body><div class="wrap">
<div class="bar"><div><h1>📊 Quản trị vote</h1><p class="sub" style="margin:0">Trang vote: <a href="/">mở trang chính</a> · <a href="/api/state">dữ liệu JSON</a> · <a href="/admin/logout">đăng xuất</a></p></div><span class="total">${names.length} người đã vote</span></div>
<div class="card"><div class="tblwrap"><table>
<tr><th>Tên</th><th>Địa điểm</th><th>Ngày đi</th><th>💭 Ý kiến đóng góp</th><th>Lúc</th><th></th></tr>
${rows || `<tr><td colspan="6" style="color:var(--muted)">Chưa có ai vote.</td></tr>`}
</table></div></div>
<div class="card"><form method="post" action="/admin/reset" onsubmit="return confirm('Xóa TOÀN BỘ ${names.length} phiếu? Không hoàn tác được.')"><button class="danger">🗑️ Reset toàn bộ phiếu</button></form>
<p class="sub" style="margin:10px 0 0">Xóa vote của ai thì người đó (và trình duyệt của họ) được vote lại. Reset toàn bộ = mở đợt vote mới.</p></div>
</div></body></html>`;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/api/state" && req.method === "GET") {
    return Response.json(await getState(), { headers: { "cache-control": "no-store" } });
  }

  if (url.pathname === "/api/vote" && req.method === "POST") {
    // Lớp chặn theo trình duyệt: cookie HttpOnly do server đặt sau khi vote,
    // xoá localStorage/cache thường KHÔNG xoá được cookie này.
    // Cookie lưu tên đã vote — nếu admin đã reset (tên không còn trong KV) thì cho vote lại.
    const cookies = req.headers.get("cookie") ?? "";
    const cm = cookies.match(/(?:^|;\s*)voted=([^;]+)/);
    if (cm) {
      let prev = "";
      try { prev = decodeURIComponent(cm[1]); } catch { prev = cm[1]; }
      if (prev && prev !== "1") {
        const existing = await kv.get(["vote", prev]);
        if (existing.value) {
          return bad("Trình duyệt này đã vote rồi — mỗi người chỉ vote một lần.", 403);
        }
      }
    }
    let b: unknown;
    try { b = await req.json(); } catch { return bad("JSON không hợp lệ"); }
    const o = b as Record<string, unknown>;
    const name = String(o.name ?? "").trim().slice(0, 40);
    if (!name) return bad("Thiếu tên");
    const allowedLoc = [...LOCS, OTHER];
    const loc = Array.isArray(o.loc) ? o.loc.map(String).filter((x) => allowedLoc.includes(x)) : [];
    const dates = Array.isArray(o.dates) ? o.dates.map(String).filter((x) => DATES.includes(x)) : [];
    const other = loc.includes(OTHER) ? String(o.other ?? "").trim().slice(0, 200) : "";
    if (loc.length === 0) return bad("Chưa chọn địa điểm");
    if (dates.length === 0) return bad("Chưa chọn ngày đi");
    const feedback = String(o.feedback ?? "").trim().slice(0, 500);
    const vote: Vote = { name, loc, other, dates, at: new Date().toISOString(), ...(feedback ? { feedback } : {}) };
    // Mỗi tên chỉ vote 1 lần: ghi atomic, thất bại nếu tên đã tồn tại
    const res = await kv.atomic()
      .check({ key: ["vote", name], versionstamp: null })
      .set(["vote", name], vote)
      .commit();
    if (!res.ok) return bad("Tên này đã vote rồi — mỗi người chỉ vote một lần.", 409);
    return Response.json(await getState(), {
      headers: {
        "set-cookie": "voted=" + encodeURIComponent(name) + "; Max-Age=7776000; Path=/; HttpOnly; SameSite=Lax",
      },
    });
  }

  // Xoá toàn bộ vote — chỉ khi đặt env RESET_KEY và gửi đúng key
  if (url.pathname === "/api/reset" && req.method === "POST") {
    const key = Deno.env.get("RESET_KEY");
    if (!key || req.headers.get("x-reset-key") !== key) return bad("Không có quyền", 403);
    for await (const e of kv.list({ prefix: ["vote"] })) await kv.delete(e.key);
    return Response.json(await getState());
  }

  // ================= TRANG QUẢN TRỊ /admin =================
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    const authed = isAdmin(req);

    if (url.pathname === "/admin/login" && req.method === "POST") {
      const form = await req.formData();
      if (String(form.get("password") ?? "") === ADMIN_PASS) {
        return new Response(null, {
          status: 303,
          headers: {
            "location": "/admin",
            "set-cookie": "admin_pass=" + encodeURIComponent(ADMIN_PASS) + "; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax",
          },
        });
      }
      return htmlRes(loginPage("Sai mật khẩu, thử lại nhé."));
    }

    if (url.pathname === "/admin/logout") {
      return new Response(null, {
        status: 303,
        headers: { "location": "/admin", "set-cookie": "admin_pass=; Max-Age=0; Path=/" },
      });
    }

    if (!authed) return htmlRes(loginPage(""));

    if (url.pathname === "/admin/delete" && req.method === "POST") {
      const form = await req.formData();
      const name = String(form.get("name") ?? "");
      if (name) await kv.delete(["vote", name]);
      return new Response(null, { status: 303, headers: { "location": "/admin" } });
    }

    if (url.pathname === "/admin/reset" && req.method === "POST") {
      for await (const e of kv.list({ prefix: ["vote"] })) await kv.delete(e.key);
      return new Response(null, { status: 303, headers: { "location": "/admin" } });
    }

    return htmlRes(adminPage(await getFullState()));
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  return new Response("Not found", { status: 404 });
});

const HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vote chuyến đi</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗳️</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&family=Be+Vietnam+Pro:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#F2F7FB; --card:#FFFFFF; --ink:#102A38; --muted:#5E7683; --line:#DCE8F0;
  --grad-a:#06B6D4; --grad-b:#2563EB;
  --accent:#0E8DA5; --accent-ink:#0B6F82; --accent-soft:#E4F4FA;
  --chip:#EEF4F8; --track:#E3EDF3; --err:#D4453A; --ok:#189A62;
  --ring:rgba(6,182,212,.28);
  --shadow:0 1px 2px rgba(16,42,56,.05), 0 12px 32px -16px rgba(16,42,56,.18);
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0B1720; --card:#12222E; --ink:#E7F1F6; --muted:#8CA4B2; --line:#20374A;
    --grad-a:#22D3EE; --grad-b:#60A5FA;
    --accent:#2BB8CE; --accent-ink:#7FDDEB; --accent-soft:#0E3140;
    --chip:#1A2E3D; --track:#1A2E3D; --err:#F87171; --ok:#4ADE80;
    --ring:rgba(34,211,238,.3);
    --shadow:0 1px 2px rgba(0,0,0,.35), 0 12px 32px -16px rgba(0,0,0,.55);
  }
  :root:not([data-theme="light"]) .bgpick{display:none}
}
:root[data-theme="dark"]{
  --bg:#0B1720; --card:#12222E; --ink:#E7F1F6; --muted:#8CA4B2; --line:#20374A;
  --grad-a:#22D3EE; --grad-b:#60A5FA;
  --accent:#2BB8CE; --accent-ink:#7FDDEB; --accent-soft:#0E3140;
  --chip:#1A2E3D; --track:#1A2E3D; --err:#F87171; --ok:#4ADE80;
  --ring:rgba(34,211,238,.3);
  --shadow:0 1px 2px rgba(0,0,0,.35), 0 12px 32px -16px rgba(0,0,0,.55);
}
:root[data-theme="dark"] .bgpick{display:none}

*{box-sizing:border-box;margin:0;padding:0}
body{
  color:var(--ink);
  background:linear-gradient(180deg, color-mix(in oklab, var(--bg) 80%, #4FA8DF) 0, var(--bg) 340px) no-repeat, var(--bg);
  font-family:'Be Vietnam Pro',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  line-height:1.55;min-height:100vh;-webkit-font-smoothing:antialiased;
}
.wrap{max-width:660px;margin:0 auto;padding:44px 20px 76px;display:flex;flex-direction:column;gap:20px}
header h1{
  font-family:'Bricolage Grotesque','Be Vietnam Pro',sans-serif;font-weight:800;
  font-size:clamp(1rem,4.6vw,2rem);letter-spacing:-.02em;line-height:1.2;white-space:nowrap;
  background:linear-gradient(94deg,var(--grad-b) 10%,var(--grad-a) 90%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  padding-bottom:2px;
}
.hero-ico{
  width:62px;height:62px;border-radius:18px;
  background:linear-gradient(135deg,var(--grad-a),var(--grad-b));
  display:flex;align-items:center;justify-content:center;font-size:2rem;
  margin-bottom:14px;box-shadow:0 10px 24px -10px var(--ring);
  animation:float 3.4s ease-in-out infinite;
}
@keyframes float{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-7px) rotate(3deg)}}
header p{color:var(--muted);margin-top:8px;font-size:.95rem;max-width:52ch}

.banner{border:1px solid var(--line);background:var(--accent-soft);color:var(--accent-ink);border-radius:14px;padding:11px 15px;font-size:.9rem}
.banner.warn{background:var(--card);color:var(--muted)}

.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:24px;box-shadow:var(--shadow)}
.card h2{font-family:'Bricolage Grotesque','Be Vietnam Pro',sans-serif;font-size:1.1rem;font-weight:700;letter-spacing:-.01em;margin-bottom:16px}

.field{margin-bottom:18px}
.field label.lbl,.grouplbl,label.field,.q h3{
  display:block;font-size:.72rem;font-weight:700;text-transform:uppercase;
  letter-spacing:.1em;color:var(--muted);margin-bottom:9px;
}
.grouplbl small,.q h3 .hint{text-transform:none;letter-spacing:0;font-weight:400;font-size:.78rem;margin-left:4px}
.q{margin-top:20px}

input[type=text]{
  width:100%;padding:12px 15px;border:1.5px solid var(--line);border-radius:13px;
  background:var(--card);color:var(--ink);font:inherit;font-size:.95rem;
  transition:border-color .15s, box-shadow .15s;
}
input[type=text]::placeholder{color:var(--muted);opacity:.6}
input[type=text]:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--ring)}
textarea{
  width:100%;padding:12px 15px;border:1.5px solid var(--line);border-radius:13px;
  background:var(--card);color:var(--ink);font:inherit;font-size:.95rem;
  resize:vertical;min-height:72px;max-height:220px;overflow-wrap:anywhere;
  transition:border-color .15s, box-shadow .15s;
}
textarea::placeholder{color:var(--muted);opacity:.6}
textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--ring)}

.opts{display:flex;flex-direction:column;gap:9px}
label.opt{
  display:flex;align-items:center;gap:12px;padding:13px 16px;
  border:1.5px solid var(--line);border-radius:14px;cursor:pointer;
  font-size:.95rem;font-weight:500;background:var(--card);
  transition:border-color .15s, background .15s, transform .1s;
}
label.opt:hover{border-color:var(--accent)}
label.opt:active{transform:scale(.99)}
label.opt:has(input:checked){border-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink)}
label.opt input{
  appearance:none;-webkit-appearance:none;flex:none;width:22px;height:22px;
  border:2px solid color-mix(in oklab, var(--muted) 42%, var(--line));
  border-radius:8px;background:var(--card);cursor:pointer;
  display:grid;place-items:center;
  transition:border-color .15s, background .18s, box-shadow .18s;
}
label.opt input::after{
  content:'';width:13px;height:13px;
  background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4.5 13l4.6 4.6L19.5 7'/%3E%3C/svg%3E") center/contain no-repeat;
  transform:scale(0) rotate(-12deg);
  transition:transform .2s cubic-bezier(.2,1.5,.4,1);
}
label.opt:hover input{border-color:var(--accent)}
label.opt input:checked{
  border-color:transparent;
  background:linear-gradient(135deg,var(--grad-a),var(--grad-b));
  box-shadow:0 4px 12px -4px var(--ring);
}
label.opt input:checked::after{transform:scale(1) rotate(0deg)}
label.opt input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.other-box{margin-top:9px}
#otherBox{margin-top:9px}
.hidden{display:none}

button.primary,button#send{
  width:100%;margin-top:22px;padding:14px 16px;border:none;border-radius:14px;
  background:linear-gradient(94deg,var(--grad-a),var(--grad-b));
  color:#fff;font:inherit;font-size:1rem;font-weight:700;letter-spacing:.01em;cursor:pointer;
  box-shadow:0 8px 20px -10px var(--ring);
  transition:transform .12s, box-shadow .12s, filter .12s;
}
button.primary:hover:not(:disabled),button#send:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.06);box-shadow:0 12px 26px -10px var(--ring)}
button.primary:active:not(:disabled),button#send:active:not(:disabled){transform:translateY(0)}
button.primary:disabled,button#send:disabled{opacity:.5;cursor:default}
button.primary:focus-visible,button#send:focus-visible{outline:2px solid var(--ink);outline-offset:3px}

.msg{margin-top:12px;font-size:.88rem;min-height:1.2em}
.msg.err{color:var(--err)} .msg.ok{color:var(--ok)}

.total{
  display:inline-block;font-variant-numeric:tabular-nums;font-size:.82rem;font-weight:600;
  color:var(--accent-ink);background:var(--accent-soft);border-radius:999px;
  padding:4px 13px;margin-bottom:16px;
}
.row,.res{margin-bottom:18px}
.rowhead,.rowtop{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:7px}
.rowhead .name,.rowtop .name{font-weight:600;font-size:.95rem}
.rowhead .n,.rowtop .n{font-variant-numeric:tabular-nums;font-weight:700;color:var(--accent-ink);font-size:.9rem;white-space:nowrap}
.track{height:10px;border-radius:999px;background:var(--track);overflow:hidden}
.fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--grad-a),var(--grad-b));transition:width .45s cubic-bezier(.2,.7,.3,1)}
.who,.voters{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.chip,.voters span{
  background:var(--chip);color:var(--ink);border-radius:999px;padding:3px 11px;
  font-size:.78rem;font-weight:500;max-width:100%;overflow-wrap:anywhere;
}
.chip.more,.voters .more{cursor:pointer;background:transparent;border:1.5px dashed var(--accent);color:var(--accent-ink);font:inherit;font-size:.78rem;font-weight:600;padding:2px 11px;border-radius:999px;transition:background .15s}
.chip.more:hover,.voters .more:hover{background:var(--accent-soft)}
.sect{border-top:1px solid var(--line);margin-top:20px;padding-top:18px}
.sect:first-of-type{border-top:0;margin-top:0;padding-top:0}
.sep{border:none;border-top:1px solid var(--line);margin:20px 0}

.ideas{display:flex;flex-direction:column;gap:8px}
.idea,.ideas li{
  list-style:none;background:var(--chip);border:none;border-radius:14px;
  padding:11px 15px;font-size:.9rem;overflow-wrap:anywhere;
}
.idea b,.ideas li b{font-weight:700;color:var(--accent-ink)}
.ideas li i{color:var(--muted);font-style:normal}
.empty{color:var(--muted);font-size:.92rem}

.success{text-align:center;padding:18px 8px}
.success .tick{
  width:64px;height:64px;border-radius:50%;
  background:linear-gradient(135deg,var(--grad-a),var(--grad-b));color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:1.9rem;
  margin:0 auto 14px;box-shadow:0 10px 26px -10px var(--ring);
  animation:pop .45s cubic-bezier(.2,1.4,.4,1);
}
.success h3{font-family:'Bricolage Grotesque','Be Vietnam Pro',sans-serif;font-size:1.25rem;font-weight:800;letter-spacing:-.01em}
.success p{color:var(--muted);font-size:.92rem;margin-top:8px;overflow-wrap:anywhere;max-width:44ch;margin-left:auto;margin-right:auto}
@keyframes pop{0%{transform:scale(.4);opacity:0}100%{transform:scale(1);opacity:1}}

.bgpick{display:flex;align-items:center;gap:9px;margin-top:16px;flex-wrap:wrap}
.bgpick .lbl{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;font-weight:700;margin-right:2px}
.bgpick button{width:22px;height:22px;border-radius:50%;border:1px solid var(--line);cursor:pointer;padding:0;transition:transform .12s}
.bgpick button:hover{border-color:var(--accent);transform:scale(1.12)}
.bgpick button.on{outline:2px solid var(--accent);outline-offset:2px}
.bgpick button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}

@media (prefers-reduced-motion: reduce){
  .fill{transition:none}
  .success .tick{animation:none}
  .hero-ico{animation:none}
  button.primary,button#send,label.opt,.bgpick button{transition:none}
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="hero-ico">🏖️</div>
    <h1>Đi biển thôi — chọn điểm đến &amp; ngày đi</h1>
    <p>Nhập tên, chọn địa điểm và ngày đi rồi gửi vote — cả 3 mục đều bắt buộc. Mỗi người chỉ vote một lần.</p>
    <div class="bgpick" id="bgpick"><span class="lbl">Màu nền</span></div>
  </header>

  <div class="card" id="voteCard">
    <h2>🗳️ Vote của bạn</h2>
    <div class="field">
      <label class="lbl" for="voter">👤 Tên của bạn</label>
      <input type="text" id="voter" placeholder="VD: Max" autocomplete="name" maxlength="40">
    </div>
    <div class="field">
      <span class="grouplbl">📍 Địa điểm <small>— chọn được nhiều</small></span>
      <div class="opts" id="locOpts"></div>
      <div id="otherBox" class="hidden"><input type="text" id="otherText" maxlength="200" placeholder="Ý kiến khác của bạn (VD: Nha Trang, Đà Lạt...)"></div>
    </div>
    <div class="field">
      <span class="grouplbl">📅 Ngày đi <small>— chọn được cả hai</small></span>
      <div class="opts" id="dateOpts"></div>
    </div>
    <div class="field">
      <span class="grouplbl">💭 Ý kiến đóng góp <small>— không bắt buộc, chỉ admin đọc được</small></span>
      <textarea id="feedback" maxlength="500" rows="3" placeholder="Góp ý về chuyến đi: lịch trình, chi phí, xe cộ, ăn uống... (tối đa 500 ký tự)"></textarea>
    </div>
    <button class="primary" id="send">Gửi vote</button>
    <div class="msg" id="msg"></div>
  </div>

  <div class="card">
    <h2>📊 Kết quả</h2>
    <div id="results"><p class="empty">Đang tải...</p></div>
  </div>
</div>

<script>
var LOCS=['Phan Thiết','Vũng Tàu','Hồ Tràm'];
var OTHER='Khác';
var DATES=[{v:'19/09',label:'Thứ Bảy · 19/09'},{v:'26/09',label:'Thứ Bảy · 26/09'}];
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

var BGS=[
  {c:'#EAF4FC',t:'Xanh dương nhạt'},
  {c:'#DDEEFB',t:'Xanh dương'},
  {c:'#F3F9FE',t:'Xanh rất nhạt'},
  {c:'#E6F3F2',t:'Xanh ngọc'},
  {c:'#FFFFFF',t:'Trắng'}
];
function getBg(){try{return localStorage.getItem('trip-vote-bg')||''}catch(e){return ''}}
function setBg(c){try{localStorage.setItem('trip-vote-bg',c)}catch(e){}}
function lightActive(){
  var t=document.documentElement.getAttribute('data-theme');
  if(t==='dark')return false;
  if(t==='light')return true;
  try{return !window.matchMedia('(prefers-color-scheme: dark)').matches}catch(e){return true}
}
function applyBg(){
  var c=getBg();
  if(c&&lightActive()){document.documentElement.style.setProperty('--bg',c)}
  else{document.documentElement.style.removeProperty('--bg')}
}
function savedName(){try{return localStorage.getItem('trip-vote-name')||''}catch(e){return ''}}
function saveName(n){try{localStorage.setItem('trip-vote-name',n)}catch(e){}}

// ----- dựng form (1 lần) -----
(function(){
  var h='';
  LOCS.concat([OTHER]).forEach(function(l){
    h+='<label class="opt"><input type="checkbox" name="loc" value="'+esc(l)+'"><span>'+esc(l)+'</span></label>';
  });
  document.getElementById('locOpts').innerHTML=h;
  h='';
  DATES.forEach(function(d){
    h+='<label class="opt"><input type="checkbox" name="date" value="'+esc(d.v)+'"><span>'+esc(d.label)+'</span></label>';
  });
  document.getElementById('dateOpts').innerHTML=h;
  document.getElementById('voter').value='';

  var pick=document.getElementById('bgpick');
  var cur=(getBg()||BGS[0].c).toUpperCase();
  BGS.forEach(function(b){
    var btn=document.createElement('button');
    btn.type='button';btn.title=b.t;btn.setAttribute('aria-label',b.t);
    btn.style.background=b.c;btn.setAttribute('data-bg',b.c);
    if(cur===b.c.toUpperCase())btn.className='on';
    btn.addEventListener('click',function(){
      setBg(b.c);applyBg();
      var all=pick.querySelectorAll('button');
      for(var i=0;i<all.length;i++)all[i].classList.toggle('on',all[i]===btn);
    });
    pick.appendChild(btn);
  });

  var cb=document.querySelector('input[name=loc][value="'+OTHER+'"]');
  cb.addEventListener('change',function(){document.getElementById('otherBox').classList.toggle('hidden',!cb.checked)});
  document.getElementById('send').addEventListener('click',submit);
  applyBg();
  try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyBg)}catch(e){}
})();

// ----- kết quả -----
function tally(state){
  var t={loc:{},date:{},ideas:[],names:Object.keys(state.votes||{})};
  LOCS.concat([OTHER]).forEach(function(l){t.loc[l]=[]});
  DATES.forEach(function(d){t.date[d.v]=[]});
  t.names.forEach(function(n){
    var v=state.votes[n];
    (v.loc||[]).forEach(function(l){if(t.loc[l])t.loc[l].push(n)});
    (v.dates||[]).forEach(function(d){if(t.date[d])t.date[d].push(n)});
    if(v.other)t.ideas.push({name:n,text:v.other});
  });
  return t;
}
var expandedWho={};
var lastState=null;
function bar(label,who,total){
  var n=who.length;
  var pct=total?Math.round(n*100/total):0;
  var h='<div class="row"><div class="rowhead"><span class="name">'+esc(label)+'</span><span class="n">'+n+' phiếu</span></div>';
  h+='<div class="track"><div class="fill" style="width:'+pct+'%"></div></div>';
  if(n){
    var LIMIT=8, open=!!expandedWho[label];
    var list=open?who:who.slice(0,LIMIT);
    h+='<div class="who">'+list.map(function(w){return '<span class="chip">'+esc(w)+'</span>'}).join('');
    if(n>LIMIT)h+='<button type="button" class="chip more" data-k="'+esc(label)+'">'+(open?'Thu gọn':'+'+(n-LIMIT)+' người nữa')+'</button>';
    h+='</div>';
  }
  return h+'</div>';
}
function renderResults(state){
  lastState=state;
  var t=tally(state);
  var total=t.names.length;
  var h='';
  if(!total){h='<p class="empty">Chưa có ai vote — bạn mở hàng nhé!</p>'}
  else{
    h+='<div class="total">'+total+' người đã vote</div>';
    h+='<div class="sect"><span class="grouplbl">📍 Địa điểm</span>';
    LOCS.concat([OTHER]).forEach(function(l){h+=bar(l,t.loc[l],total)});
    h+='</div><div class="sect"><span class="grouplbl">📅 Ngày đi</span>';
    DATES.forEach(function(d){h+=bar(d.label,t.date[d.v],total)});
    h+='</div>';
    if(t.ideas.length){
      h+='<div class="sect"><span class="grouplbl">💬 Ý kiến khác</span><div class="ideas">';
      t.ideas.forEach(function(i){h+='<div class="idea"><b>'+esc(i.name)+':</b> '+esc(i.text)+'</div>'});
      h+='</div></div>';
    }
  }
  document.getElementById('results').innerHTML=h;
  [].forEach.call(document.querySelectorAll('#results .chip.more'),function(btn){btn.addEventListener('click',function(){var k=btn.getAttribute('data-k');expandedWho[k]=!expandedWho[k];renderResults(lastState);});});
  // Nếu admin đã xoá vote của mình khỏi server thì mở khoá lại form
  var d=doneInfo();
  if(d&&d.name&&!(state.votes&&state.votes[d.name])){
    try{localStorage.removeItem('trip-vote-done');localStorage.removeItem('trip-vote-name')}catch(e){}
    location.reload();
  }
}

// ----- màn hình đã vote thành công -----
function doneInfo(){try{return JSON.parse(localStorage.getItem('trip-vote-done')||'null')}catch(e){return null}}
function markDone(name){try{localStorage.setItem('trip-vote-done',JSON.stringify({name:name,at:new Date().toISOString()}))}catch(e){}}
function showSuccess(name){
  document.getElementById('voteCard').innerHTML=
    '<div class="success"><div class="tick">✓</div>'+
    '<h3>Bạn đã vote thành công!</h3>'+
    '<p>Cảm ơn <b>'+esc(name)+'</b> — vote của bạn đã được ghi nhận. Mỗi người chỉ vote một lần; kết quả bên dưới tự cập nhật cho tất cả mọi người.</p></div>';
}

function setMsg(text,cls){var m=document.getElementById('msg');m.textContent=text;m.className='msg '+(cls||'')}

function refresh(){
  return fetch('/api/state',{cache:'no-store'}).then(function(r){return r.json()}).then(renderResults)
    .catch(function(){ /* giữ kết quả cũ nếu mạng chập chờn */ });
}

function submit(){
  var name=document.getElementById('voter').value.trim();
  var loc=[].map.call(document.querySelectorAll('input[name=loc]:checked'),function(i){return i.value});
  var dates=[].map.call(document.querySelectorAll('input[name=date]:checked'),function(i){return i.value});
  var other=loc.indexOf(OTHER)>-1?document.getElementById('otherText').value.trim():'';
  var missing=[];
  if(!name)missing.push('nhập tên');
  if(loc.length===0)missing.push('chọn địa điểm');
  if(dates.length===0)missing.push('chọn ngày đi');
  if(missing.length){setMsg('Chưa vote được — bạn cần: '+missing.join(', ')+'.','err');return}
  var fb=document.getElementById('feedback').value.trim();
  var btn=document.getElementById('send');
  btn.disabled=true;btn.textContent='Đang lưu...';setMsg('','');
  saveName(name);
  fetch('/api/vote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name,loc:loc,other:other,dates:dates,feedback:fb})})
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
    .then(function(res){
      if(!res.ok){
        btn.disabled=false;btn.textContent='Gửi vote';
        setMsg(res.j&&res.j.error?res.j.error:'Không lưu được, bấm gửi lại nhé.','err');
        return;
      }
      markDone(name);
      showSuccess(name);
      renderResults(res.j);
    })
    .catch(function(){btn.disabled=false;btn.textContent='Gửi vote';setMsg('Không lưu được (lỗi mạng). Bấm gửi lại nhé.','err')});
}

var done=doneInfo();
if(done&&done.name)showSuccess(done.name);
refresh();
setInterval(refresh,10000);
</script>
</body>
</html>`;
