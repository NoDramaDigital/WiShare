# WiShare — Local P2P File & Text Transfer

Ephemeral, bidirectional file and text transfer directly between browsers over local Wi-Fi using WebRTC. Payloads travel strictly peer-to-peer over `RTCDataChannel` — **nothing is ever uploaded to, routed through, or cached on the server**.

🚀 **Live version: https://nodrama.au/WiShare/**

## How it works

1. One device taps **Send / Host** and gets a 4-digit PIN (5-minute expiry, radial countdown).
2. The other device taps **Receive / Join**, enters the PIN, and a direct P2P link is negotiated.
3. Files and clipboard text flow both ways with live telemetry (%, bytes, elapsed, MB/s).

The server is purely an **ephemeral signaling broker**: short-polled PHP flat-file endpoints exchange SDP offers/answers and trickle ICE candidates, then session records self-destruct (5-minute auto-prune, instant cleanup on disconnect).

## Features

- 64 KB chunked binary streaming with 1 MB / 8 MB backpressure flow control (no tab crashes on large files)
- ICE restart with 30 s self-healing window (survives Wi-Fi toggles and backgrounded tabs)
- Drag-and-drop (Linux) + native picker (Android); gesture-only Download buttons, plus one-tap **Download all (.zip)**
- Text clipboard with copy buttons, per-entry delete, Ctrl+Enter to send
- 15-minute session guard with in-progress protection and +5 min coordinated extensions (3 per peer)
- Segmented PIN entry, rate-limited joins (5 fails → 15 min IP lockout), ambiguous-PIN filtering
- Installable PWA (offline shell, update prompts), dark/light auto + manual toggle, Screen Wake Lock on Android
- Incoming-transfer notification sound (mutable), connection diagnostics via tap on the status label

## Project layout

```text
├── api.php                  # Atomic signaling router, brute-force throttle, auto-prune
├── index.php                # App shell (Tailwind via CDN, jQuery, JSZip)
├── manifest.json            # PWA manifest
├── sw.js                    # Service worker (versioned precache)
├── sessions/                # Ephemeral JSON handshake files (deny-all via .htaccess)
└── assets/
    ├── audio/incoming.mp3   # Incoming-transfer chime
    ├── css/custom.css       # PIN inputs, animations, responsive app-shell
    ├── icons/               # PWA + Apple touch icons
    └── js/
        ├── app.js           # UI state machine, timers, clipboard, panes
        └── webrtc.js        # Peer lifecycle, chunking backpressure, ICE restart
```

## Deploy (cPanel / Apache / PHP 8.x, HTTPS required)

1. Upload everything, preserving the tree. Ensure PHP can write to `sessions/` (runs as your user on cPanel by default).
2. Confirm `https://<host>/sessions/` returns **403** (the bundled `.htaccess` denies all direct access).
3. Open the app on both devices on the **same Wi-Fi** (same band helps on routers with client isolation).

## Notes

- Same-network only by design: signaling uses public STUN (no TURN), so no server relay exists by choice.
- `sessions/ip_ratelimit.json` holds the brute-force counters; delete it server-side to instantly clear a lockout (entries otherwise expire automatically).
- Client assets are cache-busted (`?v=N` + versioned service-worker cache); footer shows the running build (`vN`) for support.

## Credit

- Created by [No Drama Digital](https://nodrama.au) - Websites without the drama.
