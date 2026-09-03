// Vote chuyến đi — Deno Deploy app (Deno KV lưu vote chung)
// v8: thêm trang home (giới thiệu → địa điểm tham khảo → vote → kết quả),
//     địa điểm + giá tiền do admin quản lý trong /admin, dán URL tự lấy thông tin.
const kv = await Deno.openKv();

const LOCS = ["Phan Thiết", "Vũng Tàu", "Hồ Tràm"];
const OTHER = "Khác";
const DATES = ["19/09", "26/09"];

type Vote = { name: string; loc: string[]; other: string; dates: string[]; at: string; feedback?: string };

// Địa điểm tham khảo (admin quản lý). Lưu KV key ["place", id]
type Place = {
  id: string;
  name: string;
  price: string;   // "1.2–1.5 triệu/người (2N1Đ)"
  desc: string;
  image: string;   // URL ảnh
  url: string;     // link tham khảo
  note: string;    // ghi chú thêm (đã hỏi giá, còn phòng...)
  order: number;   // thứ tự hiển thị (nhỏ → trước)
  at: string;
};

// ===================== VOTE =====================
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

// ===================== PLACES =====================
async function getPlaces(): Promise<Place[]> {
  const out: Place[] = [];
  for await (const e of kv.list<Place>({ prefix: ["place"] })) out.push(e.value);
  out.sort((a, b) => (a.order - b.order) || (a.at < b.at ? -1 : 1));
  return out;
}

function cleanUrl(s: string): string {
  s = s.trim().slice(0, 500);
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.href;
  } catch { return ""; }
}

// Lấy tiêu đề / mô tả / ảnh / giá từ một link (OpenGraph, meta, JSON-LD, heuristic giá VND)
async function fetchPreview(raw: string): Promise<{ title: string; description: string; image: string; price: string; site: string }> {
  const href = cleanUrl(raw);
  if (!href) throw new Error("Link không hợp lệ (cần http/https)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  let html = "";
  try {
    const r = await fetch(href, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "vi,en;q=0.8",
      },
    });
    if (!r.ok) throw new Error("Trang trả về lỗi " + r.status);
    // Chỉ đọc tối đa ~600KB để tránh trang quá nặng
    const reader = r.body?.getReader();
    const dec = new TextDecoder();
    let got = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      got += value.byteLength;
      if (got > 600_000) { try { await reader.cancel(); } catch { /* ignore */ } break; }
    }
  } finally { clearTimeout(timer); }

  const metas: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\s+([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const key = (/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(attrs) ?? [])[1]?.toLowerCase();
    const content = (/content\s*=\s*["']([^"']*)["']/i.exec(attrs) ?? [])[1];
    if (key && content != null && !(key in metas)) metas[key] = decodeEntities(content.trim());
  }
  const titleTag = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) ?? [])[1]?.trim() ?? "");
  const title = metas["og:title"] || metas["twitter:title"] || titleTag;
  const description = metas["og:description"] || metas["twitter:description"] || metas["description"] || "";
  let image = metas["og:image"] || metas["og:image:url"] || metas["twitter:image"] || metas["twitter:image:src"] || "";
  if (image) { try { image = new URL(image, href).href; } catch { image = ""; } }
  const site = metas["og:site_name"] || new URL(href).hostname.replace(/^www\./, "");

  // Giá: meta product → JSON-LD → số tiền VND đầu tiên trong text
  let price = "";
  const amt = metas["product:price:amount"] || metas["og:price:amount"] || metas["price"];
  const cur = metas["product:price:currency"] || metas["og:price:currency"] || "";
  if (amt) price = fmtMoney(amt, cur);
  if (!price) {
    const ld = /"price"\s*:\s*"?([\d.,]+)"?/i.exec(html);
    const ldCur = /"priceCurrency"\s*:\s*"([A-Z]{3})"/i.exec(html);
    if (ld) price = fmtMoney(ld[1], ldCur?.[1] ?? "");
  }
  if (!price) {
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
    const m = /(\d{1,3}(?:[.,]\d{3}){1,3})\s*(?:₫|đ|vnđ|vnd)(?![\p{L}\d])/iu.exec(text) ?? /(\d+(?:[.,]\d+)?)\s*(?:triệu|tr)(?![\p{L}\d])/iu.exec(text);
    if (m) price = m[0].replace(/\s+/g, " ").trim();
  }
  return { title: title.slice(0, 120), description: description.slice(0, 400), image, price: price.slice(0, 60), site };
}

function fmtMoney(amount: string, currency: string): string {
  const n = Number(String(amount).replace(/[^\d.]/g, ""));
  if (!isFinite(n) || n <= 0) return "";
  if (!currency || currency.toUpperCase() === "VND") return n.toLocaleString("vi-VN") + " đ";
  return n.toLocaleString("vi-VN") + " " + currency.toUpperCase();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function bad(msg: string, status = 400) {
  return Response.json({ error: msg }, { status });
}

// ===== Quản trị: đổi mật khẩu bằng env ADMIN_PASS, hoặc sửa trực tiếp dòng dưới =====
const ADMIN_PASS = Deno.env.get("ADMIN_PASS") ?? "thanh@123";

function isAdmin(req: Request): boolean {
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)admin_pass=([^;]+)/);
  if (!m) return false;
  try { return decodeURIComponent(m[1]) === ADMIN_PASS; } catch { return false; }
}

function eh(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function htmlRes(html: string) {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirect(to: string, extra: Record<string, string> = {}) {
  return new Response(null, { status: 303, headers: { location: to, ...extra } });
}

// ===================== ADMIN UI =====================
const ADMIN_CSS = `<style>
:root{--bg:#F2F7FB;--card:#fff;--ink:#102A38;--muted:#5E7683;--line:#DCE8F0;--a:#06B6D4;--b:#2563EB;--soft:#E4F4FA;--err:#D4453A;--ok:#189A62}
@media (prefers-color-scheme:dark){:root{--bg:#0B1720;--card:#12222E;--ink:#E7F1F6;--muted:#8CA4B2;--line:#20374A;--a:#22D3EE;--b:#60A5FA;--soft:#0E3140;--err:#F87171;--ok:#4ADE80}}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:'Be Vietnam Pro',system-ui,sans-serif;line-height:1.5;padding:36px 16px}
.wrap{max-width:860px;margin:0 auto}
h1{font-size:1.4rem;font-weight:800;margin-bottom:4px}
h2{font-size:1.05rem;font-weight:700;margin-bottom:14px}
.sub{color:var(--muted);font-size:.9rem;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
tr:last-child td{border-bottom:0}
label.f{display:block;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:12px 0 6px}
input:not([type=hidden]):not([type=checkbox]),textarea{width:100%;padding:11px 14px;border:1.5px solid var(--line);border-radius:11px;background:var(--bg);color:var(--ink);font:inherit}
input:focus,textarea:focus{outline:none;border-color:var(--a);box-shadow:0 0 0 3px rgba(6,182,212,.25)}
textarea{min-height:70px;resize:vertical}
input[type=password]{margin-bottom:12px}
button{padding:10px 16px;border:0;white-space:nowrap;border-radius:11px;background:linear-gradient(94deg,var(--a),var(--b));color:#fff;font:inherit;font-weight:700;cursor:pointer}
button.small{padding:5px 14px;font-size:.8rem;font-weight:600;white-space:nowrap}
button.danger{background:var(--err)}
button.ghost{background:transparent;color:var(--b);border:1.5px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
.bar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.total{background:var(--soft);border-radius:999px;padding:5px 14px;font-weight:700;font-size:.9rem}
.err{color:var(--err);font-size:.9rem;margin-bottom:10px}
.ok{color:var(--ok)}
.hint{color:var(--muted);font-size:.82rem;margin-top:6px;min-height:1.2em}
a{color:var(--b)}
.tblwrap{overflow-x:auto}
.urlrow{display:flex;gap:8px}
.urlrow input{flex:1}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
@media(max-width:600px){.grid2{grid-template-columns:1fr}}
.thumb{width:64px;height:48px;object-fit:cover;border-radius:8px;background:var(--soft);display:block}
.imgprev{width:100%;max-height:180px;object-fit:cover;border-radius:11px;margin-top:8px;display:none;border:1px solid var(--line)}
.actions{display:flex;gap:8px;margin-top:16px;align-items:center;flex-wrap:wrap}
.nav{display:flex;gap:14px;font-size:.88rem;margin-bottom:18px;flex-wrap:wrap}
.tag{display:inline-block;background:var(--soft);border-radius:999px;padding:2px 10px;font-size:.78rem;font-weight:600}
.lnk{display:inline-block;padding:5px 14px;border:1.5px solid var(--line);border-radius:11px;font-size:.8rem;font-weight:600;text-decoration:none;margin-right:6px}
</style>`;

function loginPage(err: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quản trị vote</title>${ADMIN_CSS}</head><body><div class="wrap" style="max-width:380px">
<div class="card"><h1>🔐 Quản trị</h1><p class="sub">Nhập mật khẩu quản trị để quản lý phiếu và địa điểm.</p>
${err ? `<p class="err">${eh(err)}</p>` : ""}
<form method="post" action="/admin/login"><input type="password" name="password" placeholder="Mật khẩu" autofocus><button style="width:100%">Đăng nhập</button></form>
</div></div></body></html>`;
}

function adminPage(state: { votes: Record<string, Vote> }, places: Place[], editing: Place | null, flash: string): string {
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

  const placeRows = places.map((p) => `<tr>
<td>${p.image ? `<img class="thumb" src="${eh(p.image)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'thumb'}))">` : `<span class="thumb"></span>`}</td>
<td><b>${eh(p.name)}</b>${p.note ? `<br><span style="color:var(--muted);font-size:.82rem">📝 ${eh(p.note)}</span>` : ""}</td>
<td>${p.price ? `<span class="tag">${eh(p.price)}</span>` : `<span style="color:var(--line)">—</span>`}</td>
<td>${p.url ? `<a href="${eh(p.url)}" target="_blank" rel="noopener">link ↗</a>` : `<span style="color:var(--line)">—</span>`}</td>
<td style="color:var(--muted)">${p.order}</td>
<td style="white-space:nowrap"><a class="lnk" href="/admin?edit=${eh(p.id)}#places">Sửa</a>
<form method="post" action="/admin/places/delete" style="display:inline" onsubmit="return confirm('Xóa địa điểm ${eh(p.name).replace(/'/g, "\\'")}?')"><input type="hidden" name="id" value="${eh(p.id)}"><button class="small danger">Xóa</button></form></td>
</tr>`).join("");

  const e = editing;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quản trị vote</title>${ADMIN_CSS}</head><body><div class="wrap">
<div class="bar"><div><h1>📊 Quản trị</h1><p class="sub" style="margin:0"><a href="/">mở trang chính</a> · <a href="/api/state">JSON vote</a> · <a href="/api/places">JSON địa điểm</a> · <a href="/admin/logout">đăng xuất</a></p></div><span class="total">${names.length} người đã vote</span></div>
<div class="nav"><a href="#places">📍 Địa điểm tham khảo</a><a href="#votes">🗳️ Phiếu vote</a></div>
${flash ? `<div class="card" style="padding:12px 16px"><span class="ok">✅ ${eh(flash)}</span></div>` : ""}

<div class="card" id="places">
<h2>📍 ${e ? "Sửa địa điểm: " + eh(e.name) : "Thêm địa điểm tham khảo"}</h2>
<p class="sub">Dán link (Booking, Traveloka, Facebook, blog…) rồi bấm <b>Lấy thông tin</b> để điền sẵn tên, ảnh, mô tả, giá. Sau đó chỉnh lại cho đúng rồi <b>Lưu</b>.</p>
<form method="post" action="/admin/places" id="placeForm">
<input type="hidden" name="id" value="${e ? eh(e.id) : ""}">
<label class="f" for="pUrl">🔗 Link tham khảo</label>
<div class="urlrow"><input type="url" name="url" id="pUrl" placeholder="https://..." value="${e ? eh(e.url) : ""}"><button type="button" id="fetchBtn">Lấy thông tin</button></div>
<p class="hint" id="fetchMsg"></p>
<div class="grid2">
<div><label class="f" for="pName">Tên địa điểm *</label><input name="name" id="pName" required maxlength="80" placeholder="VD: Hồ Tràm — Resort ABC" value="${e ? eh(e.name) : ""}"></div>
<div><label class="f" for="pPrice">💰 Giá tiền</label><input name="price" id="pPrice" maxlength="60" placeholder="VD: 1.2–1.5 triệu/người (2N1Đ)" value="${e ? eh(e.price) : ""}"></div>
</div>
<label class="f" for="pDesc">Mô tả</label><textarea name="desc" id="pDesc" maxlength="400" placeholder="Có gì hay, đi bao xa, ăn gì…">${e ? eh(e.desc) : ""}</textarea>
<label class="f" for="pImage">🖼️ Ảnh (URL)</label><input name="image" id="pImage" maxlength="500" placeholder="https://.../anh.jpg" value="${e ? eh(e.image) : ""}">
<img id="imgPrev" class="imgprev" alt="" src="${e && e.image ? eh(e.image) : ""}" style="${e && e.image ? "display:block" : ""}">
<div class="grid2">
<div><label class="f" for="pNote">📝 Ghi chú</label><input name="note" id="pNote" maxlength="160" placeholder="VD: đã hỏi giá 3/9, còn phòng" value="${e ? eh(e.note) : ""}"></div>
<div><label class="f" for="pOrder">Thứ tự hiển thị</label><input type="number" name="order" id="pOrder" min="0" max="999" value="${e ? e.order : places.length + 1}"></div>
</div>
<div class="actions"><button>${e ? "💾 Lưu thay đổi" : "➕ Thêm địa điểm"}</button>${e ? `<a href="/admin#places"><button type="button" class="ghost">Hủy</button></a>` : ""}</div>
</form>
</div>

<div class="card"><h2>Danh sách địa điểm (${places.length})</h2><div class="tblwrap"><table>
<tr><th></th><th>Tên</th><th>Giá</th><th>Link</th><th>Thứ tự</th><th></th></tr>
${placeRows || `<tr><td colspan="6" style="color:var(--muted)">Chưa có địa điểm nào — thêm ở form trên.</td></tr>`}
</table></div></div>

<div class="card" id="votes"><h2>🗳️ Phiếu vote</h2><div class="tblwrap"><table>
<tr><th>Tên</th><th>Địa điểm</th><th>Ngày đi</th><th>💭 Ý kiến đóng góp</th><th>Lúc</th><th></th></tr>
${rows || `<tr><td colspan="6" style="color:var(--muted)">Chưa có ai vote.</td></tr>`}
</table></div></div>
<div class="card"><form method="post" action="/admin/reset" onsubmit="return confirm('Xóa TOÀN BỘ ${names.length} phiếu? Không hoàn tác được.')"><button class="danger">🗑️ Reset toàn bộ phiếu</button></form>
<p class="sub" style="margin:10px 0 0">Xóa vote của ai thì người đó (và trình duyệt của họ) được vote lại. Reset toàn bộ = mở đợt vote mới. Địa điểm tham khảo không bị xóa.</p></div>
</div>
<script>
(function(){
  var btn=document.getElementById('fetchBtn'),msg=document.getElementById('fetchMsg');
  var urlI=document.getElementById('pUrl'),img=document.getElementById('pImage'),prev=document.getElementById('imgPrev');
  function showPrev(){var s=img.value.trim();prev.src=s;prev.style.display=s?'block':'none'}
  img.addEventListener('input',showPrev);prev.addEventListener('error',function(){prev.style.display='none'});
  btn.addEventListener('click',function(){
    var u=urlI.value.trim();
    if(!u){msg.textContent='Dán link vào ô trước đã.';msg.className='hint err';return}
    btn.disabled=true;btn.textContent='Đang lấy…';msg.textContent='';msg.className='hint';
    fetch('/admin/preview?url='+encodeURIComponent(u)).then(function(r){return r.json()}).then(function(j){
      btn.disabled=false;btn.textContent='Lấy thông tin';
      if(j.error){msg.textContent='Không lấy được: '+j.error+' — bạn nhập tay nhé.';msg.className='hint err';return}
      var set=function(id,v){var el=document.getElementById(id);if(v&&!el.value.trim())el.value=v};
      set('pName',j.title);set('pDesc',j.description);set('pImage',j.image);set('pPrice',j.price);showPrev();
      var got=['title','description','image','price'].filter(function(k){return j[k]}).length;
      msg.textContent=got?'Đã điền '+got+' mục từ '+(j.site||'trang web')+'. Kiểm tra lại giá tiền rồi lưu.':'Trang không có thông tin để lấy — bạn nhập tay nhé.';
      msg.className='hint '+(got?'ok':'err');
    }).catch(function(){btn.disabled=false;btn.textContent='Lấy thông tin';msg.textContent='Lỗi mạng, thử lại.';msg.className='hint err'});
  });
})();
</script>
</body></html>`;
}

// ===================== SERVER =====================
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/api/state" && req.method === "GET") {
    return Response.json(await getState(), { headers: { "cache-control": "no-store" } });
  }

  if (url.pathname === "/api/places" && req.method === "GET") {
    return Response.json({ places: await getPlaces() }, { headers: { "cache-control": "no-store" } });
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
        return redirect("/admin", {
          "set-cookie": "admin_pass=" + encodeURIComponent(ADMIN_PASS) + "; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax",
        });
      }
      return htmlRes(loginPage("Sai mật khẩu, thử lại nhé."));
    }

    if (url.pathname === "/admin/logout") {
      return redirect("/admin", { "set-cookie": "admin_pass=; Max-Age=0; Path=/" });
    }

    if (!authed) {
      if (url.pathname.startsWith("/admin/preview")) return bad("Chưa đăng nhập", 401);
      return htmlRes(loginPage(""));
    }

    if (url.pathname === "/admin/delete" && req.method === "POST") {
      const form = await req.formData();
      const name = String(form.get("name") ?? "");
      if (name) await kv.delete(["vote", name]);
      return redirect("/admin#votes");
    }

    if (url.pathname === "/admin/reset" && req.method === "POST") {
      for await (const e of kv.list({ prefix: ["vote"] })) await kv.delete(e.key);
      return redirect("/admin#votes");
    }

    // --- Địa điểm: lấy thông tin từ link ---
    if (url.pathname === "/admin/preview" && req.method === "GET") {
      try {
        const p = await fetchPreview(url.searchParams.get("url") ?? "");
        return Response.json(p, { headers: { "cache-control": "no-store" } });
      } catch (err) {
        const m = err instanceof Error ? (err.name === "AbortError" ? "trang phản hồi quá chậm" : err.message) : "lỗi không rõ";
        return bad(m, 502);
      }
    }

    // --- Địa điểm: thêm / sửa ---
    if (url.pathname === "/admin/places" && req.method === "POST") {
      const form = await req.formData();
      const g = (k: string, max: number) => String(form.get(k) ?? "").trim().slice(0, max);
      const name = g("name", 80);
      if (!name) return redirect("/admin#places");
      let id = g("id", 20);
      let at = new Date().toISOString();
      if (id) {
        const old = await kv.get<Place>(["place", id]);
        if (old.value) at = old.value.at; else id = "";
      }
      if (!id) id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
      const orderN = parseInt(g("order", 4), 10);
      const place: Place = {
        id, name, at,
        price: g("price", 60),
        desc: g("desc", 400),
        image: cleanUrl(g("image", 500)),
        url: cleanUrl(g("url", 500)),
        note: g("note", 160),
        order: isFinite(orderN) ? Math.max(0, Math.min(999, orderN)) : 999,
      };
      await kv.set(["place", id], place);
      return redirect("/admin?ok=" + encodeURIComponent("Đã lưu địa điểm: " + name) + "#places");
    }

    if (url.pathname === "/admin/places/delete" && req.method === "POST") {
      const form = await req.formData();
      const id = String(form.get("id") ?? "");
      if (id) await kv.delete(["place", id]);
      return redirect("/admin?ok=" + encodeURIComponent("Đã xóa địa điểm") + "#places");
    }

    let editing: Place | null = null;
    const editId = url.searchParams.get("edit");
    if (editId) editing = (await kv.get<Place>(["place", editId])).value;
    return htmlRes(adminPage(await getFullState(), await getPlaces(), editing, url.searchParams.get("ok") ?? ""));
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  return new Response("Not found", { status: 404 });
});

// ===================== TRANG HOME =====================
const HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Đi biển thôi — chọn điểm đến & vote</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏖️</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#F2F7FB; --card:#FFFFFF; --ink:#102A38; --muted:#5E7683; --line:#DCE8F0;
  --grad-a:#06B6D4; --grad-b:#2563EB;
  --accent:#0E8DA5; --accent-ink:#0B6F82; --accent-soft:#E4F4FA;
  --chip:#EEF4F8; --track:#E3EDF3; --err:#D4453A; --ok:#189A62;
  --ring:rgba(6,182,212,.28);
  --shadow:0 1px 2px rgba(16,42,56,.05), 0 12px 32px -16px rgba(16,42,56,.18);
  --navbg:rgba(242,247,251,.85);
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0B1720; --card:#12222E; --ink:#E7F1F6; --muted:#8CA4B2; --line:#20374A;
    --grad-a:#22D3EE; --grad-b:#60A5FA;
    --accent:#2BB8CE; --accent-ink:#7FDDEB; --accent-soft:#0E3140;
    --chip:#1A2E3D; --track:#1A2E3D; --err:#F87171; --ok:#4ADE80;
    --ring:rgba(34,211,238,.3);
    --shadow:0 1px 2px rgba(0,0,0,.35), 0 12px 32px -16px rgba(0,0,0,.55);
    --navbg:rgba(11,23,32,.85);
  }
}
:root[data-theme="dark"]{
  --bg:#0B1720; --card:#12222E; --ink:#E7F1F6; --muted:#8CA4B2; --line:#20374A;
  --grad-a:#22D3EE; --grad-b:#60A5FA;
  --accent:#2BB8CE; --accent-ink:#7FDDEB; --accent-soft:#0E3140;
  --chip:#1A2E3D; --track:#1A2E3D; --err:#F87171; --ok:#4ADE80;
  --ring:rgba(34,211,238,.3);
  --shadow:0 1px 2px rgba(0,0,0,.35), 0 12px 32px -16px rgba(0,0,0,.55);
  --navbg:rgba(11,23,32,.85);
}

*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;scroll-padding-top:64px}
body{
  color:var(--ink);
  background:linear-gradient(180deg, color-mix(in oklab, var(--bg) 80%, #4FA8DF) 0, var(--bg) 340px) no-repeat, var(--bg);
  font-family:'Be Vietnam Pro',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  line-height:1.55;min-height:100vh;-webkit-font-smoothing:antialiased;
}
.wrap{max-width:760px;margin:0 auto;padding:28px 20px 76px;display:flex;flex-direction:column;gap:22px}

/* nav */
nav.top{
  position:sticky;top:0;z-index:10;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  background:var(--navbg);border-bottom:1px solid var(--line);
}
nav.top .in{max-width:760px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;gap:6px;overflow-x:auto}
nav.top .brand{font-weight:800;font-size:.95rem;margin-right:auto;white-space:nowrap;letter-spacing:-.01em}
nav.top a{color:var(--muted);text-decoration:none;font-size:.85rem;font-weight:600;padding:6px 11px;border-radius:999px;white-space:nowrap;transition:background .15s,color .15s}
nav.top a:hover{background:var(--accent-soft);color:var(--accent-ink)}
nav.top a.cta{background:linear-gradient(94deg,var(--grad-a),var(--grad-b));color:#fff}
@media(max-width:420px){nav.top .in{padding:9px 12px;gap:2px}nav.top .brand{font-size:.85rem}nav.top a{padding:6px 8px;font-size:.78rem}}

/* hero */
header.hero{padding-top:18px}
header h1{
  font-weight:800;font-size:clamp(1.5rem,5.5vw,2.3rem);letter-spacing:-.02em;line-height:1.15;
  background:linear-gradient(94deg,var(--grad-b) 10%,var(--grad-a) 90%);
  -webkit-background-clip:text;background-clip:text;color:transparent;padding-bottom:2px;
}
.hero-ico{
  width:62px;height:62px;border-radius:18px;
  background:linear-gradient(135deg,var(--grad-a),var(--grad-b));
  display:flex;align-items:center;justify-content:center;font-size:2rem;
  margin-bottom:14px;box-shadow:0 10px 24px -10px var(--ring);
  animation:float 3.4s ease-in-out infinite;
}
@keyframes float{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-7px) rotate(3deg)}}
header p{color:var(--muted);margin-top:10px;font-size:.98rem;max-width:56ch}
.steps{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
.step{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:7px 13px 7px 8px;font-size:.85rem;font-weight:500;box-shadow:var(--shadow)}
.step b{width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--grad-a),var(--grad-b));color:#fff;font-size:.75rem;display:grid;place-items:center;flex:none}
.hero-cta{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:11px 18px;border-radius:13px;font-weight:700;font-size:.93rem;text-decoration:none;cursor:pointer;border:1.5px solid var(--line);background:var(--card);color:var(--ink);font-family:inherit;transition:transform .12s,filter .12s,border-color .15s}
.btn:hover{transform:translateY(-1px);border-color:var(--accent)}
.btn.grad{background:linear-gradient(94deg,var(--grad-a),var(--grad-b));color:#fff;border-color:transparent;box-shadow:0 8px 20px -10px var(--ring)}

/* section title */
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px}
.sec-h h2{font-size:1.25rem;font-weight:800;letter-spacing:-.01em}
.sec-h .hint{color:var(--muted);font-size:.85rem}

/* places */
.places{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.place{
  background:var(--card);border:1px solid var(--line);border-radius:18px;overflow:hidden;
  box-shadow:var(--shadow);display:flex;flex-direction:column;transition:transform .15s,border-color .15s;
}
.place:hover{transform:translateY(-2px);border-color:var(--accent)}
.place .img{aspect-ratio:16/10;background:linear-gradient(135deg,var(--accent-soft),var(--chip));display:grid;place-items:center;font-size:2.2rem;overflow:hidden}
.place .img img{width:100%;height:100%;object-fit:cover;display:block}
.place .body{padding:14px 15px 15px;display:flex;flex-direction:column;gap:8px;flex:1}
.place h3{font-size:1.02rem;font-weight:700;letter-spacing:-.01em;line-height:1.3}
.place .price{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;background:var(--accent-soft);color:var(--accent-ink);border-radius:999px;padding:3px 11px;font-size:.8rem;font-weight:700;font-variant-numeric:tabular-nums}
.place .desc{color:var(--muted);font-size:.88rem;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.place .desc.open{display:block;-webkit-line-clamp:unset}
.place .more{background:none;border:0;color:var(--accent-ink);font:inherit;font-size:.8rem;font-weight:600;cursor:pointer;align-self:flex-start;padding:0}
.place .note{font-size:.8rem;color:var(--muted);background:var(--chip);border-radius:10px;padding:6px 10px}
.place .foot{display:flex;gap:8px;margin-top:auto;padding-top:6px}
.place .foot a,.place .foot button{flex:1;text-align:center;justify-content:center;padding:9px 8px;font-size:.84rem;border-radius:11px;white-space:nowrap}
.empty-places{background:var(--card);border:1.5px dashed var(--line);border-radius:18px;padding:26px;text-align:center;color:var(--muted);font-size:.92rem}
.empty-places a{color:var(--accent-ink)}

.banner{border:1px solid var(--line);background:var(--accent-soft);color:var(--accent-ink);border-radius:14px;padding:11px 15px;font-size:.9rem}
.banner.warn{background:var(--card);color:var(--muted)}

.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:24px;box-shadow:var(--shadow)}
.card h2{font-size:1.1rem;font-weight:700;letter-spacing:-.01em;margin-bottom:16px}

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
label.opt.flash{animation:flash .9s ease}
@keyframes flash{0%,100%{box-shadow:0 0 0 0 var(--ring)}40%{box-shadow:0 0 0 6px var(--ring)}}
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

.ideas{display:flex;flex-direction:column;gap:8px}
.idea{list-style:none;background:var(--chip);border:none;border-radius:14px;padding:11px 15px;font-size:.9rem;overflow-wrap:anywhere}
.idea b{font-weight:700;color:var(--accent-ink)}
.empty{color:var(--muted);font-size:.92rem}

.success{text-align:center;padding:18px 8px}
.success .tick{
  width:64px;height:64px;border-radius:50%;
  background:linear-gradient(135deg,var(--grad-a),var(--grad-b));color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:1.9rem;
  margin:0 auto 14px;box-shadow:0 10px 26px -10px var(--ring);
  animation:pop .45s cubic-bezier(.2,1.4,.4,1);
}
.success h3{font-size:1.25rem;font-weight:800;letter-spacing:-.01em}
.success p{color:var(--muted);font-size:.92rem;margin-top:8px;overflow-wrap:anywhere;max-width:44ch;margin-left:auto;margin-right:auto}
@keyframes pop{0%{transform:scale(.4);opacity:0}100%{transform:scale(1);opacity:1}}
footer{color:var(--muted);font-size:.8rem;text-align:center;padding-top:8px}
footer a{color:var(--muted)}

@media (prefers-reduced-motion: reduce){
  html{scroll-behavior:auto}
  .fill{transition:none}
  .success .tick{animation:none}
  .hero-ico{animation:none}
  label.opt.flash{animation:none}
  button.primary,button#send,label.opt,.place,.btn{transition:none}
}
</style>
</head>
<body>
<nav class="top"><div class="in">
  <span class="brand">🏖️ Đi biển thôi</span>
  <a href="#places">Địa điểm</a>
  <a href="#results">Kết quả</a>
  <a href="#vote" class="cta">Vote ngay</a>
</div></nav>

<div class="wrap">
  <header class="hero" id="home">
    <div class="hero-ico">🏖️</div>
    <h1>Đi biển thôi —<br>chọn điểm đến &amp; ngày đi</h1>
    <p>Xem trước các địa điểm và giá tham khảo bên dưới, rồi vote nơi bạn muốn đi và ngày rảnh. Mỗi người chỉ vote một lần, kết quả hiện chung cho cả nhóm.</p>
    <div class="steps">
      <span class="step"><b>1</b> Tham khảo địa điểm</span>
      <span class="step"><b>2</b> Chọn nơi &amp; ngày</span>
      <span class="step"><b>3</b> Gửi vote</span>
    </div>
    <div class="hero-cta">
      <a class="btn grad" href="#vote">🗳️ Vote ngay</a>
      <a class="btn" href="#places">Xem địa điểm ↓</a>
    </div>
  </header>

  <section id="places">
    <div class="sec-h"><h2>📍 Tham khảo địa điểm</h2><span class="hint" id="placesHint"></span></div>
    <div class="places" id="placeList"><div class="empty-places">Đang tải địa điểm…</div></div>
  </section>

  <section id="vote">
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
  </section>

  <section id="results">
  <div class="card">
    <h2>📊 Kết quả</h2>
    <div id="resultsBox"><p class="empty">Đang tải...</p></div>
  </div>
  </section>

  <footer>Kết quả tự cập nhật mỗi 30 giây · <a href="/admin">quản trị</a></footer>
</div>

<script>
var LOCS=['Phan Thiết','Vũng Tàu','Hồ Tràm'];
var OTHER='Khác';
var DATES=[{v:'19/09',label:'Thứ Bảy · 19/09'},{v:'26/09',label:'Thứ Bảy · 26/09'}];
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

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

  var cb=document.querySelector('input[name=loc][value="'+OTHER+'"]');
  cb.addEventListener('change',function(){document.getElementById('otherBox').classList.toggle('hidden',!cb.checked)});
  document.getElementById('send').addEventListener('click',submit);
})();

// ----- địa điểm tham khảo -----
var placesOpen={};
var lastPlaces=[];
function norm(s){return String(s||'').toLowerCase().normalize('NFC')}
function matchLoc(name){
  var n=norm(name);
  for(var i=0;i<LOCS.length;i++){if(n.indexOf(norm(LOCS[i]))>-1)return LOCS[i]}
  return null;
}
function renderPlaces(list){
  lastPlaces=list;
  var box=document.getElementById('placeList');
  document.getElementById('placesHint').textContent=list.length?list.length+' địa điểm':'';
  if(!list.length){
    box.innerHTML='<div class="empty-places">Chưa có địa điểm tham khảo nào. Admin thêm trong <a href="/admin">trang quản trị</a> — hoặc vote thẳng bên dưới nhé!</div>';
    return;
  }
  var h='';
  list.forEach(function(p){
    var open=!!placesOpen[p.id];
    var loc=matchLoc(p.name);
    h+='<article class="place">';
    h+='<div class="img">'+(p.image?'<img src="'+esc(p.image)+'" alt="'+esc(p.name)+'" loading="lazy" onerror="this.parentNode.textContent=\\'🏝️\\'">':'🏝️')+'</div>';
    h+='<div class="body"><h3>'+esc(p.name)+'</h3>';
    if(p.price)h+='<span class="price">💰 '+esc(p.price)+'</span>';
    if(p.desc){
      h+='<p class="desc'+(open?' open':'')+'">'+esc(p.desc)+'</p>';
      if(p.desc.length>110)h+='<button type="button" class="more" data-id="'+esc(p.id)+'">'+(open?'Thu gọn':'Xem thêm')+'</button>';
    }
    if(p.note)h+='<div class="note">📝 '+esc(p.note)+'</div>';
    h+='<div class="foot">';
    if(p.url)h+='<a class="btn" href="'+esc(p.url)+'" target="_blank" rel="noopener">Chi tiết ↗</a>';
    h+='<button type="button" class="btn grad pick" data-loc="'+esc(loc||'')+'" data-name="'+esc(p.name)+'">Vote nơi này</button>';
    h+='</div></div></article>';
  });
  box.innerHTML=h;
  [].forEach.call(box.querySelectorAll('.more'),function(b){b.addEventListener('click',function(){var id=b.getAttribute('data-id');placesOpen[id]=!placesOpen[id];renderPlaces(lastPlaces)})});
  [].forEach.call(box.querySelectorAll('.pick'),function(b){b.addEventListener('click',function(){pickPlace(b.getAttribute('data-loc'),b.getAttribute('data-name'))})});
}
function pickPlace(loc,name){
  var vote=document.getElementById('vote');
  var input=null;
  if(loc){input=document.querySelector('input[name=loc][value="'+loc+'"]')}
  if(!input){
    // không khớp 3 lựa chọn sẵn → tích "Khác" và điền tên
    input=document.querySelector('input[name=loc][value="'+OTHER+'"]');
    var ot=document.getElementById('otherText');
    if(input&&ot&&!input.checked){ot.value=name}
    else if(ot&&ot.value.indexOf(name)<0){ot.value=(ot.value?ot.value+', ':'')+name}
  }
  if(input){
    if(!input.checked){input.checked=true;input.dispatchEvent(new Event('change'))}
    var lab=input.closest('label');if(lab){lab.classList.remove('flash');void lab.offsetWidth;lab.classList.add('flash')}
  }
  vote.scrollIntoView({behavior:'smooth',block:'start'});
  var v=document.getElementById('voter');if(v&&!v.value)setTimeout(function(){v.focus()},450);
}
var lastPlacesJson='';
function loadPlaces(){
  return fetch('/api/places',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
      var list=j.places||[], s=JSON.stringify(list);
      if(s===lastPlacesJson)return; // không đổi gì → không vẽ lại (tránh nháy)
      lastPlacesJson=s;renderPlaces(list);
    })
    .catch(function(){document.getElementById('placeList').innerHTML='<div class="empty-places">Không tải được địa điểm — kéo xuống vote nhé.</div>'});
}

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
  document.getElementById('resultsBox').innerHTML=h;
  [].forEach.call(document.querySelectorAll('#resultsBox .chip.more'),function(btn){btn.addEventListener('click',function(){var k=btn.getAttribute('data-k');expandedWho[k]=!expandedWho[k];renderResults(lastState);});});
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
loadPlaces();
refresh();
// Poll tiết kiệm: 30s/lần và chỉ khi tab đang mở trước mặt (tránh vượt hạn mức hosting)
setInterval(function(){if(!document.hidden){refresh();loadPlaces()}},30000);
document.addEventListener('visibilitychange',function(){if(!document.hidden){refresh();loadPlaces()}});
</script>
</body>
</html>`;
