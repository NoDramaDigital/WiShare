window.P2P = (function () {
  var rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
  };
  var CHUNK_SIZE = 65536;
  var LOW_THRESHOLD = 1048576;
  var HIGH_WATER = 8388608;
  var POLL_MS = 1100;
  var RECONNECT_WINDOW_MS = 30000;

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
  var sending = false;
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
    pollActive = true;
    try {
      var out = { role: role };
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

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  async function applyRemoteState(state) {
    if (closed) return;
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
    };
    ch.onclose = function () {
      emit('channel-close', {});
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
    ch.onmessage = handleMessage;
  }

  function waitForDrain(ch) {
    return new Promise(function (resolve) {
      if (ch.bufferedAmount <= LOW_THRESHOLD) return resolve();
      ch._resumeSend = resolve;
    });
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

  async function handleMessage(e) {
    var now = Date.now();
    if (typeof e.data === 'string') {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg.type === 'meta' && msg.kind === 'file') {
        if (typeof msg.transferId !== 'string' || msg.transferId === '' || msg.transferId.length > 80) return;
        if (typeof msg.size !== 'number' || !(msg.size >= 0) || msg.size > 21474836480) return;
        if (typeof msg.totalChunks !== 'number' || (msg.totalChunks | 0) !== msg.totalChunks) return;
        if (typeof msg.name !== 'string' || msg.name === '' || msg.name.length > 255) return;
        var expect = Math.max(1, Math.ceil(msg.size / CHUNK_SIZE));
        if (msg.totalChunks !== expect || msg.totalChunks > 350000) return;
        incoming[msg.transferId] = {
          meta: msg,
          chunks: new Array(msg.totalChunks),
          received: 0,
          receivedBytes: 0,
          startedAt: now
        };
        emit('recv-start', { transferId: msg.transferId, name: msg.name, size: msg.size, mime: msg.mime, totalChunks: msg.totalChunks });
      } else if (msg.type === 'eof') {
        var inc = incoming[msg.transferId];
        if (!inc) return;
        for (var k = 0; k < inc.chunks.length; k++) {
          if (!inc.chunks[k]) inc.chunks[k] = new ArrayBuffer(0);
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
        } catch (err) {
          emit('error', { message: 'assemble_failed' });
        }
        delete incoming[msg.transferId];
      } else if (msg.type === 'text') {
        emit('text-received', { transferId: msg.transferId, text: msg.text || '', ts: msg.ts || Date.now() });
      } else if (msg.type === 'extend') {
        var mins = (typeof msg.minutes === 'number' && msg.minutes > 0 && msg.minutes <= 30) ? msg.minutes : 5;
        emit('extend-received', { minutes: mins });
      } else if (msg.type === 'teardown') {
        emit('teardown', {});
        await disconnect(false);
      }
      return;
    }
    var buf = e.data;
    var byteLen = buf ? buf.byteLength : 0;
    bytesRecvWindow.push({ t: now, n: byteLen });
    var targetId = null;
    for (var id in incoming) {
      if (incoming[id].received < incoming[id].meta.totalChunks) { targetId = id; break; }
    }
    if (!targetId) return;
    var rec = incoming[targetId];
    if (rec.received >= rec.meta.totalChunks) return;
    rec.chunks[rec.received] = buf;
    rec.received++;
    rec.receivedBytes += byteLen;
    emit('recv-progress', {
      transferId: targetId,
      name: rec.meta.name,
      received: rec.receivedBytes,
      size: rec.meta.size,
      chunks: rec.received,
      totalChunks: rec.meta.totalChunks,
      rate: windowRate(bytesRecvWindow, Date.now()),
      elapsed: (Date.now() - rec.startedAt) / 1000
    });
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

  function clearReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function reset() {
    stopPolling();
    clearReconnectTimer();
    try {
      if (dc && dc._resumeSend) {
        var pending = dc._resumeSend;
        dc._resumeSend = null;
        pending();
      }
    } catch (e) {}
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    pc = null;
    dc = null;
    unsentCandidates = [];
    seenRemoteCands = {};
    appliedOfferSdp = null;
    appliedAnswerSdp = null;
    sendQueue = [];
    sending = false;
    incoming = Object.create(null);
    connectedFlag = false;
    lastOfferSent = null;
    lastAnswerSent = null;
    failCount = 0;
    signalGone = false;
    statSentCands = 0;
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
      dc = e.channel;
      wireChannel(dc);
    };
    startPolling();
    return true;
  }

  async function processQueue() {
    if (sending || sendQueue.length === 0 || !dc) return;
    sending = true;
    while (sendQueue.length > 0) {
      if (closed || !dc || dc.readyState !== 'open') break;
      var item = sendQueue[0];
      try {
        await sendOneFile(item);
      } catch (e) {
        if (!closed) emit('error', { message: 'send_failed', name: item.file.name });
      }
      sendQueue.shift();
    }
    sending = false;
    emit('queue-drained', {});
  }

  async function sendOneFile(item) {
    var file = item.file;
    var transferId = item.transferId;
    var totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    var meta = {
      type: 'meta',
      transferId: transferId,
      kind: 'file',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      totalChunks: totalChunks
    };
    dc.send(JSON.stringify(meta));
    emit('send-start', { transferId: transferId, name: file.name, size: file.size, totalChunks: totalChunks });
    var offset = 0;
    var idx = 0;
    var startedAt = Date.now();
    while (offset < file.size) {
      if (closed) throw new Error('closed');
      while (dc.bufferedAmount > HIGH_WATER) {
        await waitForDrain(dc);
      }
      if (closed || !dc || dc.readyState !== 'open') throw new Error('closed');
      var end = Math.min(offset + CHUNK_SIZE, file.size);
      var slice = file.slice(offset, end);
      var buf = await slice.arrayBuffer();
      dc.send(buf);
      offset = end;
      idx++;
      var now = Date.now();
      bytesSentWindow.push({ t: now, n: buf.byteLength });
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
      await new Promise(function (r) { setTimeout(r, 0); });
    }
    if (file.size === 0) {
      dc.send(new ArrayBuffer(0));
    }
    dc.send(JSON.stringify({ type: 'eof', transferId: transferId }));
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
    if (!dc || dc.readyState !== 'open') {
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
    if (sendTeardown && dc && dc.readyState === 'open') {
      try { dc.send(JSON.stringify({ type: 'teardown' })); } catch (e) {}
    }
    closed = true;
    stopPolling();
    clearReconnectTimer();
    if (dc && dc._resumeSend) {
      var resume = dc._resumeSend;
      dc._resumeSend = null;
      try { resume(); } catch (e) {}
    }
    sendQueue = [];
    sending = false;
    incoming = Object.create(null);
    try { if (dc) dc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    connectedFlag = false;
    emit('disconnected', {});
  }

  function transferInProgress() {
    return sending || sendQueue.length > 0 || Object.keys(incoming).length > 0;
  }

  function debug() {
    return {
      role: role,
      pin: pin,
      ice: pc ? pc.iceConnectionState : '-',
      conn: pc ? pc.connectionState : '-',
      dc: dc ? dc.readyState : '-',
      sig: signalGone ? 'gone' : 'live',
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
    sendExtend: sendExtend,
    sendFiles: sendFiles,
    disconnect: disconnect,
    transferInProgress: transferInProgress,
    debug: debug,
    isConnected: function () { return connectedFlag; },
    getInfo: function () { return { role: role, pin: pin }; }
  };
})();
