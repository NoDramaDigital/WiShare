window.P2P = (function () {
  var rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
  };
  var CHUNK_SIZE = 65536;
  var LOW_THRESHOLD = 524288;
  var HIGH_WATER = 2097152;
  var POLL_MS = 1100;
  var RECONNECT_WINDOW_MS = 30000;
  var PROTO_VER = 1;

  var pc = null;
  var dc = null;
  var role = null;
  var pin = null;
  var pollTimer = null;
  var pollActive = false;
  var unsentCandidates = [];
  var seenRemoteCands = {};
  var appliedOfferSdp = null;
  var appliedAnswerSdp = null;
  var handlers = [];
  var sendQueue = [];
  var activeCount = 0;
  var fileSlots = [];
  var FILE_SLOTS = 3;
  var activeSends = {};
  var peerNew = false;
  var dcPseudo = { ch: null, open: false, busy: false, transferId: null };
  var incoming = Object.create(null);
  var connectedFlag = false;
  var reconnectTimer = null;
  var bytesSentWindow = [];
  var bytesRecvWindow = [];
  var lastOfferSent = null;
  var lastAnswerSent = null;
  var closed = false;
  var failCount = 0;
  var signalGone = false;
  var statSentCands = 0;
  var lastRtt = 0;
  var pingTimer = null;
  var lastSendEmit = 0;
  var loopSum = 0;
  var loopN = 0;

  function emit(type, payload) {
    var evt = { type: type, data: payload || {} };
    for (var i = 0; i < handlers.length; i++) {
      try { handlers[i](evt); } catch (e) {}
    }
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function candId(c) {
    return (c.candidate || '') + '|' + (c.sdpMid || '') + '|' + (c.sdpMLineIndex || '');
  }

  async function postSignal(payload) {
    var res = await fetch('api.php?action=signal&pin=' + encodeURIComponent(pin) + '&role=' + encodeURIComponent(role), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      var err = new Error('signal_http_' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function pollOnce() {
    if (pollActive || closed || !pc || !pin || !role) return;
    try {
      var sweepNow = Date.now();
      for (var tid in incoming) {
        var ent = incoming[tid];
        if (ent && sweepNow - (ent.lastProgress || ent.startedAt || 0) > 30000) {
          delete incoming[tid];
          emit('recv-stalled', { transferId: tid, name: ent.meta ? ent.meta.name : 'file' });
        }
      }
    } catch (sweepErr) {}
    pollActive = true;
    try {
      var out = { role: role, cv: PROTO_VER };
      if (unsentCandidates.length > 0) {
        out.candidates = unsentCandidates.slice();
      }
      var offerFp = null;
      var answerFp = null;
      if (pc.localDescription) {
        var ld = pc.localDescription;
        var desc = { type: ld.type, sdp: ld.sdp };
        var fp = ld.type + ':' + (ld.sdp || '').length + ':' + hashStr(ld.sdp || '');
        if (role === 'host' && ld.type === 'offer' && fp !== lastOfferSent) {
          out.offer = desc;
          offerFp = fp;
        }
        if (role === 'joiner' && ld.type === 'answer' && fp !== lastAnswerSent) {
          out.answer = desc;
          answerFp = fp;
        }
      }
      var state = await postSignal(out);
      if (!state || !state.ok) return;
      failCount = 0;
      if (offerFp) lastOfferSent = offerFp;
      if (answerFp) lastAnswerSent = answerFp;
      if (out.candidates) {
        unsentCandidates.splice(0, out.candidates.length);
        statSentCands += out.candidates.length;
      }
      await applyRemoteState(state);
    } catch (e) {
      failCount++;
      if (e && e.status === 413 && out.candidates) {
        unsentCandidates.splice(0, out.candidates.length);
      }
      if (e && e.status === 404 && failCount >= 3 && !signalGone) {
        signalGone = true;
        stopPolling();
        emit('signal-gone', {});
      }
    } finally {
      pollActive = false;
    }
  }

  var CRC_TABLE = null;
  function crc32Update(crc, bytes) {
    if (!CRC_TABLE) {
      var t = new Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
      }
      CRC_TABLE = t;
    }
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return crc;
  }

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  async function applyRemoteState(state) {
    if (closed) return;
    if (state && typeof state.peer_cv === 'number' && state.peer_cv >= 1) peerNew = true;
    try {
      if (role === 'host' && state.answer && state.answer.sdp !== appliedAnswerSdp) {
        if (!pc.currentRemoteDescription || pc.currentRemoteDescription.sdp !== state.answer.sdp) {
          await pc.setRemoteDescription({ type: 'answer', sdp: state.answer.sdp });
          appliedAnswerSdp = state.answer.sdp;
        }
      }
      if (role === 'joiner' && state.offer && state.offer.sdp !== appliedOfferSdp) {
        await pc.setRemoteDescription({ type: 'offer', sdp: state.offer.sdp });
        appliedOfferSdp = state.offer.sdp;
        var answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        lastAnswerSent = null;
        await pollOnceSoon();
      }
      var remoteList = role === 'host' ? (state.joiner_candidates || []) : (state.host_candidates || []);
      if (!pc.remoteDescription) return;
      for (var i = 0; i < remoteList.length; i++) {
        var c = remoteList[i];
        if (!c || !c.candidate) continue;
        var id = candId(c);
        if (seenRemoteCands[id]) continue;
        try {
          await pc.addIceCandidate(c);
          seenRemoteCands[id] = true;
        } catch (e) {}
      }
    } catch (e) {}
  }

  function pollOnceSoon() {
    setTimeout(function () { pollOnce(); }, 50);
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollOnce, POLL_MS);
    pollOnce();
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function wireConnectionEvents() {
    pc.onicecandidate = function (e) {
      if (e.candidate) unsentCandidates.push(e.candidate.toJSON ? e.candidate.toJSON() : {
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex
      });
    };
    pc.oniceconnectionstatechange = function () {
      var st = pc ? pc.iceConnectionState : 'closed';
      emit('ice', { state: st });
      if (st === 'connected' || st === 'completed') {
        clearReconnectTimer();
        if (!connectedFlag) {
          connectedFlag = true;
          emit('connected', {});
        } else {
          emit('reconnected', {});
        }
      }
      if (st === 'disconnected' || st === 'failed') {
        emit('reconnecting', { state: st });
        handleDisconnect();
      }
    };
    pc.onconnectionstatechange = function () {
      var st = pc ? pc.connectionState : 'closed';
      emit('connection', { state: st });
      if (st === 'connected' && !connectedFlag) {
        connectedFlag = true;
        emit('connected', {});
      }
      if (st === 'failed') {
        emit('reconnecting', { state: st });
        handleDisconnect();
      }
    };
  }

  function wireChannel(ch) {
    ch.binaryType = 'arraybuffer';
    try { ch.bufferedAmountLowThreshold = LOW_THRESHOLD; } catch (e) {}
    ch.onopen = function () {
      emit('channel-open', {});
      startPing();
      dispatchQueue();
    };
    ch.onclose = function () {
      emit('channel-close', {});
      stopPing();
      if (ch._resumeSend) {
        var r = ch._resumeSend;
        ch._resumeSend = null;
        try { r(); } catch (e) {}
      }
    };
    ch.onerror = function () {
      emit('error', { message: 'datachannel_error' });
    };
    ch.onbufferedamountlow = function () {
      if (ch._resumeSend) {
        var r = ch._resumeSend;
        ch._resumeSend = null;
        r();
      }
    };
    ch.onmessage = function (e) { handleMessage(e, ch); };
  }

  function slotByChannel(ch) {
    for (var i = 0; i < fileSlots.length; i++) {
      if (fileSlots[i] && fileSlots[i].ch === ch) return fileSlots[i];
    }
    return null;
  }

  function wireFileChannel(ch, idx) {
    ch.binaryType = 'arraybuffer';
    try { ch.bufferedAmountLowThreshold = LOW_THRESHOLD; } catch (e) {}
    ch.onopen = function () {
      var slot = slotByChannel(ch);
      if (slot) slot.open = true;
      dispatchQueue();
    };
    ch.onclose = function () {
      var slot = slotByChannel(ch);
      if (slot) { slot.open = false; slot.busy = false; }
      if (ch._resumeSend) {
        var r = ch._resumeSend;
        ch._resumeSend = null;
        try { r(); } catch (e) {}
      }
    };
    ch.onerror = function () {
      emit('error', { message: 'datachannel_error' });
    };
    ch.onbufferedamountlow = function () {
      if (ch._resumeSend) {
        var r = ch._resumeSend;
        ch._resumeSend = null;
        r();
      }
    };
    ch.onmessage = function (e) { handleMessage(e, ch); };
    fileSlots[idx] = { ch: ch, open: ch.readyState === 'open', busy: false, transferId: null };
  }

  function waitForDrain(ch) {
    return new Promise(function (resolve) {
      if (ch.bufferedAmount <= LOW_THRESHOLD) return resolve();
      ch._resumeSend = resolve;
    });
  }

  function settleWaiter(ch) {
    try {
      if (ch && ch._resumeSend) {
        var r = ch._resumeSend;
        ch._resumeSend = null;
        r();
      }
    } catch (e) {}
  }

  function pruneWindow(arr, now) {
    while (arr.length > 0 && now - arr[0].t > 1000) arr.shift();
  }

  function windowRate(arr, now) {
    pruneWindow(arr, now);
    var b = 0;
    for (var i = 0; i < arr.length; i++) b += arr[i].n;
    return b;
  }

  async function handleMessage(e, ch) {
    var now = Date.now();
    if (typeof e.data === 'string') {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.type === 'meta' && msg.kind === 'file') {
        if (typeof msg.transferId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(msg.transferId)) return;
        if (typeof msg.size !== 'number' || !(msg.size >= 0) || msg.size > 21474836480) return;
        if (typeof msg.totalChunks !== 'number' || (msg.totalChunks | 0) !== msg.totalChunks) return;
        if (typeof msg.name !== 'string' || msg.name === '' || msg.name.length > 255) return;
        var cs = CHUNK_SIZE;
        if (typeof msg.chunkSize === 'number' && (msg.chunkSize | 0) === msg.chunkSize && msg.chunkSize >= 4096 && msg.chunkSize <= 1048576) cs = msg.chunkSize;
        var expect = Math.max(1, Math.ceil(msg.size / cs));
        if (msg.totalChunks !== expect || msg.totalChunks > 350000) return;
        if (ch) ch._transferId = msg.transferId;
        incoming[msg.transferId] = {
          meta: msg,
          chunks: new Array(msg.totalChunks),
          received: 0,
          receivedBytes: 0,
          startedAt: now,
          lastEmit: 0,
          lastProgress: now
        };
        emit('recv-start', { transferId: msg.transferId, name: msg.name, size: msg.size, mime: msg.mime, totalChunks: msg.totalChunks });
      } else if (msg.type === 'eof') {
        var inc = incoming[msg.transferId];
        if (!inc) return;
        for (var k = 0; k < inc.chunks.length; k++) {
          if (!inc.chunks[k]) inc.chunks[k] = new ArrayBuffer(0);
          else if (typeof Blob !== 'undefined' && inc.chunks[k] instanceof Blob) {
            try { inc.chunks[k] = await inc.chunks[k].arrayBuffer(); }
            catch (convErr) { inc.chunks[k] = new ArrayBuffer(0); }
          }
        }
        if (typeof msg.crc === 'number') {
          var check = 0xFFFFFFFF;
          for (var j = 0; j < inc.chunks.length; j++) {
            check = crc32Update(check, new Uint8Array(inc.chunks[j]));
          }
          check = (check ^ 0xFFFFFFFF) >>> 0;
          if (check !== (msg.crc >>> 0)) {
            delete incoming[msg.transferId];
            emit('error', { message: 'corrupt', name: inc.meta.name, transferId: msg.transferId });
            return;
          }
        }
        try {
          var blob = new Blob(inc.chunks, { type: inc.meta.mime || 'application/octet-stream' });
          var url = URL.createObjectURL(blob);
          emit('file-received', {
            transferId: msg.transferId,
            name: inc.meta.name,
            size: inc.meta.size,
            mime: inc.meta.mime,
            url: url,
            blob: blob
          });
          try {
            var ackCh = (ch && ch.readyState === 'open') ? ch : null;
            if (!ackCh && dc && dc.readyState === 'open') ackCh = dc;
            if (ackCh) ackCh.send(JSON.stringify({ type: 'received', transferId: msg.transferId }));
          } catch (ackErr) {}
        } catch (err) {
          emit('error', { message: 'assemble_failed', transferId: msg.transferId });
        }
        delete incoming[msg.transferId];
        if (ch) ch._transferId = null;
      } else if (msg.type === 'text') {
        emit('text-received', { transferId: msg.transferId, text: msg.text || '', ts: msg.ts || Date.now() });
      } else if (msg.type === 'extend') {
        var mins = (typeof msg.minutes === 'number' && msg.minutes > 0 && msg.minutes <= 30) ? msg.minutes : 5;
        emit('extend-received', { minutes: mins });
      } else if (msg.type === 'ping' && typeof msg.t === 'number') {
        try { dc.send(JSON.stringify({ type: 'pong', t: msg.t })); } catch (e) {}
      } else if (msg.type === 'pong' && typeof msg.t === 'number') {
        var rtt = Date.now() - msg.t;
        if (rtt >= 0 && rtt < 60000) lastRtt = rtt;
      } else if (msg.type === 'received' && typeof msg.transferId === 'string') {
        emit('peer-received', { transferId: msg.transferId });
      } else if (msg.type === 'abort' && typeof msg.transferId === 'string') {
        if (activeSends[msg.transferId]) {
          activeSends[msg.transferId].item.cancelled = 'remote';
          settleWaiter(activeSends[msg.transferId].ch);
        } else if (incoming[msg.transferId]) {
          delete incoming[msg.transferId];
          emit('recv-aborted', { transferId: msg.transferId });
        }
      } else if (msg.type === 'teardown') {
        emit('teardown', {});
        await disconnect(false);
      }
      return;
    }
    var buf = e.data;
    var byteLen = buf ? (buf.byteLength || buf.size || 0) : 0;
    bytesRecvWindow.push({ t: now, n: byteLen });
    var targetId = null;
    if (ch && ch._transferId && incoming[ch._transferId] && incoming[ch._transferId].received < incoming[ch._transferId].meta.totalChunks) {
      targetId = ch._transferId;
    } else {
      for (var id in incoming) {
        if (incoming[id].received < incoming[id].meta.totalChunks) { targetId = id; break; }
      }
    }
    if (!targetId) return;
    var rec = incoming[targetId];
    if (rec.received >= rec.meta.totalChunks) return;
    rec.chunks[rec.received] = buf;
    rec.received++;
    rec.receivedBytes += byteLen;
    rec.lastProgress = Date.now();
    var rnow = Date.now();
    if (rnow - rec.lastEmit >= 100 || rec.received >= rec.meta.totalChunks) {
      rec.lastEmit = rnow;
      emit('recv-progress', {
        transferId: targetId,
        name: rec.meta.name,
        received: rec.receivedBytes,
        size: rec.meta.size,
        chunks: rec.received,
        totalChunks: rec.meta.totalChunks,
        rate: windowRate(bytesRecvWindow, rnow),
        elapsed: (rnow - rec.startedAt) / 1000
      });
    }
  }

  async function handleDisconnect() {
    if (closed || !pc) return;
    if (reconnectTimer) return;
    emit('reconnecting', {});
    if (role === 'host') {
      try {
        var offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        lastOfferSent = null;
        pollOnceSoon();
      } catch (e) {}
    }
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (!pc) return;
      var st = pc.iceConnectionState;
      if (st !== 'connected' && st !== 'completed') {
        emit('failed', { reason: 'reconnect_timeout', state: st });
      }
    }, RECONNECT_WINDOW_MS);
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(function () {
      if (closed || !dc || dc.readyState !== 'open') return;
      try { dc.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch (e) {}
    }, 2000);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function clearReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function reset() {
    stopPolling();
    clearReconnectTimer();
    stopPing();
    settleWaiter(dc);
    for (var ri = 0; ri < fileSlots.length; ri++) {
      if (fileSlots[ri]) settleWaiter(fileSlots[ri].ch);
    }
    lastRtt = 0;
    try { if (dc) dc.close(); } catch (e) {}
    for (var si = 0; si < fileSlots.length; si++) {
      try { if (fileSlots[si] && fileSlots[si].ch) fileSlots[si].ch.close(); } catch (e) {}
    }
    fileSlots = [];
    try { if (pc) pc.close(); } catch (e) {}
    pc = null;
    dc = null;
    unsentCandidates = [];
    seenRemoteCands = {};
    appliedOfferSdp = null;
    appliedAnswerSdp = null;
    sendQueue = [];
    activeCount = 0;
    activeSends = {};
    incoming = Object.create(null);
    connectedFlag = false;
    lastOfferSent = null;
    lastAnswerSent = null;
    failCount = 0;
    signalGone = false;
    peerNew = false;
    statSentCands = 0;
    lastSendEmit = 0;
    loopSum = 0;
    loopN = 0;
    bytesSentWindow = [];
    bytesRecvWindow = [];
    closed = false;
  }

  async function createHost(pinCode) {
    reset();
    role = 'host';
    pin = pinCode;
    pc = new RTCPeerConnection(rtcConfig);
    wireConnectionEvents();
    dc = pc.createDataChannel('transferChannel', { ordered: true });
    wireChannel(dc);
    for (var fi = 0; fi < FILE_SLOTS; fi++) {
      wireFileChannel(pc.createDataChannel('file-' + fi, { ordered: true }), fi);
    }
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    startPolling();
    return true;
  }

  async function joinSession(pinCode) {
    reset();
    role = 'joiner';
    pin = pinCode;
    pc = new RTCPeerConnection(rtcConfig);
    wireConnectionEvents();
    pc.ondatachannel = function (e) {
      var label = (e.channel && e.channel.label) || '';
      if (label.indexOf('file-') === 0) {
        var idx = parseInt(label.slice(5), 10);
        if (idx >= 0 && idx < FILE_SLOTS) {
          wireFileChannel(e.channel, idx);
          return;
        }
      }
      dc = e.channel;
      wireChannel(dc);
    };
    startPolling();
    return true;
  }

  function freeSlot() {
    if (!peerNew) {
      if (dc && dc.readyState === 'open' && !dcPseudo.busy) {
        dcPseudo.ch = dc;
        dcPseudo.open = true;
        return dcPseudo;
      }
      return null;
    }
    var fallback = null;
    for (var i = 0; i < fileSlots.length; i++) {
      var slot = fileSlots[i];
      if (slot && slot.open && !slot.busy) {
        if (!slot.stalls) return slot;
        if (!fallback) fallback = slot;
      }
    }
    if (fallback) return fallback;
    if (fileSlots.length === 0 && dc && dc.readyState === 'open' && !dcPseudo.busy) {
      dcPseudo.ch = dc;
      dcPseudo.open = true;
      return dcPseudo;
    }
    return null;
  }

  function dispatchQueue() {
    if (closed || !dc) return;
    if (dc.readyState !== 'open') return;
    var slot = freeSlot();
    while (sendQueue.length > 0 && slot) {
      if (closed) break;
      var item = sendQueue.shift();
      slot.busy = true;
      slot.transferId = item.transferId;
      activeSends[item.transferId] = { item: item, ch: slot.ch };
      activeCount++;
      (function (it, sl) {
        sendOneFile(it, sl.ch).then(function () {
          activeCount = Math.max(0, activeCount - 1);
        }).catch(function (err) {
          activeCount = Math.max(0, activeCount - 1);
          if (err && err.message === 'cancelled') {
            if (closed) { /* session torn down: quiet */ }
            else {
              sendAbort(it.transferId);
              emit('error', { message: 'send-cancelled', name: it.file.name, transferId: it.transferId, remote: !!(err && err.remote) });
            }
          } else if (!closed && err && err.message === 'stalled' && (it.retries | 0) < 2) {
            sl.stalls = (sl.stalls | 0) + 1;
            sendAbort(it.transferId);
            sendQueue.unshift({ file: it.file, transferId: uuid(), forceCs: 16384, retries: (it.retries | 0) + 1 });
            emit('error', { message: 'send-stalled', name: it.file.name, transferId: it.transferId });
          } else if (!closed) {
            emit('error', { message: 'send_failed', name: it.file.name, transferId: it.transferId, detail: (err && err.message) || 'unknown' });
          }
        }).then(function () {
          delete activeSends[it.transferId];
          sl.busy = false;
          sl.transferId = null;
          if (sendQueue.length === 0 && activeCount === 0) emit('queue-drained', {});
          dispatchQueue();
        });
      })(item, slot);
      slot = freeSlot();
    }
  }

  function processQueue() {
    dispatchQueue();
  }

  function pickChunkSize(force) {
    if (typeof force === 'number' && (force | 0) === force && force >= 4096 && force <= 1048576) return force;
    if (!peerNew) return CHUNK_SIZE;
    try {
      var m = pc && pc.sctp ? pc.sctp.maxMessageSize : 0;
      if (typeof m === 'number' && m >= 262144) return 261120;
      if (typeof m === 'number' && m >= 131072) return 131072;
    } catch (e) {}
    return CHUNK_SIZE;
  }

  function sendAbort(transferId) {
    var msg = JSON.stringify({ type: 'abort', transferId: transferId });
    try { if (dc && dc.readyState === 'open') dc.send(msg); } catch (e) {}
    for (var i = 0; i < fileSlots.length; i++) {
      try {
        var c = fileSlots[i] && fileSlots[i].ch;
        if (c && c.readyState === 'open') c.send(msg);
      } catch (e) {}
    }
  }

  async function sendOneFile(item, ch) {
    var file = item.file;
    var transferId = item.transferId;
    if (!ch) ch = dc;
    var cs = pickChunkSize(item.forceCs);
    var totalChunks = Math.max(1, Math.ceil(file.size / cs));
    var meta = {
      type: 'meta',
      transferId: transferId,
      kind: 'file',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      totalChunks: totalChunks,
      chunkSize: cs
    };
    ch.send(JSON.stringify(meta));
    emit('send-start', { transferId: transferId, name: file.name, size: file.size, totalChunks: totalChunks });
    var offset = 0;
    var idx = 0;
    var fileCrc = 0xFFFFFFFF;
    var startedAt = Date.now();
    while (offset < file.size) {
      if (closed) throw new Error('closed');
      if (item.cancelled) throw { message: 'cancelled', fileName: file.name, remote: item.cancelled === 'remote' };
      var stuckMs = 0;
      while (ch.bufferedAmount > HIGH_WATER) {
        var before = ch.bufferedAmount;
        var drained = await new Promise(function (resolve) {
          var done = false;
          var timer = setTimeout(function () {
            if (done) return;
            done = true;
            resolve(false);
          }, 3000);
          waitForDrain(ch).then(function () {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(true);
          });
        });
        if (drained) break;
        if (ch.bufferedAmount < before) { stuckMs = 0; continue; }
        stuckMs += 3000;
        if (stuckMs >= 15000) {
          if (ch._resumeSend) ch._resumeSend = null;
          throw { message: 'stalled', fileName: file.name };
        }
      }
      if (item.cancelled) throw { message: 'cancelled', fileName: file.name, remote: item.cancelled === 'remote' };
      if (closed || !ch || ch.readyState !== 'open') throw new Error('closed');
      var jsMark = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      var end = Math.min(offset + cs, file.size);
      var slice = file.slice(offset, end);
      var buf = await Promise.race([
        slice.arrayBuffer(),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('read-timeout')); }, 30000);
        })
      ]);
      ch.send(buf);
      offset = end;
      idx++;
      fileCrc = crc32Update(fileCrc, new Uint8Array(buf));
      var now = Date.now();
      bytesSentWindow.push({ t: now, n: buf.byteLength });
      loopSum += now - jsMark;
      loopN++;
      if (now - lastSendEmit >= 100 || offset >= file.size) {
        lastSendEmit = now;
        emit('send-progress', {
          transferId: transferId,
          name: file.name,
          sent: offset,
          size: file.size,
          chunks: idx,
          totalChunks: totalChunks,
          rate: windowRate(bytesSentWindow, now),
          elapsed: (now - startedAt) / 1000
        });
      }
      if ((idx & 31) === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
    if (file.size === 0) {
      ch.send(new ArrayBuffer(0));
    }
    ch.send(JSON.stringify({ type: 'eof', transferId: transferId, crc: (fileCrc ^ 0xFFFFFFFF) >>> 0 }));
    emit('send-done', { transferId: transferId, name: file.name, size: file.size, elapsed: (Date.now() - startedAt) / 1000 });
  }

  function sendText(text) {
    if (typeof text !== 'string' || text === '') return false;
    if (text.length > 262144) return 'too_large';
    if (!dc || dc.readyState !== 'open') {
      emit('error', { message: 'not_connected' });
      return false;
    }
    dc.send(JSON.stringify({ type: 'text', transferId: uuid(), text: text, ts: Date.now() }));
    emit('text-sent', { text: text });
    return true;
  }

  function sendExtend(minutes) {
    if (!dc || dc.readyState !== 'open') return false;
    try {
      dc.send(JSON.stringify({ type: 'extend', minutes: minutes, ts: Date.now() }));
    } catch (e) {
      return false;
    }
    return true;
  }

  function sendFiles(fileList) {
    if (!dc || closed || dc.readyState === 'closed' || dc.readyState === 'closing') {
      emit('error', { message: 'not_connected' });
      return false;
    }
    var files = Array.prototype.slice.call(fileList || []);
    for (var i = 0; i < files.length; i++) {
      sendQueue.push({ file: files[i], transferId: uuid() });
    }
    processQueue();
    return true;
  }

  async function disconnect(sendTeardown) {
    if (sendTeardown === undefined) sendTeardown = true;
    if (sendTeardown && dc && dc.readyState !== 'closed' && dc.readyState !== 'closing') {
      var openWaited = 0;
      while (dc.readyState !== 'open' && openWaited < 1000) {
        await new Promise(function (r) { setTimeout(r, 50); });
        openWaited += 50;
      }
    }
    if (sendTeardown && dc && dc.readyState === 'open') {
      try { dc.send(JSON.stringify({ type: 'teardown' })); } catch (e) {}
      var waited = 0;
      while (dc.bufferedAmount > 0 && waited < 2000) {
        await new Promise(function (r) { setTimeout(r, 50); });
        waited += 50;
      }
    }
    closed = true;
    stopPolling();
    stopPing();
    clearReconnectTimer();
    settleWaiter(dc);
    for (var si = 0; si < fileSlots.length; si++) {
      if (fileSlots[si]) settleWaiter(fileSlots[si].ch);
    }
    sendQueue = [];
    activeCount = 0;
    activeSends = {};
    incoming = Object.create(null);
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    connectedFlag = false;
    emit('disconnected', {});
  }

  function cancelTransfer(id) {
    if (!id) return false;
    for (var i = 0; i < sendQueue.length; i++) {
      if (sendQueue[i].transferId === id) {
        sendQueue.splice(i, 1);
        return true;
      }
    }
    if (activeSends[id]) {
      activeSends[id].item.cancelled = true;
      settleWaiter(activeSends[id].ch);
      return true;
    }
    if (incoming[id]) {
      delete incoming[id];
      sendAbort(id);
      return true;
    }
    return false;
  }

  function transferInProgress() {
    return activeCount > 0 || sendQueue.length > 0 || Object.keys(incoming).length > 0;
  }

  function debug() {
    return {
      role: role,
      pin: pin,
      ice: pc ? pc.iceConnectionState : '-',
      conn: pc ? pc.connectionState : '-',
      dc: dc ? dc.readyState : '-',
      sig: signalGone ? 'gone' : 'live',
      fast: peerNew,
      fast: peerNew,
      rtt: lastRtt,
      loopMs: loopN ? Math.round((loopSum / loopN) * 100) / 100 : 0,
      maxMsg: (pc && pc.sctp) ? pc.sctp.maxMessageSize : 0,
      fails: failCount,
      sentCands: statSentCands,
      gotCands: Object.keys(seenRemoteCands).length
    };
  }

  return {
    on: function (fn) { handlers.push(fn); },
    createHost: createHost,
    joinSession: joinSession,
    sendText: sendText,
    cancelTransfer: cancelTransfer,
    sendExtend: sendExtend,
    sendFiles: sendFiles,
    disconnect: disconnect,
    transferInProgress: transferInProgress,
    debug: debug,
    isConnected: function () { return connectedFlag; },
    getInfo: function () { return { role: role, pin: pin }; }
  };
})();
