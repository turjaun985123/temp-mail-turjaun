'use strict';
/*
 * Temp Mail v2 - UI app (vanilla JS, no frameworks)
 * Domain: turjaun.xyz - Worker API contract (v1 + v2 /api/wait)
 *
 * Fast message showing:
 *  - Long-poll loop on GET /api/wait?since_id=N (server holds up to 25s,
 *    returns immediately when a new mail arrives).
 *  - Falls back to 3s polling on /api/mails if /api/wait errors.
 *  - Pauses while the tab is hidden (visibilitychange), resumes on return.
 *  - Incremental rendering: a mail node is created once, keyed by mail id,
 *    and only new nodes are inserted. The list is never re-rendered whole.
 */
(function () {
  var LS_ADDR = 'tm_v2_address';
  var LS_TOKEN = 'tm_v2_token';

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  var els = {
    name: $('name'),
    domain: $('domain'),
    createBtn: $('createBtn'),
    randomBtn: $('randomBtn'),
    addr: $('addr'),
    token: $('token'),
    copyAddr: $('copyAddr'),
    inbox: $('inbox'),
    view: $('view'),
    search: $('search'),
    refreshBtn: $('refreshBtn'),
    status: $('status')
  };

  // ---------- state ----------
  var address = '';
  var authToken = '';
  var maxId = 0;                 // highest mail id seen (the since_id cursor)
  var nodesById = new Map();     // mail id -> list DOM node
  var mailById = new Map();      // mail id -> list-level mail object
  var generation = 0;            // bumped on inbox switch; kills stale loops
  var waitAbort = null;          // AbortController for the in-flight /api/wait
  var fallbackTimer = null;      // setInterval id when in 3s-polling fallback
  var mode = 'idle';             // 'wait' | 'fallback' | 'paused' | 'idle'
  var emptyNode = null;          // "no mails yet" placeholder node
  var selectedId = null;

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
  }

  function relTime(createdAtSec) {
    var sec = Math.floor(Date.now() / 1000) - Number(createdAtSec || 0);
    if (!createdAtSec || sec < 0) return '';
    if (sec < 10) return 'just now';
    if (sec < 60) return sec + 's ago';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    var day = Math.floor(hr / 24);
    if (day < 30) return day + 'd ago';
    return new Date(Number(createdAtSec) * 1000).toLocaleDateString();
  }

  function copyText(text, btn) {
    if (!text) return Promise.resolve(false);
    function done(ok) {
      if (btn) {
        var old = btn.textContent;
        btn.textContent = ok ? 'Copied!' : 'Copy failed';
        setTimeout(function () { btn.textContent = old; }, 1200);
      }
      return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return done(true); },
        function () { return fallbackCopy(text, btn, done); });
    }
    return Promise.resolve(fallbackCopy(text, btn, done));
  }

  function fallbackCopy(text, btn, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return done(ok);
    } catch (e) { return done(false); }
  }

  function authHeaders() {
    return { Authorization: 'Bearer ' + authToken };
  }

  function normalizeList(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.results)) return payload.results;
    if (Array.isArray(payload.mails)) return payload.mails;
    if (Array.isArray(payload.new)) return payload.new;
    if (payload.mail) return [payload.mail];
    if (payload.id) return [payload];
    return [];
  }

  // ---------- incremental list rendering ----------
  function ensureEmptyNode() {
    if (!els.inbox) return;
    if (nodesById.size === 0) {
      if (!emptyNode) {
        emptyNode = document.createElement('div');
        emptyNode.className = 'empty';
        emptyNode.textContent = address
          ? 'No mails yet - send a mail to ' + address
          : 'Create an inbox first';
        els.inbox.appendChild(emptyNode);
      }
    } else if (emptyNode) {
      emptyNode.remove();
      emptyNode = null;
    }
  }

  function matchesSearch(mail) {
    if (!els.search || !els.search.value) return true;
    var q = els.search.value.trim().toLowerCase();
    if (!q) return true;
    var hay = ((mail.subject || '') + ' ' + (mail.sender || '') + ' ' +
      (mail.preview || '') + ' ' + (mail.text_body || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function buildMailNode(mail) {
    var node = document.createElement('div');
    node.className = 'mail';
    node.dataset.id = String(mail.id);

    var subj = document.createElement('b');
    subj.textContent = mail.subject || '(no subject)';
    node.appendChild(subj);
    node.appendChild(document.createElement('br'));

    var meta = document.createElement('small');
    var from = document.createElement('span');
    from.textContent = mail.sender || '';
    var when = document.createElement('span');
    when.className = 'mail-time';
    when.dataset.created = String(mail.created_at || '');
    when.textContent = mail.created_at ? ' - ' + relTime(mail.created_at) : '';
    meta.appendChild(from);
    meta.appendChild(when);
    node.appendChild(meta);

    if (mail.preview) {
      node.appendChild(document.createElement('br'));
      var prev = document.createElement('small');
      prev.textContent = mail.preview;
      node.appendChild(prev);
    }

    node.addEventListener('click', function () { viewMail(mail.id); });
    return node;
  }

  // Insert keeping newest-first order, without touching existing nodes.
  function insertNode(node, id) {
    if (!els.inbox) return;
    var before = null;
    var children = els.inbox.children;
    for (var i = 0; i < children.length; i++) {
      var cid = Number(children[i].dataset && children[i].dataset.id);
      if (cid && cid < id) { before = children[i]; break; }
    }
    if (before) els.inbox.insertBefore(node, before);
    else els.inbox.appendChild(node);
  }

  // Add only mails whose id we have never seen. Returns count added.
  function addMails(list) {
    var added = 0;
    // Oldest first so insertion order settles newest-first at the top.
    var sorted = list.slice().sort(function (a, b) { return Number(a.id) - Number(b.id); });
    for (var i = 0; i < sorted.length; i++) {
      var mail = sorted[i];
      var id = Number(mail && mail.id);
      if (!id || nodesById.has(id)) continue;
      mailById.set(id, mail);
      if (id > maxId) maxId = id;
      var node = buildMailNode(mail);
      if (!matchesSearch(mail)) node.style.display = 'none';
      nodesById.set(id, node);
      insertNode(node, id);
      added++;
    }
    if (added) ensureEmptyNode();
    return added;
  }

  function applySearch() {
    nodesById.forEach(function (node, id) {
      var mail = mailById.get(id) || {};
      node.style.display = matchesSearch(mail) ? '' : 'none';
    });
  }

  function clearInboxList() {
    nodesById.forEach(function (node) { node.remove(); });
    nodesById.clear();
    mailById.clear();
    maxId = 0;
    selectedId = null;
    if (emptyNode) { emptyNode.remove(); emptyNode = null; }
    ensureEmptyNode();
  }

  function refreshTimestamps() {
    if (!els.inbox) return;
    var times = els.inbox.querySelectorAll('.mail-time');
    for (var i = 0; i < times.length; i++) {
      var created = Number(times[i].dataset.created);
      if (created) times[i].textContent = ' - ' + relTime(created);
    }
  }

  // ---------- API ----------
  function loadMails() {
    if (!authToken) return Promise.resolve(0);
    var gen = generation;
    return fetch('/api/mails?limit=50&offset=0', { headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error('mails ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (gen !== generation) return 0; // inbox switched meanwhile
        var added = addMails(normalizeList(j));
        ensureEmptyNode();
        return added;
      })
      .catch(function () {
        if (gen === generation) setStatus('Could not load inbox - retrying…');
        return 0;
      });
  }

  // ---------- live updates: long-poll with polling fallback ----------
  function stopLive() {
    if (waitAbort) { try { waitAbort.abort(); } catch (e) {} waitAbort = null; }
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  }

  function startFallback(gen) {
    if (gen !== generation || mode === 'fallback') return;
    mode = 'fallback';
    stopLive();
    setStatus('Live unavailable - refreshing every 3s');
    fallbackTimer = setInterval(function () {
      if (gen !== generation || document.hidden) return;
      loadMails();
    }, 3000);
  }

  function startWaitLoop() {
    if (!authToken || document.hidden) return;
    var gen = generation;
    mode = 'wait';
    setStatus('Live - waiting for new mail…');

    function step() {
      if (gen !== generation || document.hidden || mode !== 'wait') return;
      waitAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var opts = { headers: authHeaders() };
      if (waitAbort) opts.signal = waitAbort.signal;
      fetch('/api/wait?since_id=' + encodeURIComponent(maxId), opts)
        .then(function (r) {
          if (!r.ok) throw new Error('wait ' + r.status);
          return r.json();
        })
        .then(function (j) {
          if (gen !== generation || mode !== 'wait') return;
          var list = normalizeList(j);
          if (j && (j.since_id || j.last_id)) {
            var cursor = Number(j.since_id || j.last_id);
            if (cursor > maxId && list.length === 0) maxId = cursor;
          }
          if (list.length) {
            var added = addMails(list);
            if (added) setStatus('New mail received');
            setTimeout(function () { if (mode === 'wait') setStatus('Live - waiting for new mail…'); }, 2000);
          }
          step(); // long-poll again immediately (also after a 25s timeout reply)
        })
        .catch(function (err) {
          if (gen !== generation) return;
          if (err && err.name === 'AbortError') return; // switch / pause: not an error
          if (document.hidden) return;
          startFallback(gen); // /api/wait errored -> 3s polling
        });
    }
    step();
  }

  function startLive() {
    stopLive();
    if (!authToken) { mode = 'idle'; return; }
    if (document.hidden) { mode = 'paused'; setStatus('Paused (tab hidden)'); return; }
    startWaitLoop();
  }

  // ---------- inbox create / switch ----------
  function setInbox(newAddress, newToken, persist) {
    generation++;            // invalidate any in-flight loop/fetch
    stopLive();
    mode = 'idle';
    address = newAddress || '';
    authToken = newToken || '';
    if (persist) {
      try {
        localStorage.setItem(LS_ADDR, address);
        localStorage.setItem(LS_TOKEN, authToken);
      } catch (e) {}
    }
    if (els.addr) els.addr.textContent = address || '-';
    if (els.token) els.token.textContent = authToken || '-';
    clearInboxList();
    if (els.view) els.view.textContent = 'Click a mail to view it';
  }

  function createInbox(random) {
    var gen = generation + 1;
    var nameVal = (!random && els.name) ? els.name.value.trim() : '';
    var domainVal = (els.domain && els.domain.value) || undefined;
    setStatus('Creating inbox…');
    return fetch('/api/new_address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: nameVal ? nameVal : undefined,
        domain: domainVal
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.error || !j.address) {
          setStatus((j && j.error) || 'Could not create inbox');
          return;
        }
        if (random && els.name) els.name.value = '';
        setInbox(j.address, j.token || j.jwt || '', true);
        if (gen !== generation) return; // superseded (defensive)
        setStatus('Inbox ready - loading…');
        return loadMails().then(function () { startLive(); });
      })
      .catch(function () { setStatus('Network error creating inbox'); });
  }

  // ---------- mail viewing ----------
  // Escaped body with the OTP digits wrapped in <mark>. Escaping happens
  // first; the OTP is digits-only, so wrapping it afterwards cannot
  // re-introduce markup from the mail content.
  function highlightedBody(mail) {
    var body = esc(mail.text_body || mail.preview || '');
    var otpVal = mail.otp ? String(mail.otp) : null;
    if (!otpVal) {
      var m = body.match(/\b\d{4,8}\b/);
      if (m) otpVal = m[0];
    }
    if (otpVal) {
      body = body.split(esc(otpVal)).join('<mark>' + esc(otpVal) + '</mark>');
    }
    return { html: body, otp: otpVal };
  }

  function viewMail(id) {
    if (!els.view) return;
    selectedId = id;
    nodesById.forEach(function (node, nid) {
      node.classList.toggle('active', nid === id);
    });
    els.view.textContent = 'Loading…';
    fetch('/api/mail/' + encodeURIComponent(id), { headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error('mail ' + r.status);
        return r.json();
      })
      .then(function (mail) {
        if (selectedId !== id || !els.view) return;
        // Keep the cached list entry fresh for search.
        if (mail && mail.id) mailById.set(Number(mail.id), Object.assign({}, mailById.get(Number(mail.id)) || {}, mail));
        els.view.textContent = '';

        var title = document.createElement('h4');
        title.textContent = mail.subject || '(no subject)';
        els.view.appendChild(title);

        var from = document.createElement('p');
        var fromSmall = document.createElement('small');
        fromSmall.textContent = 'From: ' + (mail.sender || '') +
          (mail.created_at ? ' - ' + relTime(mail.created_at) + ' (' +
            new Date(Number(mail.created_at) * 1000).toLocaleString() + ')' : '');
        from.appendChild(fromSmall);
        els.view.appendChild(from);

        var result = highlightedBody(mail || {});
        if (result.otp) {
          var otpRow = document.createElement('p');
          var otpLabel = document.createElement('span');
          otpLabel.textContent = 'OTP: ';
          var otpValEl = document.createElement('strong');
          otpValEl.textContent = result.otp;
          var otpBtn = document.createElement('button');
          otpBtn.type = 'button';
          otpBtn.textContent = 'Copy OTP';
          otpBtn.addEventListener('click', function () { copyText(result.otp, otpBtn); });
          otpRow.appendChild(otpLabel);
          otpRow.appendChild(otpValEl);
          otpRow.appendChild(document.createTextNode(' '));
          otpRow.appendChild(otpBtn);
          els.view.appendChild(otpRow);
        }

        var pre = document.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.wordBreak = 'break-word';
        pre.innerHTML = result.html; // already escaped above; only <mark> was added
        els.view.appendChild(pre);
      })
      .catch(function () {
        if (selectedId === id && els.view) els.view.textContent = 'Could not load this mail';
      });
  }

  // ---------- init ----------
  function initDomains() {
    if (!els.domain) return Promise.resolve();
    return fetch('/api/config')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var list = (j && j.domains) || [];
        els.domain.textContent = '';
        list.forEach(function (d) {
          var opt = document.createElement('option');
          opt.value = d;
          opt.textContent = d;
          els.domain.appendChild(opt);
        });
      })
      .catch(function () { setStatus('Could not load configuration'); });
  }

  function restoreInbox() {
    var savedAddr = null, savedToken = null;
    try {
      savedAddr = localStorage.getItem(LS_ADDR);
      savedToken = localStorage.getItem(LS_TOKEN);
    } catch (e) {}
    if (savedAddr && savedToken) {
      setInbox(savedAddr, savedToken, false);
      setStatus('Inbox restored - loading…');
      loadMails().then(function () { startLive(); });
    } else {
      ensureEmptyNode();
      setStatus('Create an inbox to start');
    }
  }

  function bind() {
    if (els.createBtn) els.createBtn.addEventListener('click', function () { createInbox(false); });
    if (els.randomBtn) els.randomBtn.addEventListener('click', function () { createInbox(true); });
    if (els.refreshBtn) els.refreshBtn.addEventListener('click', function () {
      if (!authToken) return;
      setStatus('Refreshing…');
      loadMails().then(function () { if (mode === 'wait' || mode === 'idle') setStatus('Live - waiting for new mail…'); });
    });
    if (els.copyAddr) els.copyAddr.addEventListener('click', function () { copyText(address, els.copyAddr); });
    if (els.search) els.search.addEventListener('input', applySearch);
    if (els.name) els.name.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') createInbox(false);
    });

    document.addEventListener('visibilitychange', function () {
      if (!authToken) return;
      if (document.hidden) {
        stopLive(); // aborts the in-flight /api/wait; its AbortError is ignored
        mode = 'paused';
        setStatus('Paused (tab hidden)');
      } else {
        setStatus('Back - checking for new mail…');
        loadMails().then(function () { startLive(); });
      }
    });

    setInterval(refreshTimestamps, 30000);
  }

  function init() {
    bind();
    initDomains().then(restoreInbox);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
