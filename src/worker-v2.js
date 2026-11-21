// Temp Mail v2 for turjaun.xyz - SINGLE FILE Worker, zero dependencies, ESM
// Improved core Worker: long-poll (/api/wait), cursor pagination, ETag/caching,
// OTP + verification-link extraction. All v1 endpoints preserved.
// Bindings needed: D1 binding named DB -> temp-mail-db
// Vars: DOMAINS="turjaun.xyz", MAIL_TTL_HOURS="24"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function domains(env) { return (env.DOMAINS || "turjaun.xyz").split(",").map(s => s.trim().toLowerCase()).filter(Boolean); }
function rnd(len = 10) { const c = "abcdefghijklmnopqrstuvwxyz0123456789"; const a = new Uint8Array(len); crypto.getRandomValues(a); return Array.from(a).map(b => c[b % c.length]).join(""); }
function token() { const a = new Uint8Array(32); crypto.getRandomValues(a); return Array.from(a).map(b => b.toString(16).padStart(2, "0")).join(""); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function intParam(url, name, fallback) { const v = parseInt(url.searchParams.get(name) || "", 10); return Number.isFinite(v) ? v : fallback; }

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type,If-None-Match" };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders } });
}
// Mutations (POST/DELETE) must never be cached.
function jsonNoStore(data, status = 200) { return json(data, status, { "Cache-Control": "no-store" }); }

// Tiny deterministic hash for ETags (FNV-1a over the payload string).
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
// List responses: ETag + Cache-Control: private, max-age=2, with 304 support.
function listJson(request, data) {
  const body = JSON.stringify(data);
  const etag = '"' + fnv1a(body) + '"';
  const headers = { "Content-Type": "application/json", ...CORS, "Cache-Control": "private, max-age=2", "ETag": etag };
  const inm = request.headers.get("If-None-Match") || "";
  if (inm === etag || inm === "W/" + etag) return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// OTP + verification-link extraction
// ---------------------------------------------------------------------------
export function extractOTP(text) {
  const t = text || "";
  // Prefer a code near a keyword (code / OTP / verification / pin / passcode...).
  const kw = t.match(/(?:verification\s*code|security\s*code|one[- ]time(?:\s*(?:code|password|pin))?|otp|passcode|pin|code)[^0-9]{0,40}(\d{4,8})\b/i);
  if (kw) return kw[1];
  const m = t.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}
// Back-compat name used by v1 code paths.
function otp(text) { return extractOTP(text); }

export function extractLinks(text, html) {
  const found = [];
  const seen = new Set();
  const push = (u) => {
    if (!u) return;
    const clean = String(u).replace(/&amp;/g, "&").replace(/[)\].,;'"<>]+$/, "");
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    seen.add(clean); found.push(clean);
  };
  // hrefs from HTML first (most reliable for verification buttons).
  if (html) { const re = /href\s*=\s*["'](https?:\/\/[^"'<>\s]+)["']/gi; let m; while ((m = re.exec(html)) !== null) push(m[1]); }
  const all = (text || "") + " " + (html || "").replace(/<[^>]+>/g, " ");
  const urlRe = /https?:\/\/[^\s"'<>\\)]+/gi; let u; const plain = [];
  while ((u = urlRe.exec(all)) !== null) plain.push(u[0]);
  // Verification-looking links first, then any other links found in the body.
  const isVerify = (x) => /(verif|confirm|activat|validat|reset|magic|sign[-_]?in|login|token=|code=|auth)/i.test(x);
  for (const x of plain) if (isVerify(x)) push(x);
  for (const x of plain) push(x);
  return found;
}
export function extractVerificationLinks(text, html) { return extractLinks(text, html).filter(x => /(verif|confirm|activat|validat|reset|magic|sign[-_]?in|login|token=|code=|auth)/i.test(x)); }

function enrichMail(r, full = true) {
  const bodyText = (r.text_body || r.preview || "") + " " + (r.subject || "");
  const links = full ? extractLinks(r.text_body || "", r.html_body || "") : extractLinks(bodyText, "");
  const vlinks = links.filter(x => /(verif|confirm|activat|validat|reset|magic|sign[-_]?in|login|token=|code=|auth)/i.test(x));
  return { ...r, otp: extractOTP(bodyText), verification_links: vlinks, links };
}

// ---------------------------------------------------------------------------
// MIME parsing (JS implementation)
// RUST_WASM_HOOK: parseRaw is the single parsing entry point for the email()
// handler. To swap in the Rust/WASM parser later, replace the body of
// parseRaw (or re-export a WASM-backed implementation with the same
// signature: parseRaw(raw: string) -> {subject, text, html, from}) and keep
// every caller unchanged. No other code in this file parses raw MIME.
// ---------------------------------------------------------------------------
function decodeQP(s) { return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
function decodeB64(s) { try { return atob(s.replace(/\s/g, "")); } catch { return s; } }

export function parseRaw(raw) {
  const split = raw.indexOf("\r\n\r\n"); const split2 = raw.indexOf("\n\n");
  let hi, bi; if (split >= 0) { hi = split; bi = split + 4; } else if (split2 >= 0) { hi = split2; bi = split2 + 2; } else { hi = 0; bi = 0; }
  const headersRaw = raw.slice(0, hi); const bodyRaw = raw.slice(bi);
  const headers = {}; let cur = "";
  for (const line of headersRaw.split(/\r?\n/)) {
    if (/^\s/.test(line) && cur) { headers[cur] += " " + line.trim(); }
    else { const idx = line.indexOf(":"); if (idx > 0) { cur = line.slice(0, idx).toLowerCase(); headers[cur] = line.slice(idx + 1).trim(); } }
  }
  const subject = headers["subject"] || "(no subject)";
  let text = bodyRaw, html = "";
  const ct = (headers["content-type"] || "").toLowerCase(); const enc = (headers["content-transfer-encoding"] || "").toLowerCase();
  const bm = ct.match(/boundary="?([^";]+)"?/);
  if (bm) {
    const parts = bodyRaw.split("--" + bm[1]);
    let t = "", h = "";
    for (const part of parts) {
      const ps = part.indexOf("\r\n\r\n") >= 0 ? part.indexOf("\r\n\r\n") + 4 : (part.indexOf("\n\n") >= 0 ? part.indexOf("\n\n") + 2 : 0);
      const ph = part.slice(0, ps); const pb = part.slice(ps);
      const pct = ph.toLowerCase(); const penc = (ph.match(/content-transfer-encoding:\s*(\S+)/i) || [])[1] || "";
      let decoded = pb; if (penc.toLowerCase().includes("base64")) decoded = decodeB64(pb); else if (penc.toLowerCase().includes("quoted")) decoded = decodeQP(pb);
      if (pct.includes("text/html")) h += decoded; else if (pct.includes("text/plain")) t += decoded;
    }
    text = t || text; html = h;
  } else {
    if (enc.includes("base64")) text = decodeB64(bodyRaw);
    else if (enc.includes("quoted-printable")) text = decodeQP(bodyRaw);
    if (ct.includes("text/html")) { html = text; text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
  }
  return { subject, text: text.slice(0, 50000), html: html.slice(0, 50000), from: headers["from"] || "" };
}

// ---------------------------------------------------------------------------
// UI placeholder: Agent 3/4's UI replaces UI_HTML during integration.
// Functional v1 UI kept (shortened) so the Worker works standalone.
// ---------------------------------------------------------------------------
export const UI_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temp Mail - turjaun.xyz</title><style>body{font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px;background:#0f172a;color:#e2e8f0}input,button,select{padding:10px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#fff}button{background:#2563eb;cursor:pointer;border:none}.card{background:#1e293b;padding:16px;border-radius:12px;margin:12px 0}.mail{border-top:1px solid #334155;padding:12px 0;cursor:pointer}small{color:#94a3b8}</style></head><body><h1>Temp Mail — turjaun.xyz</h1><div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap"><input id="name" placeholder="custom name (optional)" style="flex:1"><select id="domain"></select><button onclick="createAddr()">Create</button><button onclick="randomAddr()">Random</button></div><p>Address: <b id="addr">-</b></p><p><small>Token: <span id="token">-</span></small></p><button onclick="loadMails()">Refresh</button></div><div class="card"><h3>Inbox</h3><div id="inbox">Create inbox first</div></div><div class="card"><h3>Message</h3><pre id="view" style="white-space:pre-wrap;word-break:break-word">Click a mail</pre></div><script>let A='',T='',lastId=0;async function init(){let r=await fetch('/api/config');let j=await r.json();document.getElementById('domain').innerHTML=j.domains.map(d=>'<option>'+d+'</option>').join('')}async function createAddr(){let n=document.getElementById('name').value,d=document.getElementById('domain').value;let r=await fetch('/api/new_address',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n||undefined,domain:d})});let j=await r.json();if(j.error){alert(j.error);return}A=j.address;T=j.token;document.getElementById('addr').textContent=A;document.getElementById('token').textContent=T;localStorage.setItem('a',A);localStorage.setItem('t',T);loadMails()}async function randomAddr(){document.getElementById('name').value='';await createAddr()}async function loadMails(){if(!T)return;let r=await fetch('/api/mails?limit=20',{headers:{Authorization:'Bearer '+T}});let j=await r.json();let el=document.getElementById('inbox');if(!j.results?.length){el.innerHTML='No mails yet — send to '+A;return}lastId=j.results[0].id;el.innerHTML=j.results.map(m=>'<div class="mail" onclick="viewMail('+m.id+')"><b>'+esc(m.subject||'')+'</b><br><small>'+esc(m.sender||'')+'</small></div>').join('');waitLoop()}async function waitLoop(){if(!T)return;try{let r=await fetch('/api/wait?since_id='+lastId,{headers:{Authorization:'Bearer '+T}});let j=await r.json();if(!j.timeout&&j.results?.length){loadMails()}else if(T){waitLoop()}}catch(e){setTimeout(waitLoop,3000)}}async function viewMail(id){let r=await fetch('/api/mail/'+id);let j=await r.json();document.getElementById('view').textContent=j.subject+' From: '+j.sender+' OTP: '+(j.otp||'-')+' Links: '+((j.verification_links||[]).join(' '))+' '+(j.text_body||'')}function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}init();let sa=localStorage.getItem('a'),st=localStorage.getItem('t');if(sa&&st){A=sa;T=st;document.getElementById('addr').textContent=sa;document.getElementById('token').textContent=st;loadMails()}</script></body></html>`;

// ---------------------------------------------------------------------------
// Pagination + auth helpers
// ---------------------------------------------------------------------------
function parsePagination(url) {
  const limit = Math.min(Math.max(intParam(url, "limit", 20), 1), 50);
  const offset = Math.max(intParam(url, "offset", 0), 0);
  const beforeRaw = url.searchParams.get("before_id");
  const sinceRaw = url.searchParams.get("since_id");
  return {
    limit, offset,
    before_id: beforeRaw !== null && Number.isFinite(parseInt(beforeRaw, 10)) ? parseInt(beforeRaw, 10) : null,
    since_id: sinceRaw !== null && Number.isFinite(parseInt(sinceRaw, 10)) ? parseInt(sinceRaw, 10) : null,
  };
}
function pageMeta(results, limit) {
  const ids = results.map(r => r.id);
  return {
    count: results.length,
    next_before_id: results.length ? results[results.length - 1].id : null,
    has_more: results.length === limit,
    latest_id: ids.length ? Math.max(...ids) : null,
  };
}
// Build a paged mails query for one address. Columns are fixed strings only;
// all values are bound parameters.
function mailsQuery(address, pg, columns) {
  let sql = "SELECT " + columns + " FROM mails WHERE address=?";
  const binds = [address];
  if (pg.since_id !== null) { sql += " AND id>?"; binds.push(pg.since_id); }
  if (pg.before_id !== null) { sql += " AND id<?"; binds.push(pg.before_id); }
  sql += " ORDER BY id DESC LIMIT ? OFFSET ?";
  binds.push(pg.limit, pg.offset);
  return { sql, binds };
}
async function resolveAddress(env, request, url) {
  const auth = request.headers.get("Authorization") || "";
  const tok = auth.replace("Bearer ", "") || url.searchParams.get("token") || "";
  if (tok) {
    const row = await env.DB.prepare("SELECT address FROM addresses WHERE token=?").bind(tok).first();
    return row ? row.address : null;
  }
  const addr = url.searchParams.get("address");
  return addr ? decodeURIComponent(addr).toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url); const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (path === "/") return new Response(UI_HTML, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "public, max-age=60" } });
    if (path === "/api/health") return json({ ok: true, service: "temp-mail", version: 2, domain: domains(env), time: new Date().toISOString() });
    if (path === "/api/config" || path === "/api/domains") return json({ domains: domains(env), ttl_hours: parseInt(env.MAIL_TTL_HOURS || "24") });

    if (path === "/api/new_address" && request.method === "POST") {
      let body = {}; try { body = await request.json(); } catch {}
      const ds = domains(env); const domain = (body.domain || ds[0]).toLowerCase();
      if (!ds.includes(domain)) return jsonNoStore({ error: "Invalid domain", allowed: ds }, 400);
      const name = (body.name || rnd(10)).toLowerCase().replace(/[^a-z0-9._-]/g, "");
      if (!name) return jsonNoStore({ error: "Invalid name" }, 400);
      const address = name + "@" + domain; const tok = token();
      const exp = Math.floor(Date.now() / 1000) + parseInt(env.MAIL_TTL_HOURS || "24") * 3600;
      try { await env.DB.prepare("INSERT INTO addresses (address,token,expires_at) VALUES (?,?,?)").bind(address, tok, exp).run(); }
      catch (e) {
        if (String(e).includes("UNIQUE")) { const row = await env.DB.prepare("SELECT token FROM addresses WHERE address=?").bind(address).first(); return jsonNoStore({ address, token: row?.token, reused: true }); }
        throw e;
      }
      return jsonNoStore({ address, token: tok, jwt: tok, expires_at: exp });
    }

    // (a) Long-poll: GET /api/wait?token=... | ?address=... [&since_id=N]
    if (path === "/api/wait" && request.method === "GET") {
      const address = await resolveAddress(env, request, url);
      if (!address) return jsonNoStore({ error: "Unauthorized - provide token or address" }, 401);
      const since_id = Math.max(intParam(url, "since_id", 0), 0);
      const limit = Math.min(Math.max(intParam(url, "limit", 20), 1), 50);
      const waitS = Math.min(Math.max(intParam(url, "timeout", 25), 1), 30);
      const deadline = Date.now() + waitS * 1000;
      const pollMs = 1200;
      for (;;) {
        const { results } = await env.DB.prepare(
          "SELECT id,address,sender,subject,text_body,html_body,created_at FROM mails WHERE address=? AND id>? ORDER BY id DESC LIMIT ?"
        ).bind(address, since_id, limit).all();
        if (results.length) {
          const enriched = results.map(r => enrichMail(r, true));
          return jsonNoStore({ timeout: false, address, since_id, latest_id: Math.max(...results.map(r => r.id)), count: enriched.length, results: enriched });
        }
        if (Date.now() >= deadline) return jsonNoStore({ timeout: true, address, since_id, results: [] });
        await sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 0)));
      }
    }

    if (path === "/api/mails" && request.method === "GET") {
      const auth = request.headers.get("Authorization") || "";
      const tok = auth.replace("Bearer ", "") || url.searchParams.get("token") || "";
      if (!tok) return json({ error: "Unauthorized" }, 401);
      const row = await env.DB.prepare("SELECT address FROM addresses WHERE token=?").bind(tok).first();
      if (!row) return json({ error: "Unauthorized" }, 401);
      const pg = parsePagination(url);
      const q = mailsQuery(row.address, pg, "id,address,sender,subject,substr(text_body,1,200) as preview,created_at");
      const { results } = await env.DB.prepare(q.sql).bind(...q.binds).all();
      const enriched = results.map(r => enrichMail(r, false));
      return listJson(request, { address: row.address, ...pageMeta(results, pg.limit), since_id: pg.since_id, before_id: pg.before_id, results: enriched });
    }

    const inboxMatch = path.match(/^\/api\/inboxes\/(.+)\/messages$/);
    if (inboxMatch && request.method === "GET") {
      const address = decodeURIComponent(inboxMatch[1]).toLowerCase();
      const pg = parsePagination(url);
      const q = mailsQuery(address, pg, "id,address,sender,subject,text_body,html_body,created_at");
      const { results } = await env.DB.prepare(q.sql).bind(...q.binds).all();
      const enriched = results.map(r => enrichMail(r, true));
      return listJson(request, { address, ...pageMeta(results, pg.limit), since_id: pg.since_id, before_id: pg.before_id, results: enriched });
    }

    const mailMatch = path.match(/^\/api\/mail\/(\d+)$/);
    if (mailMatch && request.method === "GET") {
      const row = await env.DB.prepare("SELECT * FROM mails WHERE id=?").bind(mailMatch[1]).first();
      if (!row) return json({ error: "Not found" }, 404);
      return json(enrichMail(row, true), 200, { "Cache-Control": "private, max-age=2" });
    }
    if (mailMatch && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM mails WHERE id=?").bind(mailMatch[1]).run();
      return jsonNoStore({ ok: true });
    }
    return json({ error: "Not found", path }, 404);
  },

  async email(message, env, ctx) {
    const to = message.to.toLowerCase();
    try {
      const rawText = await new Response(message.raw).text();
      const parsed = parseRaw(rawText); // RUST_WASM_HOOK: sole raw-MIME entry point
      const existing = await env.DB.prepare("SELECT address FROM addresses WHERE address=?").bind(to).first();
      if (!existing) await env.DB.prepare("INSERT OR IGNORE INTO addresses (address,token) VALUES (?,?)").bind(to, token()).run();
      await env.DB.prepare("INSERT INTO mails (address,sender,subject,text_body,html_body,raw_size) VALUES (?,?,?,?,?,?)").bind(to, message.from || parsed.from, parsed.subject, parsed.text, parsed.html, rawText.length).run();
    } catch (e) {
      console.error("email failed", e);
      await env.DB.prepare("INSERT INTO mails (address,sender,subject,text_body) VALUES (?,?,?,?)").bind(to, message.from, "(parse failed)", "").run();
    }
  },

  async scheduled(event, env, ctx) {
    const ttl = parseInt(env.MAIL_TTL_HOURS || "24"); const cutoff = Math.floor(Date.now() / 1000) - ttl * 3600;
    ctx.waitUntil(Promise.all([
      env.DB.prepare("DELETE FROM mails WHERE created_at < ?").bind(cutoff).run(),
      env.DB.prepare("DELETE FROM addresses WHERE expires_at IS NOT NULL AND expires_at < ?").bind(Math.floor(Date.now() / 1000)).run(),
    ]));
  },
};
