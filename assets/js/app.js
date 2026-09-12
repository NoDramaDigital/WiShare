(function () {
  var APP_VER = 'v39';
  var APP_BUILD = 1;
  function paintDims() {
    try {
      var el = $('app-ver');
      if (!el) return;
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var sh = document.documentElement ? document.documentElement.scrollHeight : 0;
      el.textContent = APP_VER + ' ' + vw + 'x' + vh + '/' + sh;
      el.title = 'viewport width x height / document scroll height';
    } catch (e) {}
  }
  var $ = function (id) { return document.getElementById(id); };
  var views = ['view-lobby', 'view-host', 'view-join', 'view-app'];
  var hostTimer = null;
  var sessionTimer = null;
  var hostDeadline = 0;
  var sessionDeadline = 0;
  var sessionExpiring = false;
  var currentPin = null;
  var currentRole = null;
  var wakeLock = null;
  var txState = Object.create(null);
  var rxState = Object.create(null);
  var receivedBlobs = [];

  function show(name) {
    views.forEach(function (v) {
      var el = $(v);
      if (!el) return;
      var hide = v !== name;
      el.classList.toggle('hidden', hide);
      if (!hide) {
        el.classList.remove('view');
        void el.offsetWidth;
        el.classList.add('view');
      }
    });
    try {
      document.body.classList.toggle('locked-view', name === 'view-app');
    } catch (e) {}
    try {
      var mainEl = document.querySelector('main');
      if (mainEl) mainEl.scrollTo(0, 0);
    } catch (e) {}
    window.scrollTo(0, 0);
  }

  function fmtBytes(n) {
    if (!n || n <= 0) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + ' ' + u[i];
  }

  function fmtRate(bps) {
    return fmtBytes(bps) + '/s';
  }

  function fmtClock(ms) {
    if (ms < 0) ms = 0;
    var s = Math.ceil(ms / 1000);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    if (toastTimer) clearTimeout(toastTimer);
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.add('show');
    toastTimer = setTimeout(function () {
      t.classList.add('hidden');
      t.classList.remove('show');
      toastTimer = null;
    }, 2200);
  }

  async function api(path, body) {
    var res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}'
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error((data && data.error) || ('http_' + res.status));
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && navigator.wakeLock.request) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) {}
  }

  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }

  function startHostCountdown() {
    stopHostCountdown();
    hostDeadline = Date.now() + 5 * 60 * 1000;
    var ring = $('host-ring-fg');
    var txt = $('host-countdown-text');
    var CIRC = 2 * Math.PI * 54;
    hostTimer = setInterval(function () {
      var remain = hostDeadline - Date.now();
      if (txt) txt.textContent = fmtClock(remain);
      if (ring) {
        var frac = Math.max(0, remain / (5 * 60 * 1000));
        ring.style.strokeDashoffset = String(CIRC * (1 - frac));
      }
      if (remain <= 0) {
        stopHostCountdown();
        endSession(true);
        toast('PIN expired');
      }
    }, 250);
  }

  function stopHostCountdown() {
    if (hostTimer) clearInterval(hostTimer);
    hostTimer = null;
  }

  function startSessionGuard() {
    stopSessionGuard();
    sessionExpiring = false;
    extensionsUsed = 0;
    extensionsApplied = 0;
    updateExtendButton();
    sessionDeadline = Date.now() + 15 * 60 * 1000;
    var label = $('session-timer');
    var wrap = $('session-guard');
    sessionTimer = setInterval(function () {
      var remain = sessionDeadline - Date.now();
      if (label) {
        label.textContent = fmtClock(remain);
        label.classList.toggle('text-red-500', remain < 60000);
      }
      if (wrap) wrap.classList.toggle('expiring', remain < 60000);
      if (remain <= 0) {
        sessionExpiring = true;
        if (label) label.textContent = 'Expiring';
        maybeExpireSession();
      }
    }, 500);
  }

  function stopSessionGuard() {
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = null;
  }

  var lastExtendTap = 0;
  var extensionsUsed = 0;
  var extensionsApplied = 0;
  var MAX_EXTENSIONS = 3;
  var MAX_TOTAL_EXTENSIONS = 6;
  var EXTEND_MS = 5 * 60 * 1000;

  function updateExtendButton() {
    var btn = $('btn-extend');
    if (!btn) return;
    var left = Math.max(0, MAX_EXTENSIONS - extensionsUsed);
    btn.textContent = left < MAX_EXTENSIONS ? '+5 min (' + left + ' left)' : '+5 min';
    btn.classList.toggle('opacity-40', left === 0);
  }

  function extendSession(remote) {
    if (!sessionTimer) {
      if (!remote) toast('Connect first');
      return;
    }
    if (!remote) {
      if (extensionsUsed >= MAX_EXTENSIONS) {
        toast('Extension limit reached (3 × +5 min each)');
        return;
      }
      if (extensionsApplied >= MAX_TOTAL_EXTENSIONS) {
        toast('Session at maximum length');
        return;
      }
      extensionsUsed++;
      extensionsApplied++;
      updateExtendButton();
      var sent = false;
      try { sent = P2P.sendExtend(5) === true; } catch (e) { sent = false; }
      if (!sent) toast('Extended locally — peer not notified');
    } else {
      if (extensionsApplied >= MAX_TOTAL_EXTENSIONS) return;
      extensionsApplied++;
    }
    sessionDeadline += EXTEND_MS;
    sessionExpiring = false;
    var wrap = $('session-guard');
    if (wrap) wrap.classList.remove('expiring');
    var label = $('session-timer');
    if (label) {
      label.textContent = fmtClock(sessionDeadline - Date.now());
      label.classList.remove('text-red-500');
    }
    if (remote) toast('Peer extended the session +5 min');
    else if (sent) toast('Session extended +5 min');
  }

  function maybeExpireSession() {
    if (!sessionExpiring) return;
    try {
      if (window.P2P && P2P.transferInProgress()) return;
    } catch (e) {}
    endSession(true);
    toast('Session ended after 15 minutes');
  }

  function setConnected(on) {
    var dots = ['conn-dot', 'conn-dot-top'];
    dots.forEach(function (id) {
      var dot = $(id);
      if (dot) dot.className = 'inline-block w-3 h-3 rounded-full ' + (on ? 'bg-green-500 pulse-dot' : 'bg-amber-500 pulse-dot');
    });
    var label = $('conn-label');
    if (label) label.textContent = on ? 'Connected (P2P Direct)' : 'Connecting…';
    var top = $('conn-label-top');
    if (top) top.textContent = on ? 'Connected (P2P Direct)' : 'Lobby';
  }

  var creating = false;
  var sessionToken = 0;
  async function startAsHost() {
    if (creating) return;
    creating = true;
    var tok = ++sessionToken;
    try {
      var res = await api('api.php?action=create', {});
      if (tok !== sessionToken) {
        await apiCleanup(res.pin);
        return;
      }
      currentPin = res.pin;
      currentRole = 'host';
      clearWorkspace();
      var pinEl = $('host-pin');
      if (pinEl) pinEl.textContent = String(currentPin).split('').join(' ');
      show('view-host');
      startHostCountdown();
      try {
        await P2P.createHost(currentPin);
      } catch (e) {
        stopHostCountdown();
        try { await P2P.disconnect(false); } catch (err) {}
        currentPin = null;
        currentRole = null;
        show('view-lobby');
        toast('WebRTC unavailable in this browser');
        return;
      }
      if (tok !== sessionToken) {
        try { await P2P.disconnect(false); } catch (err) {}
        return;
      }
      setConnected(false);
    } catch (e) {
      if (e && e.data && e.data.error === 'rate_limited') toast('Too many sessions — wait a few minutes');
      else toast('Could not create session');
    } finally {
      creating = false;
    }
  }

  var soundOn = true;
  try { soundOn = localStorage.getItem('wishare-sound') !== 'off'; } catch (e) {}
  var incomingAudio = null;

  function ensureAudio() {
    if (!incomingAudio) {
      try {
        incomingAudio = new Audio('assets/audio/incoming.mp3');
        incomingAudio.preload = 'auto';
      } catch (e) {}
    }
    return incomingAudio;
  }

  function playIncoming() {
    if (!soundOn) return;
    var a = ensureAudio();
    if (!a) return;
    try {
      a.currentTime = 0;
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  function initSound() {
    var btn = $('btn-sound');
    function paint() {
      if (btn) {
        btn.textContent = soundOn ? '🔔' : '🔕';
        btn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
      }
    }
    paint();
    if (btn) btn.addEventListener('click', function () {
      soundOn = !soundOn;
      try { localStorage.setItem('wishare-sound', soundOn ? 'on' : 'off'); } catch (e) {}
      paint();
      if (soundOn) playIncoming();
    });
    function unlock() {
      var a = ensureAudio();
      if (a) { try { a.load(); } catch (e) {} }
    }
    document.addEventListener('pointerdown', unlock, { once: true, passive: true });
    document.addEventListener('keydown', unlock, { once: true });
  }

  var pinBoxesBound = false;
  var lastJoinCode = null;
  var lastJoinAt = 0;
  function clearPinBoxes() {
    var boxes = document.querySelectorAll('.pin-box');
    boxes.forEach(function (b) { b.value = ''; });
    if (boxes[0]) { try { boxes[0].focus(); } catch (e) {} }
  }

  function setupPinBoxes() {
    if (pinBoxesBound) return;
    pinBoxesBound = true;
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.pin-box'));
    if (boxes.length === 0) return;
    boxes.forEach(function (box, i) {
      box.value = '';
      box.addEventListener('input', function () {
        box.value = box.value.replace(/\D/g, '').slice(0, 1);
        if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
        maybeSubmitJoin(boxes.map(function (b) { return b.value; }).join(''));
      });
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
      });
      box.addEventListener('paste', function (e) {
        var t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 4);
        if (!t) return;
        e.preventDefault();
        t.split('').forEach(function (ch, k) { if (boxes[k]) boxes[k].value = ch; });
        if (t.length === 4) maybeSubmitJoin(t);
        else if (boxes[t.length]) boxes[t.length].focus();
      });
    });
    if (boxes[0]) setTimeout(function () { try { boxes[0].focus(); } catch (e) {} }, 100);
  }

  var joining = false;
  function maybeSubmitJoin(code) {
    if (code.length !== 4) return;
    var now = Date.now();
    if (code === lastJoinCode && now - lastJoinAt < 3000) return;
    lastJoinCode = code;
    lastJoinAt = now;
    submitJoin(code);
  }
  async function submitJoin(code) {
    if (joining) return;
    joining = true;
    var tok = sessionToken;
    var errEl = $('join-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
    try {
      await api('api.php?action=join', { pin: code });
      if (tok !== sessionToken) return;
      sessionToken++;
      currentPin = code;
      currentRole = 'joiner';
      clearWorkspace();
      stopHostCountdown();
      show('view-app');
      bindWorkspaceOnce();
      setConnected(false);
      startSessionGuard();
      requestWakeLock();
      $('workspace-pin').textContent = 'PIN ' + code;
      $('workspace-role').textContent = 'Receiver';
      try {
        await P2P.joinSession(code);
      } catch (e) {
        stopSessionGuard();
        releaseWakeLock();
        show('view-join');
        clearPinBoxes();
        currentPin = null;
        currentRole = null;
        if (errEl) { errEl.textContent = 'WebRTC unavailable in this browser'; errEl.classList.remove('hidden'); }
        return;
      }
    } catch (e) {
      if (tok !== sessionToken) return;
      var msg = 'Invalid PIN';
      if (!e || !e.data) msg = 'Network error — check connection';
      else if (e.data.error === 'rate_limited') msg = 'Too many attempts. Locked for 15 minutes.';
      else if (e.data.error === 'expired') msg = 'PIN expired. Ask host for a new one.';
      else if (typeof e.data.remaining === 'number' && e.data.remaining > 0) {
        msg = 'Invalid PIN (' + e.data.remaining + ' attempts left)';
      }
      if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
      var boxes = document.querySelectorAll('.pin-box');
      boxes.forEach(function (b) { b.value = ''; });
      if (boxes[0]) boxes[0].focus();
    } finally {
      joining = false;
    }
  }

  var workspaceBound = false;
  function bindWorkspaceOnce() {
    if (workspaceBound) return;
    workspaceBound = true;
    P2P.on(handleP2PEvent);
    var sendBtn = $('btn-send-text');
    var txt = $('text-input');
    if (sendBtn) sendBtn.addEventListener('click', sendTextUI);
    var expBtn = $('btn-text-expand');
    if (expBtn) expBtn.addEventListener('click', function () {
      var pane = $('pane-text');
      setTextExpanded(pane ? !pane.classList.contains('text-expanded') : false);
    });
    if (txt) {
      txt.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          sendTextUI();
        }
      });
    }
    var pick = $('btn-pick-files');
    var fin = $('file-input');
    if (pick && fin) pick.addEventListener('click', function () { fin.click(); });
    if (fin) fin.addEventListener('change', function () {
      if (fin.files && fin.files.length) {
        P2P.sendFiles(fin.files);
        fin.value = '';
      }
    });
    var dz = $('dropzone');
    if (dz) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) {
          e.preventDefault();
          dz.classList.add('dragging');
        });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) {
          e.preventDefault();
          dz.classList.remove('dragging');
        });
      });
      dz.addEventListener('drop', function (e) {
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) P2P.sendFiles(files);
      });
    }
    var endBtn = $('btn-end');
    if (endBtn) endBtn.addEventListener('click', function () { endSession(false); });
    var connLabel = $('conn-label');
    if (connLabel) connLabel.addEventListener('click', toggleDebug);
    var extBtn = $('btn-extend');
    if (extBtn) extBtn.addEventListener('click', function () {
      var now = Date.now();
      if (now - lastExtendTap < 800) return;
      lastExtendTap = now;
      extendSession(false);
    });
    var zipBtn = $('btn-zip-all');
    if (zipBtn) zipBtn.addEventListener('click', downloadAllZip);
    window.addEventListener('beforeunload', function (e) {
      try {
        if (P2P.transferInProgress()) {
          e.preventDefault();
          e.returnValue = '';
        }
      } catch (err) {}
    });
  }

  function sendTextUI() {
    var txt = $('text-input');
    if (!txt) return;
    var v = txt.value.trim();
    if (!v) return;
    var ok = P2P.sendText(v);
    if (ok === true) {
      appendTextCard(v, true);
      txt.value = '';
    } else if (ok === 'too_large') {
      toast('Text too long (256 KB max)');
    } else {
      toast('Not connected yet');
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {}
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var done = document.execCommand('copy');
      ta.remove();
      return done;
    } catch (err) {
      return false;
    }
  }

  function appendTextCard(text, mine) {
    var list = $('text-list');
    if (!list) return;
    var empty = $('text-empty');
    if (empty) empty.remove();
    var card = document.createElement('div');
    card.className = 'rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 shadow-sm';
    var head = document.createElement('div');
    head.className = 'flex items-center justify-between gap-2 mb-1';
    var meta = document.createElement('div');
    meta.className = 'text-[11px] uppercase tracking-wide opacity-60';
    meta.textContent = mine ? 'You' : 'Peer';
    var btn = document.createElement('button');
    btn.className = 'shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-900 text-white dark:bg-white dark:text-slate-900 active:scale-95 transition';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy text');
    var del = document.createElement('button');
    del.className = 'shrink-0 text-xs font-bold px-2.5 py-1.5 rounded-lg opacity-50 hover:opacity-100 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950 active:scale-95 transition';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Delete message');
    del.addEventListener('click', function () {
      card.remove();
    });
    var actions = document.createElement('div');
    actions.className = 'flex items-center gap-1.5';
    actions.appendChild(btn);
    actions.appendChild(del);
    head.appendChild(meta);
    head.appendChild(actions);
    var body = document.createElement('div');
    body.className = 'whitespace-pre-wrap break-words text-sm';
    body.textContent = text;
    btn.addEventListener('click', async function () {
      var done = await copyText(text);
      btn.textContent = done ? 'Copied!' : 'Copy failed';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    });
    card.appendChild(head);
    card.appendChild(body);
    list.prepend(card);
  }

  var txRows = Object.create(null);
  var rxRows = Object.create(null);

  function progressRow(listId, key) {
    var list = $(listId);
    if (!list) return null;
    var row = list.querySelector('[data-tid="' + key + '"]');
    if (row) return row;
    row = document.createElement('div');
    row.setAttribute('data-tid', key);
    row.className = 'txrx-row';
    var top = document.createElement('div');
    top.className = 'txrx-top';
    var nm = document.createElement('span');
    nm.className = 'txrx-name';
    var pc = document.createElement('span');
    pc.className = 'txrx-pct';
    var xc = document.createElement('button');
    xc.className = 'txrx-cancel';
    xc.textContent = '\u2715';
    xc.setAttribute('aria-label', 'Cancel transfer');
    xc.title = 'Cancel transfer';
    (function (btn, lid, tid) {
      btn.addEventListener('click', function () {
        try { if (window.P2P) P2P.cancelTransfer(tid); } catch (e) {}
        if (lid === 'tx-list') { dropRow(lid, txRows, tid, false); delete txState[tid]; }
        else { dropRow(lid, rxRows, tid, false); delete rxState[tid]; }
      });
    })(xc, listId, key);
    top.appendChild(nm);
    top.appendChild(pc);
    top.appendChild(xc);
    var track = document.createElement('div');
    track.className = 'progress-track h-6 rounded-xl bg-slate-100 dark:bg-slate-800';
    var fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.transform = 'scaleX(0)';
    fill.setAttribute('role', 'progressbar');
    fill.setAttribute('aria-valuemin', '0');
    fill.setAttribute('aria-valuemax', '100');
    fill.setAttribute('aria-valuenow', '0');
    track.appendChild(fill);
    var meta = document.createElement('div');
    meta.className = 'txrx-meta';
    row.appendChild(top);
    row.appendChild(track);
    row.appendChild(meta);
    list.appendChild(row);
    return row;
  }

  function dropRow(listId, rows, key, done) {
    var list = $(listId);
    var row = rows[key];
    if (row && list && row.parentNode === list) {
      if (done) {
        var fill = row.querySelector('.progress-fill');
        if (fill) { fill.style.transform = 'scaleX(1)'; fill.setAttribute('aria-valuenow', '100'); }
        var rl = row;
        setTimeout(function () {
          if (rl.parentNode === list) list.removeChild(rl);
          if (list.children.length === 0) {
            var wrap = list.closest('.card');
            if (wrap) wrap.classList.add('hidden');
          }
        }, 2500);
      } else {
        list.removeChild(row);
      }
    }
    delete rows[key];
    if (!done && list && list.children.length === 0) {
      var wrap = list.closest('.card');
      if (wrap) wrap.classList.add('hidden');
    }
  }

  function renderTx(st) {
    var wrap = $('tx-wrap');
    if (!wrap) return;
    if (!st) {
      var tl = $('tx-list');
      if (tl) while (tl.firstChild) tl.removeChild(tl.firstChild);
      txRows = Object.create(null);
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    var row = progressRow('tx-list', st.transferId);
    if (!row) return;
    txRows[st.transferId] = row;
    var pct = st.size > 0 ? Math.round((st.sent / st.size) * 100) : 100;
    row.querySelector('.txrx-name').textContent = st.name;
    row.querySelector('.txrx-name').title = st.name;
    row.querySelector('.txrx-pct').textContent = pct + '%';
    var fill = row.querySelector('.progress-fill');
    fill.classList.add('progress-send');
    fill.style.transform = 'scaleX(' + (pct / 100) + ')';
    fill.setAttribute('aria-valuenow', String(pct));
    row.querySelector('.txrx-meta').textContent = fmtBytes(st.sent) + ' / ' + fmtBytes(st.size) + ' · ' + st.elapsed.toFixed(1) + 's · ' + fmtRate(st.rate);
  }

  function renderRx(st) {
    var wrap = $('rx-wrap');
    if (!wrap) return;
    if (!st) {
      var rl = $('rx-list');
      if (rl) while (rl.firstChild) rl.removeChild(rl.firstChild);
      rxRows = Object.create(null);
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    var row = progressRow('rx-list', st.transferId);
    if (!row) return;
    rxRows[st.transferId] = row;
    var pct = st.size > 0 ? Math.round((st.received / st.size) * 100) : 100;
    row.querySelector('.txrx-name').textContent = st.name;
    row.querySelector('.txrx-name').title = st.name;
    row.querySelector('.txrx-pct').textContent = pct + '%';
    var fill = row.querySelector('.progress-fill');
    fill.classList.add('progress-recv');
    fill.style.transform = 'scaleX(' + (pct / 100) + ')';
    fill.setAttribute('aria-valuenow', String(pct));
    row.querySelector('.txrx-meta').textContent = fmtBytes(st.received) + ' / ' + fmtBytes(st.size) + ' · ' + st.elapsed.toFixed(1) + 's · ' + fmtRate(st.rate);
  }

  function updateZipButton() {
    var btn = $('btn-zip-all');
    if (!btn) return;
    if (receivedBlobs.length >= 2) {
      btn.classList.remove('hidden');
      btn.textContent = '⬇ Download all ' + receivedBlobs.length + ' (.zip)';
    } else {
      btn.classList.add('hidden');
    }
  }

  function zipSafeName(name, used) {
    var clean = String(name || 'file').replace(/[\\\/]/g, '_').slice(0, 200) || 'file';
    if (!used[clean]) {
      used[clean] = true;
      return clean;
    }
    var dot = clean.lastIndexOf('.');
    var base = dot > 0 ? clean.slice(0, dot) : clean;
    var ext = dot > 0 ? clean.slice(dot) : '';
    var i = 1;
    while (used[base + ' (' + i + ')' + ext]) i++;
    var out = base + ' (' + i + ')' + ext;
    used[out] = true;
    return out;
  }

  var zipping = false;
  async function downloadAllZip() {
    var btn = $('btn-zip-all');
    if (zipping || receivedBlobs.length === 0) return;
    if (typeof JSZip === 'undefined') {
      toast('Zip library failed to load — check connection');
      return;
    }
    zipping = true;
    try {
      if (btn) btn.textContent = 'Preparing… 0%';
      var zip = new JSZip();
      var used = {};
      receivedBlobs.forEach(function (f) {
        zip.file(zipSafeName(f.name, used), f.blob);
      });
      var blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, function (meta) {
        if (btn) btn.textContent = 'Preparing… ' + Math.round(meta.percent) + '%';
      });
      var stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'wishare-' + stamp + '.zip';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { URL.revokeObjectURL(url); } catch (e) {}
        a.remove();
      }, 10000);
      toast('Zip with ' + receivedBlobs.length + ' files downloading');
    } catch (e) {
      toast('Could not build zip');
    } finally {
      zipping = false;
      updateZipButton();
    }
  }

  function appendFileCard(info) {
    var list = $('file-list');
    if (!list) return;
    var entry = null;
    if (info && info.blob) {
      entry = { name: info.name, blob: info.blob };
      receivedBlobs.push(entry);
      updateZipButton();
    }
    var empty = $('file-empty');
    if (empty) empty.remove();
    var card = document.createElement('div');
    card.className = 'rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950 p-3 space-y-2.5';
    var top = document.createElement('div');
    top.className = 'flex items-start gap-2.5';
    var icon = document.createElement('div');
    icon.className = 'text-2xl leading-none mt-0.5';
    icon.textContent = '📄';
    var mid = document.createElement('div');
    mid.className = 'flex-1 min-w-0';
    var name = document.createElement('div');
    name.className = 'font-semibold text-sm break-all';
    name.textContent = info.name;
    name.title = info.name;
    var sub = document.createElement('div');
    sub.className = 'text-xs opacity-70 mt-0.5';
    sub.textContent = fmtBytes(info.size);
    mid.appendChild(name);
    mid.appendChild(sub);
    top.appendChild(icon);
    top.appendChild(mid);
    var del = document.createElement('button');
    del.className = 'shrink-0 text-xs font-bold px-2.5 py-1.5 rounded-lg opacity-50 hover:opacity-100 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950 active:scale-95 transition self-start';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Delete file');
    top.appendChild(del);
    var link = document.createElement('a');
    link.href = info.url;
    link.setAttribute('download', info.name);
    link.className = 'block w-full text-center px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-bold shadow hover:bg-emerald-500 active:scale-[.98] transition break-all';
    link.textContent = 'Download ' + info.name + ' (' + fmtBytes(info.size) + ')';
    card.appendChild(top);
    card.appendChild(link);
    del.addEventListener('click', function () {
      try { URL.revokeObjectURL(link.href); } catch (e) {}
      if (entry) {
        var ix = receivedBlobs.indexOf(entry);
        if (ix !== -1) receivedBlobs.splice(ix, 1);
        updateZipButton();
      }
      card.remove();
      var lst = $('file-list');
      if (lst && lst.children.length === 0) {
        var p = document.createElement('p');
        p.id = 'file-empty';
        p.className = 'empty-note';
        p.textContent = 'Received files appear here — tap Download explicitly on Android.';
        lst.appendChild(p);
      }
    });
    list.prepend(card);
  }

  function handleP2PEvent(evt) {
    if (evt.type === 'connected' || evt.type === 'reconnected') {
      setConnected(true);
      stopHostCountdown();
      var appHidden = $('view-app').classList.contains('hidden');
      if (appHidden && currentRole === 'host') {
        show('view-app');
        bindWorkspaceOnce();
        startSessionGuard();
        requestWakeLock();
        $('workspace-pin').textContent = 'PIN ' + currentPin;
        $('workspace-role').textContent = 'Host';
      }
      toast(evt.type === 'reconnected' ? 'Connection recovered' : 'P2P connected');
    } else if (evt.type === 'reconnecting') {
      setConnected(false);
      toast('Reconnecting…');
    } else if (evt.type === 'failed') {
      toast('Connection lost. Please rejoin.');
    } else if (evt.type === 'signal-gone') {
      try {
        if (P2P.isConnected()) {
          toast('Signaling expired — P2P link continues');
        } else {
          endSession(true);
          toast('Session expired. Please rejoin.');
        }
      } catch (e) {
        endSession(true);
      }
    } else if (evt.type === 'send-start') {
      txState[evt.data.transferId] = { sent: 0, size: evt.data.size, name: evt.data.name, elapsed: 0, rate: 0 };
      renderTx(txState[evt.data.transferId]);
    } else if (evt.type === 'send-progress') {
      txState[evt.data.transferId] = evt.data;
      renderTx(evt.data);
      maybeExpireSession();
    } else if (evt.type === 'send-done') {
      dropRow('tx-list', txRows, evt.data.transferId, true);
      toast('Sent ' + evt.data.name);
      maybeExpireSession();
    } else if (evt.type === 'recv-start') {
      rxState[evt.data.transferId] = { received: 0, size: evt.data.size, name: evt.data.name, elapsed: 0, rate: 0 };
      renderRx(rxState[evt.data.transferId]);
    } else if (evt.type === 'recv-progress') {
      rxState[evt.data.transferId] = evt.data;
      renderRx(evt.data);
    } else if (evt.type === 'file-received') {
      dropRow('rx-list', rxRows, evt.data.transferId, true);
      delete rxState[evt.data.transferId];
      appendFileCard(evt.data);
      playIncoming();
      toast('Received ' + evt.data.name);
      try {
        if (window.innerWidth < 768) {
          var ft = $('btn-tab-files');
          if (ft) ft.click();
        }
      } catch (e) {}
      maybeExpireSession();
    } else if (evt.type === 'peer-received') {
      var confirmed = txState[evt.data.transferId];
      toast('\u2713 Peer saved ' + (confirmed ? confirmed.name : 'file'));
      delete txState[evt.data.transferId];
    } else if (evt.type === 'text-received') {
      appendTextCard(evt.data.text, false);
      playIncoming();
    } else if (evt.type === 'extend-received') {
      extendSession(true);
    } else if (evt.type === 'recv-aborted') {
      dropRow('rx-list', rxRows, evt.data.transferId, false);
      delete rxState[evt.data.transferId];
    } else if (evt.type === 'recv-stalled') {
      dropRow('rx-list', rxRows, evt.data.transferId, false);
      delete rxState[evt.data.transferId];
      toast('Stalled: ' + (evt.data.name || 'file') + ' — sender may have disconnected');
    } else if (evt.type === 'teardown') {
      endSession(true);
      toast('Peer ended session');
    } else if (evt.type === 'disconnected') {
      setConnected(false);
    } else if (evt.type === 'error') {
      if (evt.data.message === 'not_connected') toast('Not connected yet');
      if (evt.data.message === 'send_failed') {
        dropRow('tx-list', txRows, evt.data.transferId, false);
        delete txState[evt.data.transferId];
        toast('Send failed — check connection');
      }
      if (evt.data.message === 'send-cancelled') {
        dropRow('tx-list', txRows, evt.data.transferId, false);
        delete txState[evt.data.transferId];
        if (evt.data.remote) toast('Transfer cancelled by peer');
      }
      if (evt.data.message === 'send-stalled') {
        dropRow('tx-list', txRows, evt.data.transferId, false);
        delete txState[evt.data.transferId];
        toast('Retrying ' + (evt.data.name || 'file') + ' with smaller chunks');
      }
      if (evt.data.message === 'corrupt') {
        dropRow('rx-list', rxRows, evt.data.transferId, false);
        delete rxState[evt.data.transferId];
        toast('File corrupted in transit — please resend');
      }
      if (evt.data.message === 'assemble_failed') {
        dropRow('rx-list', rxRows, evt.data.transferId, false);
        delete rxState[evt.data.transferId];
        toast('Could not assemble file — too large for this device?');
      }
    }
  }

  async function apiCleanup(pin) {
    try {
      await api('api.php?action=cleanup&pin=' + encodeURIComponent(pin), { pin: pin });
    } catch (e) {}
  }

  function clearList(listId, emptyId, emptyText) {
    var list = $(listId);
    if (!list) return;
    var links = list.querySelectorAll('a[href^="blob:"]');
    for (var i = 0; i < links.length; i++) {
      try { URL.revokeObjectURL(links[i].href); } catch (e) {}
    }
    while (list.firstChild) list.removeChild(list.firstChild);
    var p = document.createElement('p');
    p.id = emptyId;
    p.className = 'empty-note';
    p.textContent = emptyText;
    list.appendChild(p);
  }

  function clearWorkspace() {
    txState = Object.create(null);
    rxState = Object.create(null);
    txRows = Object.create(null);
    rxRows = Object.create(null);
    receivedBlobs = [];
    updateZipButton();
    renderTx(null);
    renderRx(null);
    clearList('text-list', 'text-empty', 'Incoming text appears here.');
    clearList('file-list', 'file-empty', 'Received files appear here — tap Download explicitly on Android.');
    setTextExpanded(false);
  }

  async function endSession(silent) {
    sessionToken++;
    if (debugTimer) {
      clearInterval(debugTimer);
      debugTimer = null;
    }
    var dbg = $('debug-line');
    if (dbg) dbg.classList.add('hidden');
    stopHostCountdown();
    stopSessionGuard();
    releaseWakeLock();
    try { await P2P.disconnect(!silent); } catch (e) {}
    if (currentPin) await apiCleanup(currentPin);
    currentPin = null;
    currentRole = null;
    clearWorkspace();
    lastJoinCode = null;
    try {
      var defaultTab = $('btn-tab-text');
      if (defaultTab) defaultTab.click();
    } catch (e) {}
    var boxes = document.querySelectorAll('.pin-box');
    boxes.forEach(function (b) { b.value = ''; });
    show('view-lobby');
  }

  function initTheme() {
    var btn = $('theme-toggle');
    function paint() {
      if (btn) btn.textContent = document.documentElement.classList.contains('dark') ? '☀️' : '🌙';
    }
    paint();
    if (btn) btn.addEventListener('click', function () {
      var dark = !document.documentElement.classList.contains('dark');
      document.documentElement.classList.toggle('dark', dark);
      try { localStorage.setItem('wishare-theme', dark ? 'dark' : 'light'); } catch (e) {}
      paint();
    });
  }

  function initCopyPin() {
    var btn = $('btn-copy-pin');
    if (btn) btn.addEventListener('click', async function () {
      if (!currentPin) return;
      var done = await copyText(currentPin);
      toast(done ? 'PIN copied' : 'PIN: ' + currentPin);
    });
  }

  var debugTimer = null;
  function toggleDebug() {
    var line = $('debug-line');
    if (!line) return;
    if (debugTimer) {
      clearInterval(debugTimer);
      debugTimer = null;
      line.classList.add('hidden');
      return;
    }
    line.classList.remove('hidden');
    refreshDebug();
    debugTimer = setInterval(refreshDebug, 2000);
  }

  function refreshDebug() {
    var line = $('debug-line');
    if (!line) return;
    try {
      var d = window.P2P ? P2P.debug() : null;
      line.textContent = d
        ? 'ice:' + d.ice + ' conn:' + d.conn + ' dc:' + d.dc + ' sig:' + d.sig + ' fails:' + d.fails + ' cands:' + d.sentCands + '↑/' + d.gotCands + '↓' + ' loop:' + d.loopMs + 'ms max:' + d.maxMsg + ' rtt:' + d.rtt + 'ms'
        : 'engine missing';
    } catch (e) {
      line.textContent = 'n/a';
    }
  }

  function setTextExpanded(on) {
    var pane = $('pane-text');
    var list = $('text-list');
    var btn = $('btn-text-expand');
    if (pane) pane.classList.toggle('text-expanded', on);
    if (list) list.classList.toggle('hidden', on);
    if (btn) {
      btn.textContent = on ? '\u2922' : '\u2921';
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? 'Minimize text box' : 'Expand text box');
      btn.title = on ? 'Minimize text box' : 'Expand text box';
    }
  }

  function initPaneTabs() {
    var tabText = $('btn-tab-text');
    var tabFiles = $('btn-tab-files');
    var paneText = $('pane-text');
    var paneFiles = $('pane-files');
    if (!tabText || !tabFiles || !paneText || !paneFiles) return;
    function select(which) {
      var text = which === 'text';
      tabText.classList.toggle('active', text);
      tabFiles.classList.toggle('active', !text);
      tabText.setAttribute('aria-selected', text ? 'true' : 'false');
      tabFiles.setAttribute('aria-selected', !text ? 'true' : 'false');
      paneText.classList.toggle('active-pane', text);
      paneFiles.classList.toggle('active-pane', !text);
    }
    tabText.addEventListener('click', function () { select('text'); });
    tabFiles.addEventListener('click', function () { select('files'); });
  }

  function handleUpdateReady() {
    var reloaded = false;
    try {
      var inApp = $('view-app') && !$('view-app').classList.contains('hidden');
      var busy = false;
      try { busy = !!(window.P2P && P2P.transferInProgress()); } catch (e) {}
      if (!currentPin && !inApp && !busy) {
        location.reload();
        reloaded = true;
      }
    } catch (e) {}
    if (!reloaded) toast('Update ready — reload to apply');
  }

  function initPwa() {
    var deferred = null;
    var btn = $('btn-install');
    function isIos() {
      return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    }
    function isStandalone() {
      return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    }
    if (btn && !isStandalone()) {
      if (isIos()) {
        btn.classList.remove('hidden');
        btn.addEventListener('click', function () {
          toast('Share → Add to Home Screen to install');
        });
      } else {
        window.addEventListener('beforeinstallprompt', function (e) {
          e.preventDefault();
          deferred = e;
          btn.classList.remove('hidden');
        });
        btn.addEventListener('click', async function () {
          if (!deferred) return;
          deferred.prompt();
          try { await deferred.userChoice; } catch (e) {}
          deferred = null;
          btn.classList.add('hidden');
        });
        window.addEventListener('appinstalled', function () {
          deferred = null;
          if (btn) btn.classList.add('hidden');
          toast('App installed');
        });
      }
    }
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function (reg) {
          try { reg.update(); } catch (e) {}
          if (reg.waiting) handleUpdateReady();
          reg.addEventListener('updatefound', function () {
            var worker = reg.installing;
            if (!worker) return;
            worker.addEventListener('statechange', function () {
              if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                handleUpdateReady();
              }
            });
          });
        }).catch(function () {});
      });
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'sw-updated' && navigator.serviceWorker.controller) {
          toast('App updated');
        }
      });
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
          navigator.serviceWorker.getRegistration().then(function (reg) {
            if (reg) { try { reg.update(); } catch (e) {} }
          }).catch(function () {});
        }
      });
    }
  }

  function init() {
    show('view-lobby');
    try {
      var verEl = $('app-ver');
      if (verEl) verEl.textContent = APP_VER;
    } catch (e) {}
    paintDims();
    window.addEventListener('resize', paintDims);
    setTimeout(paintDims, 800);
    setTimeout(paintDims, 2500);
    initTheme();
    initCopyPin();
    initPaneTabs();
    initSound();
    initPwa();
    var bHost = $('btn-host');
    var bJoin = $('btn-join');
    if (bHost) bHost.addEventListener('click', function () {
      if (!window.P2P) {
        toast('App failed to load — please reload');
        return;
      }
      bindWorkspaceOnce();
      startAsHost();
    });
    if (bJoin) bJoin.addEventListener('click', function () {
      if (!window.P2P) {
        toast('App failed to load — please reload');
        return;
      }
      sessionToken++;
      show('view-join');
      setupPinBoxes();
      clearPinBoxes();
    });
    var backs = document.querySelectorAll('[data-back]');
    backs.forEach(function (b) {
      b.addEventListener('click', function () {
        sessionToken++;
        var onHostView = $('view-host') && !$('view-host').classList.contains('hidden');
        if (onHostView && currentPin && currentRole === 'host') {
          endSession(false);
        } else {
          stopHostCountdown();
          show('view-lobby');
        }
      });
    });
    setupPinBoxes();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
