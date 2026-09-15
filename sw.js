var CACHE = 'wishare-v47';
var SHELL = [
  './',
  'index.php',
  'manifest.json',
  'assets/css/custom.css?v=47',
  'assets/js/app.js?v=47',
  'assets/js/webrtc.js?v=47',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/audio/incoming.mp3'
];
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })
  );
});
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      var stale = keys.filter(function (k) { return k !== CACHE; });
      return Promise.all(stale.map(function (k) { return caches.delete(k); })).then(function () { return stale.length > 0; });
    }).then(function (replaced) {
      return self.clients.claim().then(function () {
        if (!replaced) return;
        return self.clients.matchAll({ type: 'window' }).then(function (clients) {
          clients.forEach(function (client) { client.postMessage({ type: 'sw-updated' }); });
        });
      });
    })
  );
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.indexOf('api.php') !== -1 || url.pathname.indexOf('/sessions/') !== -1) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('index.php', copy); });
        return res;
      }).catch(function () {
        return caches.match('index.php').then(function (r) { return r || caches.match('./'); });
      })
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      });
    })
  );
});
