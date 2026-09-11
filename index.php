<?php
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#10b981">
<meta name="description" content="Ephemeral P2P file and text transfer over local Wi-Fi. Data never touches the server.">
<title>WiShare — Local P2P Transfer</title>
<link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" href="assets/icons/apple-180.png">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9A%A1%3C/text%3E%3C/svg%3E">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = { darkMode: 'class' };
try {
  var stored = localStorage.getItem('wishare-theme');
  if (stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
} catch (e) {}
</script>
<script src="https://code.jquery.com/jquery-3.7.1.min.js" integrity="sha384-1H217gwSVyLSIfaLxHbE7dRb3v4mYCKbpQvzx0cegeju1MVsGrX5xXxAvs/HgeFs" crossorigin="anonymous"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js" integrity="sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG" crossorigin="anonymous"></script>
<link rel="stylesheet" href="assets/css/custom.css?v=22">
</head>
<body class="h-svh text-slate-900 dark:text-slate-100 flex flex-col bg-decor">
<header class="shrink-0 sticky top-0 z-40 border-b border-slate-200/70 dark:border-slate-800/70 bg-white/80 dark:bg-slate-950/80 backdrop-blur px-4 py-3 flex items-center justify-between">
<div class="flex items-center gap-2.5">
<span class="logo-badge">⚡</span>
<div>
<h1 class="font-extrabold leading-none tracking-tight">WiShare</h1>
<p class="text-[11px] opacity-60">Local P2P · zero server footprint</p>
</div>
</div>
<div class="flex items-center gap-2">
<div class="status-pill" title="Connection status">
<span id="conn-dot-top" class="inline-block w-2.5 h-2.5 rounded-full bg-slate-400"></span>
<span id="conn-label-top" class="hidden sm:inline text-xs font-semibold opacity-70">Lobby</span>
</div>
<button id="theme-toggle" class="icon-btn" aria-label="Toggle dark mode" title="Toggle dark mode">🌙</button>
<button id="btn-install" class="hidden install-btn" aria-label="Install app" title="Install app">⬇️ Install</button>
</div>
</header>

<main class="flex-1 overflow-y-auto">
<div class="app-shell">

<section id="view-lobby" class="view space-y-8">
<div class="text-center pt-4 sm:pt-8">
<div class="hero-badge">🔒 HTTPS · WebRTC · No uploads</div>
<h2 class="mt-4 text-4xl sm:text-5xl font-black tracking-tight leading-tight">Send files over<br><span class="grad-text">local Wi-Fi</span>, instantly.</h2>
<p class="mt-3 text-sm sm:text-base opacity-70 max-w-xl mx-auto">Host on one device, join on the other. Files and text flow directly browser-to-browser. Nothing is ever uploaded to the server.</p>
</div>
<div class="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-4xl mx-auto">
<button id="btn-host" class="role-card role-host group">
<span class="role-emoji">📤</span>
<span class="block mt-3 text-xl font-extrabold">Send / Host</span>
<span class="block mt-1 text-sm opacity-80">This device shares → get a 4-digit PIN</span>
<span class="role-cta">Get a PIN →</span>
</button>
<button id="btn-join" class="role-card role-join group">
<span class="role-emoji">📥</span>
<span class="block mt-3 text-xl font-extrabold">Receive / Join</span>
<span class="block mt-1 text-sm opacity-80">The other device shares → enter its PIN</span>
<span class="role-cta">Enter PIN →</span>
</button>
</div>
<ol class="steps">
<li><span class="step-n">1</span><div><strong>Host</strong><span>Tap Send on one device to get a PIN.</span></div></li>
<li><span class="step-n">2</span><div><strong>Join</strong><span>Type the PIN on the other device.</span></div></li>
<li><span class="step-n">3</span><div><strong>Transfer</strong><span>Swap files and text both ways.</span></div></li>
</ol>
<ul class="trust-list">
<li>✓ Same Wi-Fi required · HTTPS only</li>
<li>✓ Works with Brave Shields up · no extensions</li>
<li>✓ Keep this tab visible on Android during transfers</li>
</ul>
<div class="text-center">
<a href="https://github.com/NoDramaDigital/WiShare" target="_blank" rel="noopener" class="github-link" aria-label="View source on GitHub">
<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
<span>GitHub</span>
</a>
</div>
</section>

<section id="view-host" class="hidden view">
<div class="card text-center space-y-5">
<p class="eyebrow">Share this PIN with the other device</p>
<div class="flex items-center justify-center gap-3">
<div id="host-pin" class="host-pin-display text-6xl sm:text-7xl font-black">····</div>
<button id="btn-copy-pin" class="icon-btn text-lg" aria-label="Copy PIN" title="Copy PIN">📋</button>
</div>
<div class="flex justify-center">
<svg width="140" height="140" viewBox="0 0 120 120" role="img" aria-label="PIN expiry countdown">
<circle class="ring-bg" cx="60" cy="60" r="54" fill="none" stroke-width="10"></circle>
<circle id="host-ring-fg" class="ring-fg" cx="60" cy="60" r="54" fill="none" stroke="#10b981" stroke-width="10" stroke-linecap="round" stroke-dasharray="339.29" stroke-dashoffset="0" transform="rotate(-90 60 60)"></circle>
<text id="host-countdown-text" x="60" y="68" text-anchor="middle" font-size="24" font-weight="800" fill="currentColor">5:00</text>
</svg>
</div>
<p class="waiting-dots text-sm opacity-70">Waiting for peer… keep this screen open</p>
<button data-back class="btn-ghost">← Back</button>
</div>
</section>

<section id="view-join" class="hidden view">
<div class="card text-center space-y-5">
<p class="eyebrow">Enter 4-digit PIN</p>
<div class="flex justify-center gap-2 sm:gap-3" role="group" aria-label="PIN entry">
<input class="pin-box" inputmode="numeric" autocomplete="one-time-code" maxlength="1" aria-label="Digit 1">
<input class="pin-box" inputmode="numeric" maxlength="1" aria-label="Digit 2">
<input class="pin-box" inputmode="numeric" maxlength="1" aria-label="Digit 3">
<input class="pin-box" inputmode="numeric" maxlength="1" aria-label="Digit 4">
</div>
<p id="join-error" class="hidden text-sm font-semibold text-red-500"></p>
<p class="text-xs opacity-60">Ask the sharing device for its PIN. submits automatically.</p>
<button data-back class="btn-ghost">← Back</button>
</div>
</section>

<section id="view-app" class="hidden view">
<div class="card p-4 flex flex-wrap items-center gap-2.5">
<div class="flex items-center gap-2 text-sm font-bold">
<span id="conn-dot" class="inline-block w-3 h-3 rounded-full bg-amber-500 pulse-dot"></span>
<span id="conn-label" class="cursor-pointer" title="Tap for connection diagnostics">Connecting…</span>
</div>
<span id="workspace-pin" class="chip">PIN ----</span>
<span id="workspace-role" class="chip chip-green">Host</span>
<div class="ml-auto flex items-center gap-2 flex-wrap justify-end">
<div id="session-guard" class="flex items-center gap-1.5 text-sm rounded-xl px-3 py-1.5 bg-slate-100 dark:bg-slate-800" title="Session time remaining">
<span>⏱</span><span id="session-timer" class="font-mono font-bold">15:00</span>
</div>
<button id="btn-extend" class="text-xs font-bold px-3 py-2 rounded-xl border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950 active:scale-95 transition" title="Extend session by 5 minutes (up to 3 times each)">+5 min</button>
<button id="btn-sound" class="icon-btn" aria-label="Toggle notification sound" title="Notification sound">🔔</button>
<button id="btn-end" class="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-bold shadow active:scale-95 transition">End Session</button>
</div>
<p id="debug-line" class="hidden w-full text-[11px] font-mono opacity-70 break-words"></p>
</div>

<div id="tx-wrap" class="hidden card p-4">
<p class="label-row"><span>📤 Sending</span></p>
<div class="progress-track h-7 rounded-xl bg-slate-100 dark:bg-slate-800">
<div id="tx-bar" class="progress-fill progress-send" style="width:0%">0%</div>
</div>
<p id="tx-meta" class="mt-1.5 text-xs font-mono opacity-70"></p>
</div>

<div id="rx-wrap" class="hidden card p-4">
<p class="label-row"><span>📥 Receiving</span></p>
<div class="progress-track h-7 rounded-xl bg-slate-100 dark:bg-slate-800">
<div id="rx-bar" class="progress-fill progress-recv" style="width:0%">0%</div>
</div>
<p id="rx-meta" class="mt-1.5 text-xs font-mono opacity-70"></p>
</div>

<div class="pane-tabs md:hidden" role="tablist" aria-label="Workspace panes">
<button id="btn-tab-text" class="pane-tab active" role="tab" aria-selected="true">💬 Text</button>
<button id="btn-tab-files" class="pane-tab" role="tab" aria-selected="false">📁 Files</button>
</div>

<div class="workspace-grid grid grid-cols-1 md:grid-cols-2 gap-4">
<div id="pane-text" class="card active-pane p-4 space-y-3">
<div class="flex items-center justify-between gap-2">
<h3 class="pane-title">💬 Text clipboard</h3>
<button id="btn-text-expand" class="icon-btn expand-btn" aria-label="Expand text box" aria-expanded="false" title="Expand text box">⤢</button>
</div>
<textarea id="text-input" rows="3" placeholder="Type message… Enter for newline, Ctrl+Enter to send" class="field"></textarea>
<button id="btn-send-text" class="btn-primary">Send text</button>
<div id="text-list" class="scroll-list">
<p id="text-empty" class="empty-note">Incoming text appears here.</p>
</div>
</div>

<div id="pane-files" class="card p-4 space-y-3">
<div class="flex items-center justify-between gap-2">
<h3 class="pane-title">📁 Files</h3>
<button id="btn-zip-all" class="hidden shrink-0 text-xs font-bold px-3 py-2 rounded-xl bg-emerald-600 text-white shadow hover:bg-emerald-500 active:scale-95 transition">⬇ Download all (.zip)</button>
</div>
<div id="dropzone" class="dropzone">
<p class="font-semibold">Drag &amp; drop files here</p>
<p class="text-xs opacity-60 mt-1">Linux drag-and-drop · Android button below</p>
</div>
<input id="file-input" type="file" multiple class="hidden">
<button id="btn-pick-files" class="btn-dark">Choose files</button>
<div id="file-list" class="scroll-list">
<p id="file-empty" class="empty-note">Received files appear here — tap Download explicitly on Android.</p>
</div>
</div>
</div>
</section>

</div>
</main>

<footer id="app-footer" class="shrink-0 border-t border-slate-200/70 dark:border-slate-800/70 px-4 py-3 text-center text-[11px] opacity-50">
Ephemeral by design — signaling records self-destruct · payloads never touch this server.<br><span id="app-ver" class="font-mono"></span>
</footer>

<div id="toast" class="hidden" role="status" aria-live="polite"></div>

<script src="assets/js/webrtc.js?v=22"></script>
<script src="assets/js/app.js?v=22"></script>
</body>
</html>
