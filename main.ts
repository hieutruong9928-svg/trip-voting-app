// Vote chuyến đi — Deno Deploy app (Deno KV lưu vote chung)
const kv = await Deno.openKv();

const LOCS = ["Phan Thiết", "Vũng Tàu", "Hồ Tràm"];
const OTHER = "Khác";
const DATES = ["19/09", "26/09"];

type Vote = { name: string; loc: string[]; other: string; dates: string[]; at: string };

async function getState(): Promise<{ votes: Record<string, Vote> }> {
  const votes: Record<string, Vote> = Object.create(null);
  for await (const e of kv.list<Vote>({ prefix: ["vote"] })) {
    const v = e.value;
    Object.defineProperty(votes, v.name, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return { votes };
}

function bad(msg: string, status = 400) {
  return Response.json({ error: msg }, { status });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/api/state" && req.method === "GET") {
    return Response.json(await getState(), { headers: { "cache-control": "no-store" } });
  }

  if (url.pathname === "/api/vote" && req.method === "POST") {
    // Lớp chặn theo trình duyệt: cookie HttpOnly do server đặt sau khi vote,
    // xoá localStorage/cache thường KHÔNG xoá được cookie này
    const cookies = req.headers.get("cookie") ?? "";
    if (/(?:^|;\s*)voted=1(?:;|$)/.test(cookies)) {
      return bad("Trình duyệt này đã vote rồi — mỗi người chỉ vote một lần.", 403);
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
    const vote: Vote = { name, loc, other, dates, at: new Date().toISOString() };
    // Mỗi tên chỉ vote 1 lần: ghi atomic, thất bại nếu tên đã tồn tại
    const res = await kv.atomic()
      .check({ key: ["vote", name], versionstamp: null })
      .set(["vote", name], vote)
      .commit();
    if (!res.ok) return bad("Tên này đã vote rồi — mỗi người chỉ vote một lần.", 409);
    return Response.json(await getState(), {
      headers: {
        "set-cookie": "voted=1; Max-Age=7776000; Path=/; HttpOnly; SameSite=Lax",
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
<link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#EAF4FC; --card:#FFFFFF; --ink:#182A31; --muted:#5C7078; --line:#D9E7F2;
  --accent:#0E7C86; --accent-ink:#0A6570; --accent-soft:#E3F4F5;
  --chip:#F0F5F7; --track:#E8EEF1; --err:#C0392B; --ok:#1E8E5A;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0D1A1F; --card:#14252C; --ink:#E4EEF0; --muted:#8CA6AD; --line:#24404A;
    --accent:#3FB9C4; --accent-ink:#8ADDE5; --accent-soft:#123A41;
    --chip:#1B333B; --track:#1B333B; --err:#E0705F; --ok:#4CC08A;
  }
  :root:not([data-theme="light"]) .bgpick{display:none}
}
:root[data-theme="dark"]{
  --bg:#0D1A1F; --card:#14252C; --ink:#E4EEF0; --muted:#8CA6AD; --line:#24404A;
  --accent:#3FB9C4; --accent-ink:#8ADDE5; --accent-soft:#123A41;
  --chip:#1B333B; --track:#1B333B; --err:#E0705F; --ok:#4CC08A;
}
:root[data-theme="dark"] .bgpick{display:none}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:'Be Vietnam Pro',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.5;min-height:100vh;padding:32px 16px 64px}
.wrap{max-width:640px;margin:0 auto}
header h1{font-size:1.7rem;font-weight:800;letter-spacing:-.02em}
header p{color:var(--muted);margin-top:6px;font-size:.95rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;margin-top:20px}
h2{font-size:1.05rem;font-weight:700;margin-bottom:14px}
.field{margin-bottom:16px}
.field label.lbl,.grouplbl{display:block;font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:8px}
.grouplbl small{text-transform:none;letter-spacing:0;font-weight:400}
input[type=text]{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font:inherit;font-size:.95rem}
input[type=text]:focus{outline:2px solid var(--accent);outline-offset:0;border-color:transparent}
.opts{display:flex;flex-direction:column;gap:8px}
label.opt{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--line);border-radius:10px;cursor:pointer;font-size:.95rem}
label.opt:hover{border-color:var(--accent)}
label.opt:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
label.opt input{accent-color:var(--accent);width:17px;height:17px;flex:none}
.hidden{display:none}
#otherBox{margin-top:8px}
button.primary{width:100%;padding:13px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:inherit;font-weight:700;font-size:1rem;cursor:pointer;margin-top:4px}
button.primary:hover{filter:brightness(1.08)}
button.primary:disabled{opacity:.55;cursor:default}
.msg{margin-top:10px;font-size:.9rem;min-height:1.2em}
.msg.err{color:var(--err)}.msg.ok{color:var(--ok)}
.total{color:var(--muted);font-size:.9rem;margin-bottom:14px}
.row{margin-bottom:16px}
.rowhead{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.rowhead .name{font-weight:700}
.rowhead .n{font-weight:700;color:var(--accent-ink);font-size:.92rem;white-space:nowrap}
.track{height:8px;background:var(--track);border-radius:99px;margin-top:6px;overflow:hidden}
.fill{height:100%;background:var(--accent);border-radius:99px;transition:width .4s}
.who{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{background:var(--chip);border-radius:99px;padding:3px 10px;font-size:.8rem;max-width:100%;overflow-wrap:anywhere}
.sect{border-top:1px solid var(--line);margin-top:18px;padding-top:16px}
.sect:first-of-type{border-top:0;margin-top:0;padding-top:0}
.ideas{display:flex;flex-direction:column;gap:8px}
.idea{border:1px solid var(--line);border-radius:10px;padding:10px 13px;font-size:.9rem;overflow-wrap:anywhere}
.idea b{color:var(--accent-ink)}
.empty{color:var(--muted);font-size:.92rem}
.bgpick{display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap}
.bgpick .lbl{font-size:.76rem;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-weight:600;margin-right:2px}
.bgpick button{width:22px;height:22px;border-radius:50%;border:1px solid var(--line);cursor:pointer;padding:0}
.bgpick button:hover{border-color:var(--accent)}
.bgpick button.on{outline:2px solid var(--accent);outline-offset:2px}
.bgpick button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.success{text-align:center;padding:14px 6px}
.success .tick{width:56px;height:56px;border-radius:50%;background:var(--accent-soft);color:var(--ok);display:flex;align-items:center;justify-content:center;font-size:1.7rem;margin:0 auto 12px}
.success h3{font-size:1.15rem;font-weight:800}
.success p{color:var(--muted);font-size:.92rem;margin-top:6px;overflow-wrap:anywhere}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Đi biển thôi — chọn điểm đến &amp; ngày đi</h1>
    <p>Nhập tên, chọn địa điểm và ngày đi rồi gửi vote — cả 3 mục đều bắt buộc. Mỗi người chỉ vote một lần.</p>
    <div class="bgpick" id="bgpick"><span class="lbl">Màu nền</span></div>
  </header>

  <div class="card" id="voteCard">
    <h2>Vote của bạn</h2>
    <div class="field">
      <label class="lbl" for="voter">Tên của bạn</label>
      <input type="text" id="voter" placeholder="VD: Max" autocomplete="name" maxlength="40">
    </div>
    <div class="field">
      <span class="grouplbl">Địa điểm <small>— chọn được nhiều</small></span>
      <div class="opts" id="locOpts"></div>
      <div id="otherBox" class="hidden"><input type="text" id="otherText" maxlength="200" placeholder="Ý kiến khác của bạn (VD: Nha Trang, Đà Lạt...)"></div>
    </div>
    <div class="field">
      <span class="grouplbl">Ngày đi <small>— chọn được cả hai</small></span>
      <div class="opts" id="dateOpts"></div>
    </div>
    <button class="primary" id="send">Gửi vote</button>
    <div class="msg" id="msg"></div>
  </div>

  <div class="card">
    <h2>Kết quả</h2>
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
  document.getElementById('voter').value=savedName();

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
function bar(label,who,total){
  var n=who.length;
  var pct=total?Math.round(n*100/total):0;
  var h='<div class="row"><div class="rowhead"><span class="name">'+esc(label)+'</span><span class="n">'+n+' phiếu</span></div>';
  h+='<div class="track"><div class="fill" style="width:'+pct+'%"></div></div>';
  if(n)h+='<div class="who">'+who.map(function(w){return '<span class="chip">'+esc(w)+'</span>'}).join('')+'</div>';
  return h+'</div>';
}
function renderResults(state){
  var t=tally(state);
  var total=t.names.length;
  var h='';
  if(!total){h='<p class="empty">Chưa có ai vote — bạn mở hàng nhé!</p>'}
  else{
    h+='<div class="total">'+total+' người đã vote</div>';
    h+='<div class="sect"><span class="grouplbl">Địa điểm</span>';
    LOCS.concat([OTHER]).forEach(function(l){h+=bar(l,t.loc[l],total)});
    h+='</div><div class="sect"><span class="grouplbl">Ngày đi</span>';
    DATES.forEach(function(d){h+=bar(d.label,t.date[d.v],total)});
    h+='</div>';
    if(t.ideas.length){
      h+='<div class="sect"><span class="grouplbl">Ý kiến khác</span><div class="ideas">';
      t.ideas.forEach(function(i){h+='<div class="idea"><b>'+esc(i.name)+':</b> '+esc(i.text)+'</div>'});
      h+='</div></div>';
    }
  }
  document.getElementById('results').innerHTML=h;
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
  var btn=document.getElementById('send');
  btn.disabled=true;btn.textContent='Đang lưu...';setMsg('','');
  saveName(name);
  fetch('/api/vote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name,loc:loc,other:other,dates:dates})})
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
