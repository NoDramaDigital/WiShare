<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

const SESS_DIR = __DIR__ . '/sessions';
const RATE_FILE = __DIR__ . '/sessions/ip_ratelimit.json';
const SESSION_TTL = 300;
const LOCKOUT_WINDOW = 900;
const MAX_FAILS = 5;

if (!is_dir(SESS_DIR)) {
    @mkdir(SESS_DIR, 0700, true);
}

function jexit(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}

function clientIp(): string {
    if (!empty($_SERVER['HTTP_CF_CONNECTING_IP'])) return (string)$_SERVER['HTTP_CF_CONNECTING_IP'];
    return (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

function pruneSessions(): void {
    foreach ((array)glob(SESS_DIR . '/sess_*.json') as $f) {
        $raw = @file_get_contents($f);
        if ($raw === false) continue;
        $d = json_decode($raw, true);
        if (!is_array($d) || !isset($d['created_at'])) {
            @unlink($f);
            continue;
        }
        if ((time() - (int)$d['created_at']) > SESSION_TTL) {
            @unlink($f);
        }
    }
}

function validPinFormat(?string $pin): bool {
    return is_string($pin) && preg_match('/^[0-9]{4}$/', $pin) === 1;
}

function isAmbiguousPin(string $pin): bool {
    if (preg_match('/^(\d)\1{3}$/', $pin) === 1) return true;
    $blocked = ['1234','2345','3456','4567','5678','6789','9876','8765','7654','6543','5432','4321','0123','3210','1212','6969','0000'];
    if (in_array($pin, $blocked, true)) return true;
    $d = array_map('intval', str_split($pin));
    $asc = ($d[1]-$d[0]===1 && $d[2]-$d[1]===1 && $d[3]-$d[2]===1);
    $desc = ($d[0]-$d[1]===1 && $d[1]-$d[2]===1 && $d[2]-$d[3]===1);
    if ($asc || $desc) return true;
    return false;
}

function genPin(): string {
    for ($i = 0; $i < 100; $i++) {
        $pin = (string)random_int(1000, 9999);
        if (isAmbiguousPin($pin)) continue;
        if (file_exists(SESS_DIR . '/sess_' . $pin . '.json')) continue;
        return $pin;
    }
    $tries = 0;
    do {
        $pin = (string)random_int(1000, 9999);
        $tries++;
    } while (file_exists(SESS_DIR . '/sess_' . $pin . '.json') && $tries < 1000);
    return $pin;
}

function sessionPath(string $pin): string {
    return SESS_DIR . '/sess_' . $pin . '.json';
}

function atomicUpdate(string $pin, callable $fn) {
    $path = sessionPath($pin);
    $fp = @fopen($path, 'r+b');
    if ($fp === false) return null;
    try {
        if (!flock($fp, LOCK_EX)) {
            fclose($fp);
            return null;
        }
        rewind($fp);
        $raw = stream_get_contents($fp);
        $data = ($raw === false || $raw === '') ? null : json_decode($raw, true);
        if (!is_array($data)) {
            flock($fp, LOCK_UN);
            fclose($fp);
            return null;
        }
        $result = $fn($data);
        if ($result === false) {
            flock($fp, LOCK_UN);
            fclose($fp);
            return $data;
        }
        if (is_array($result)) $data = $result;
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, (string)json_encode($data, JSON_UNESCAPED_SLASHES));
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
        return $data;
    } catch (Throwable $e) {
        @flock($fp, LOCK_UN);
        @fclose($fp);
        return null;
    }
}

function readSessionLocked(string $path): ?array {
    $fp = @fopen($path, 'r');
    if ($fp === false) return null;
    $data = null;
    if (flock($fp, LOCK_SH)) {
        $raw = stream_get_contents($fp);
        flock($fp, LOCK_UN);
        if (is_string($raw) && $raw !== '') $data = json_decode($raw, true);
    }
    fclose($fp);
    return is_array($data) ? $data : null;
}

function loadRate(): array {
    $raw = @file_get_contents(RATE_FILE);
    if (!is_string($raw) || $raw === '') return [];
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}

function isLocked(string $ip, array $rate): bool {
    if (!isset($rate[$ip]['locked_until'])) return false;
    return ((int)$rate[$ip]['locked_until']) > time();
}

function rateTransaction(callable $fn) {
    $fp = @fopen(RATE_FILE, 'c+');
    if ($fp === false) return null;
    $out = null;
    if (flock($fp, LOCK_EX)) {
        rewind($fp);
        $raw = stream_get_contents($fp);
        $d = (is_string($raw) && $raw !== '') ? json_decode($raw, true) : [];
        if (!is_array($d)) $d = [];
        $now = time();
        foreach ($d as $k => $v) {
            if (!is_array($v)) { unset($d[$k]); continue; }
            $lockedUntil = (int)($v['locked_until'] ?? 0);
            $attempts = array_values(array_filter(
                (array)($v['attempts'] ?? []),
                fn($t) => ($now - (int)$t) < LOCKOUT_WINDOW
            ));
            if ($lockedUntil <= $now && count($attempts) === 0) { unset($d[$k]); continue; }
            $d[$k]['attempts'] = $attempts;
        }
        if (count($d) > 1000) {
            $d = array_slice($d, -1000, null, true);
        }
        $res = $fn($d, $now);
        if (is_array($res) && isset($res[0]) && is_array($res[0])) {
            $d = $res[0];
            $out = $res[1] ?? null;
        } else {
            $out = $res;
        }
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, (string)json_encode($d, JSON_UNESCAPED_SLASHES));
        fflush($fp);
        flock($fp, LOCK_UN);
    }
    fclose($fp);
    return $out;
}

function recordFail(string $ip): int {
    $res = rateTransaction(function (array $d, int $now) use ($ip) {
        $entry = $d[$ip] ?? ['attempts' => [], 'locked_until' => 0];
        $entry['attempts'][] = $now;
        if (count($entry['attempts']) >= MAX_FAILS) {
            $entry['locked_until'] = $now + LOCKOUT_WINDOW;
        }
        $d[$ip] = $entry;
        return [$d, count($entry['attempts'])];
    });
    return is_int($res) ? $res : MAX_FAILS;
}

const PROBE_MAX = 30;
const PROBE_WINDOW = 300;
const PROBE_LOCK = 300;

function probeKey(string $ip): string {
    return 'probe:' . $ip;
}

function isProbeLocked(string $ip, array $rate): bool {
    $k = probeKey($ip);
    if (!isset($rate[$k]['locked_until'])) return false;
    return ((int)$rate[$k]['locked_until']) > time();
}

function recordProbe(string $ip): void {
    rateTransaction(function (array $d, int $now) use ($ip) {
        $k = probeKey($ip);
        $entry = $d[$k] ?? ['attempts' => [], 'locked_until' => 0];
        $attempts = array_values(array_filter(
            (array)($entry['attempts'] ?? []),
            fn($t) => ($now - (int)$t) < PROBE_WINDOW
        ));
        $attempts[] = $now;
        $entry['attempts'] = $attempts;
        if (count($attempts) >= PROBE_MAX) {
            $entry['locked_until'] = $now + PROBE_LOCK;
        }
        $d[$k] = $entry;
        return [$d, true];
    });
}

function clearFails(string $ip): void {
    rateTransaction(function (array $d) use ($ip) {
        unset($d[$ip]);
        return [$d, true];
    });
}

function createLimited(string $ip): bool {
    $res = rateTransaction(function (array $d, int $now) use ($ip) {
        $key = 'create:' . $ip;
        $entry = $d[$key] ?? ['attempts' => [], 'locked_until' => 0];
        $attempts = array_values(array_filter(
            (array)($entry['attempts'] ?? []),
            fn($t) => ($now - (int)$t) < 300
        ));
        if (count($attempts) >= 10) {
            return [$d, true];
        }
        $attempts[] = $now;
        $entry['attempts'] = $attempts;
        $d[$key] = $entry;
        return [$d, false];
    });
    return $res === true;
}

function candKey(array $c): string {
    return ($c['candidate'] ?? '') . '|' . ($c['sdpMid'] ?? '') . '|' . ($c['sdpMLineIndex'] ?? '');
}

function mergeCandidates(array $existing, array $incoming): array {
    $seen = [];
    foreach ($existing as $c) {
        if (is_array($c)) $seen[candKey($c)] = true;
    }
    foreach ($incoming as $c) {
        if (!is_array($c)) continue;
        if (!isset($c['candidate'])) continue;
        $k = candKey($c);
        if (isset($seen[$k])) continue;
        if (count($existing) >= 500) break;
        $existing[] = [
            'candidate' => (string)$c['candidate'],
            'sdpMid' => $c['sdpMid'] ?? null,
            'sdpMLineIndex' => $c['sdpMLineIndex'] ?? null,
        ];
        $seen[$k] = true;
    }
    return $existing;
}

function publicState(array $s): array {
    return [
        'pin' => $s['pin'] ?? null,
        'offer' => $s['offer'] ?? null,
        'answer' => $s['answer'] ?? null,
        'host_candidates' => $s['host_candidates'] ?? [],
        'joiner_candidates' => $s['joiner_candidates'] ?? [],
        'status' => $s['status'] ?? 'waiting',
        'last_activity' => $s['last_activity'] ?? time(),
    ];
}

pruneSessions();

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$rawBody = file_get_contents('php://input');
$body = [];
if (is_string($rawBody) && $rawBody !== '') {
    $decoded = json_decode($rawBody, true);
    if (is_array($decoded)) $body = $decoded;
}
$pin = $_GET['pin'] ?? ($body['pin'] ?? null);
$role = $_GET['role'] ?? ($body['role'] ?? null);

if ($action === 'create') {
    if ($method !== 'POST') jexit(['ok' => false, 'error' => 'method_not_allowed'], 405);
    if (createLimited(clientIp())) {
        jexit(['ok' => false, 'error' => 'rate_limited', 'retry_after' => 300], 429);
    }
    $pinNew = genPin();
    $now = time();
    $session = [
        'pin' => $pinNew,
        'created_at' => $now,
        'last_activity' => $now,
        'host_candidates' => [],
        'joiner_candidates' => [],
        'offer' => null,
        'answer' => null,
        'status' => 'waiting',
    ];
    $path = sessionPath($pinNew);
    $fp = @fopen($path, 'x');
    if ($fp === false) jexit(['ok' => false, 'error' => 'pin_collision_retry'], 500);
    fwrite($fp, (string)json_encode($session, JSON_UNESCAPED_SLASHES));
    fclose($fp);
    jexit(['ok' => true, 'pin' => $pinNew, 'created_at' => $now, 'status' => 'waiting']);
}

if ($action === 'join') {
    if ($method !== 'POST') jexit(['ok' => false, 'error' => 'method_not_allowed'], 405);
    $ip = clientIp();
    $rate = loadRate();
    if (isLocked($ip, $rate)) {
        jexit(['ok' => false, 'error' => 'rate_limited', 'retry_after' => ((int)$rate[$ip]['locked_until']) - time()], 429);
    }
    if (!validPinFormat(is_string($pin) ? $pin : null)) {
        $fails = recordFail($ip);
        jexit(['ok' => false, 'error' => 'invalid_pin', 'remaining' => max(0, MAX_FAILS - $fails)], 404);
    }
    $path = sessionPath((string)$pin);
    $s = readSessionLocked($path);
    if ($s === null) {
        $fails = recordFail($ip);
        jexit(['ok' => false, 'error' => 'invalid_pin', 'remaining' => max(0, MAX_FAILS - $fails)], 404);
    }
    if ((time() - (int)($s['created_at'] ?? 0)) > SESSION_TTL) {
        @unlink($path);
        jexit(['ok' => false, 'error' => 'expired'], 410);
    }
    $updated = atomicUpdate((string)$pin, function ($d) {
        $d['last_activity'] = time();
        if (($d['status'] ?? 'waiting') === 'waiting') $d['status'] = 'connecting';
        return $d;
    });
    if ($updated === null) {
        $fails = recordFail($ip);
        jexit(['ok' => false, 'error' => 'invalid_pin', 'remaining' => max(0, MAX_FAILS - $fails)], 404);
    }
    clearFails($ip);
    $fresh = readSessionLocked($path);
    jexit(['ok' => true, 'pin' => (string)$pin, 'status' => $fresh['status'] ?? 'connecting']);
}

if ($action === 'signal') {
    $ip = clientIp();
    $rate = loadRate();
    if (isLocked($ip, $rate)) {
        jexit(['ok' => false, 'error' => 'rate_limited', 'retry_after' => ((int)$rate[$ip]['locked_until']) - time()], 429);
    }
    if (!validPinFormat(is_string($pin) ? $pin : null)) {
        recordProbe($ip);
        jexit(['ok' => false, 'error' => 'invalid_pin'], 404);
    }
    if ($role !== 'host' && $role !== 'joiner') jexit(['ok' => false, 'error' => 'invalid_role'], 400);
    $pinStr = (string)$pin;
    $path = sessionPath($pinStr);
    if (isProbeLocked($ip, $rate)) {
        jexit(['ok' => false, 'error' => 'rate_limited', 'retry_after' => ((int)$rate[probeKey($ip)]['locked_until']) - time()], 429);
    }
    if (!file_exists($path)) {
        recordProbe($ip);
        jexit(['ok' => false, 'error' => 'invalid_pin'], 404);
    }
    $offer = $body['offer'] ?? null;
    $answer = $body['answer'] ?? null;
    $candidates = $body['candidates'] ?? null;
    $statusIn = $body['status'] ?? null;
    if (($offer !== null && !is_array($offer)) || ($answer !== null && !is_array($answer))) {
        jexit(['ok' => false, 'error' => 'bad_sdp'], 400);
    }
    if ($offer !== null && strlen((string)json_encode($offer)) > 30000) jexit(['ok' => false, 'error' => 'sdp_too_large'], 413);
    if ($answer !== null && strlen((string)json_encode($answer)) > 30000) jexit(['ok' => false, 'error' => 'sdp_too_large'], 413);
    if (is_array($candidates)) {
        if (count($candidates) > 100) jexit(['ok' => false, 'error' => 'too_many_candidates'], 413);
        foreach ($candidates as $cc) {
            if (is_array($cc) && isset($cc['candidate']) && strlen((string)$cc['candidate']) > 4096) {
                jexit(['ok' => false, 'error' => 'candidate_too_large'], 413);
            }
        }
    }
    $allowedStatus = ['waiting','connecting','connected','expiring','closed'];
    $updated = atomicUpdate($pinStr, function ($d) use ($role, $offer, $answer, $candidates, $statusIn, $allowedStatus) {
        $d['last_activity'] = time();
        if ($role === 'host') {
            if (is_array($offer) && ($offer['type'] ?? null) === 'offer' && isset($offer['sdp']) && is_string($offer['sdp']) && $offer['sdp'] !== '') {
                $d['offer'] = ['type' => 'offer', 'sdp' => (string)$offer['sdp']];
            }
            if (is_array($candidates)) {
                $d['host_candidates'] = mergeCandidates((array)($d['host_candidates'] ?? []), $candidates);
            }
        } else {
            if (is_array($answer) && ($answer['type'] ?? null) === 'answer' && isset($answer['sdp']) && is_string($answer['sdp']) && $answer['sdp'] !== '') {
                $d['answer'] = ['type' => 'answer', 'sdp' => (string)$answer['sdp']];
            }
            if (is_array($candidates)) {
                $d['joiner_candidates'] = mergeCandidates((array)($d['joiner_candidates'] ?? []), $candidates);
            }
        }
        if (is_string($statusIn) && in_array($statusIn, $allowedStatus, true)) {
            $d['status'] = $statusIn;
        }
        return $d;
    });
    if ($updated === null) {
        recordProbe($ip);
        jexit(['ok' => false, 'error' => 'invalid_pin'], 404);
    }
    jexit(array_merge(['ok' => true], publicState($updated)));
}

if ($action === 'cleanup') {
    if ($method !== 'POST') jexit(['ok' => false, 'error' => 'method_not_allowed'], 405);
    if (!validPinFormat(is_string($pin) ? $pin : null)) jexit(['ok' => false, 'error' => 'invalid_pin'], 404);
    @unlink(sessionPath((string)$pin));
    jexit(['ok' => true, 'cleaned' => true]);
}

jexit(['ok' => false, 'error' => 'unknown_action'], 400);
