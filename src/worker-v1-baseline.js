// Temp Mail for turjaun.xyz - SINGLE FILE Worker, no dependencies
// Paste this entire file into Cloudflare Dashboard > Workers > temp-mail > Edit Code
// Bindings needed: D1 binding named DB -> temp-mail-db
// Vars: DOMAINS="turjaun.xyz", MAIL_TTL_HOURS="24"

function domains(env){ return (env.DOMAINS||"turjaun.xyz").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean) }
function rnd(len=10){ const c="abcdefghijklmnopqrstuvwxyz0123456789"; const a=new Uint8Array(len); crypto.getRandomValues(a); return Array.from(a).map(b=>c[b%c.length]).join("") }
function token(){ const a=new Uint8Array(32); crypto.getRandomValues(a); return Array.from(a).map(b=>b.toString(16).padStart(2,"0")).join("") }
function otp(text){ const m=(text||"").match(/\b(\d{4,8})\b/); return m?m[1]:null }
function json(data,status=200){ return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}}) }
function decodeQP(s){ return s.replace(/=\r?\n/g,"").replace(/=([0-9A-F]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))) }
function decodeB64(s){ try{ return atob(s.replace(/\s/g,"")) }catch{ return s } }
function parseRaw(raw){
  const split = raw.indexOf("\r\n\r\n"); const split2 = raw.indexOf("\n\n");
  let hi, bi; if(split>=0){hi=split;bi=split+4}else if(split2>=0){hi=split2;bi=split2+2}else{hi=0;bi=0}
  const headersRaw = raw.slice(0,hi); const bodyRaw = raw.slice(bi);
  const headers={}; let cur=""; for(const line of headersRaw.split(/\r?\n/)){ if(/^\s/.test(line)&&cur){headers[cur]+= " "+line.trim()} else { const idx=line.indexOf(":"); if(idx>0){cur=line.slice(0,idx).toLowerCase(); headers[cur]=line.slice(idx+1).trim()} } }
  const subject = headers["subject"]||"(no subject)";
  let text=bodyRaw, html="";
  const ct=(headers["content-type"]||"").toLowerCase(); const enc=(headers["content-transfer-encoding"]||"").toLowerCase();
  // Multipart - extract text/plain and text/html parts simply
  const bm = ct.match(/boundary="?([^";]+)"?/);
  if(bm){
    const parts = bodyRaw.split("--"+bm[1]);
    let t="",h="";
    for(const part of parts){
      const ps=part.indexOf("\r\n\r\n")>=0?part.indexOf("\r\n\r\n")+4:(part.indexOf("\n\n")>=0?part.indexOf("\n\n")+2:0);
      const ph=part.slice(0,ps); const pb=part.slice(ps);
      const pct=ph.toLowerCase(); const penc=(ph.match(/content-transfer-encoding:\s*(\S+)/i)||[])[1]||"";
      let decoded=pb; if(penc.toLowerCase().includes("base64")) decoded=decodeB64(pb); else if(penc.toLowerCase().includes("quoted")) decoded=decodeQP(pb);
      if(pct.includes("text/html")) h+=decoded; else if(pct.includes("text/plain")) t+=decoded;
    }
    text=t||text; html=h;
  } else {
    if(enc.includes("base64")) text=decodeB64(bodyRaw);
    else if(enc.includes("quoted-printable")) text=decodeQP(bodyRaw);
    if(ct.includes("text/html")){ html=text; text=text.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim(); }
  }
  return {subject, text:text.slice(0,50000), html:html.slice(0,50000), from: headers["from"]||""};
}

const UI=`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temp Mail - turjaun.xyz</title><style>body{font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px;background:#0f172a;color:#e2e8f0}input,button,select{padding:10px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#fff}button{background:#2563eb;cursor:pointer;border:none}.card{background:#1e293b;padding:16px;border-radius:12px;margin:12px 0}.mail{border-top:1px solid #334155;padding:12px 0;cursor:pointer}small{color:#94a3b8}</style></head><body><h1>📧 Temp Mail — turjaun.xyz</h1><div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap"><input id="name" placeholder="custom name (optional)" style="flex:1"><select id="domain"></select><button onclick="createAddr()">Create</button><button onclick="randomAddr()">Random</button></div><p>Address: <b id="addr">-</b></p><p><small>Token: <span id="token">-</span></small></p><button onclick="loadMails()">Refresh</button></div><div class="card"><h3>Inbox</h3><div id="inbox">Create inbox first</div></div><div class="card"><h3>Message</h3><pre id="view" style="white-space:pre-wrap;word-break:break-word">Click a mail</pre></div><script>let A='',T='';async function init(){let r=await fetch('/api/config');let j=await r.json();document.getElementById('domain').innerHTML=j.domains.map(d=>'<option>'+d+'</option>').join('')}async function createAddr(){let n=document.getElementById('name').value,d=document.getElementById('domain').value;let r=await fetch('/api/new_address',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n||undefined,domain:d})});let j=await r.json();if(j.error){alert(j.error);return}A=j.address;T=j.token;document.getElementById('addr').textContent=A;document.getElementById('token').textContent=T;localStorage.setItem('a',A);localStorage.setItem('t',T);loadMails()}async function randomAddr(){document.getElementById('name').value='';await createAddr()}async function loadMails(){if(!T)return;let r=await fetch('/api/mails?limit=20',{headers:{Authorization:'Bearer '+T}});let j=await r.json();let el=document.getElementById('inbox');if(!j.results?.length){el.innerHTML='No mails yet — send to '+A;return}el.innerHTML=j.results.map(m=>'<div class="mail" onclick="viewMail('+m.id+')"><b>'+esc(m.subject||'')+'</b><br><small>'+esc(m.sender||'')+' • '+new Date(m.created_at*1000).toLocaleString()+'</small></div>').join('')}async function viewMail(id){let r=await fetch('/api/mail/'+id);let j=await r.json();document.getElementById('view').textContent=j.subject+'\\nFrom: '+j.sender+'\\nOTP: '+(j.otp||'-')+'\\n\\n'+(j.text_body||'')}function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}init();let sa=localStorage.getItem('a'),st=localStorage.getItem('t');if(sa&&st){A=sa;T=st;document.getElementById('addr').textContent=sa;document.getElementById('token').textContent=st;loadMails()}setInterval(()=>{if(T)loadMails()},10000);</script></body></html>`;

export default {
  async fetch(request, env, ctx){
    const url=new URL(request.url); const path=url.pathname;
    if(request.method==="OPTIONS") return new Response(null,{headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,DELETE,OPTIONS","Access-Control-Allow-Headers":"Authorization,Content-Type"}});
    if(path==="/") return new Response(UI,{headers:{"Content-Type":"text/html;charset=utf-8"}});
    if(path==="/api/health") return json({ok:true,service:"temp-mail",domain:domains(env),time:new Date().toISOString()});
    if(path==="/api/config"||path==="/api/domains") return json({domains:domains(env),ttl_hours:parseInt(env.MAIL_TTL_HOURS||"24")});
    if(path==="/api/new_address"&&request.method==="POST"){
      let body={}; try{body=await request.json()}catch{}
      const ds=domains(env); const domain=(body.domain||ds[0]).toLowerCase(); if(!ds.includes(domain)) return json({error:"Invalid domain",allowed:ds},400);
      const name=(body.name||rnd(10)).toLowerCase().replace(/[^a-z0-9._-]/g,""); const address=name+"@"+domain; const tok=token(); const exp=Math.floor(Date.now()/1000)+parseInt(env.MAIL_TTL_HOURS||"24")*3600;
      try{ await env.DB.prepare("INSERT INTO addresses (address,token,expires_at) VALUES (?,?,?)").bind(address,tok,exp).run(); }
      catch(e){ if(String(e).includes("UNIQUE")){ const row=await env.DB.prepare("SELECT token FROM addresses WHERE address=?").bind(address).first(); return json({address,token:row?.token,reused:true}); } throw e; }
      return json({address,token:tok,jwt:tok,expires_at:exp});
    }
    if(path==="/api/mails"){
      const auth=request.headers.get("Authorization")||""; const tok=auth.replace("Bearer ","")||url.searchParams.get("token")||"";
      if(!tok) return json({error:"Unauthorized"},401);
      const row=await env.DB.prepare("SELECT address FROM addresses WHERE token=?").bind(tok).first(); if(!row) return json({error:"Unauthorized"},401);
      const limit=Math.min(parseInt(url.searchParams.get("limit")||"20"),50); const offset=parseInt(url.searchParams.get("offset")||"0");
      const {results}=await env.DB.prepare("SELECT id,address,sender,subject,substr(text_body,1,200) as preview,created_at FROM mails WHERE address=? ORDER BY id DESC LIMIT ? OFFSET ?").bind(row.address,limit,offset).all();
      return json({address:row.address,count:results.length,results});
    }
    const inboxMatch=path.match(/^\/api\/inboxes\/(.+)\/messages$/);
    if(inboxMatch){
      const address=decodeURIComponent(inboxMatch[1]).toLowerCase(); const limit=Math.min(parseInt(url.searchParams.get("limit")||"20"),50);
      const {results}=await env.DB.prepare("SELECT id,address,sender,subject,text_body,html_body,created_at FROM mails WHERE address=? ORDER BY id DESC LIMIT ?").bind(address,limit).all();
      return json({address,count:results.length,results:results.map(r=>({...r,otp:otp((r.text_body||"")+" "+(r.subject||""))}))});
    }
    const mailMatch=path.match(/^\/api\/mail\/(\d+)$/);
    if(mailMatch&&request.method==="GET"){ const row=await env.DB.prepare("SELECT * FROM mails WHERE id=?").bind(mailMatch[1]).first(); if(!row) return json({error:"Not found"},404); return json({...row,otp:otp((row.text_body||"")+" "+(row.subject||""))}); }
    if(mailMatch&&request.method==="DELETE"){ await env.DB.prepare("DELETE FROM mails WHERE id=?").bind(mailMatch[1]).run(); return json({ok:true}); }
    return json({error:"Not found",path},404);
  },
  async email(message, env, ctx){
    const to=message.to.toLowerCase();
    try{
      const rawText=await new Response(message.raw).text();
      const parsed=parseRaw(rawText);
      const existing=await env.DB.prepare("SELECT address FROM addresses WHERE address=?").bind(to).first();
      if(!existing) await env.DB.prepare("INSERT OR IGNORE INTO addresses (address,token) VALUES (?,?)").bind(to,token()).run();
      await env.DB.prepare("INSERT INTO mails (address,sender,subject,text_body,html_body,raw_size) VALUES (?,?,?,?,?,?)").bind(to,message.from||parsed.from,parsed.subject,parsed.text,parsed.html,rawText.length).run();
    }catch(e){ console.error("email failed",e); await env.DB.prepare("INSERT INTO mails (address,sender,subject,text_body) VALUES (?,?,?,?)").bind(to,message.from,"(parse failed)","").run(); }
  },
  async scheduled(event, env, ctx){
    const ttl=parseInt(env.MAIL_TTL_HOURS||"24"); const cutoff=Math.floor(Date.now()/1000)-ttl*3600;
    ctx.waitUntil(Promise.all([ env.DB.prepare("DELETE FROM mails WHERE created_at < ?").bind(cutoff).run(), env.DB.prepare("DELETE FROM addresses WHERE expires_at IS NOT NULL AND expires_at < ?").bind(Math.floor(Date.now()/1000)).run() ]));
  }
};
