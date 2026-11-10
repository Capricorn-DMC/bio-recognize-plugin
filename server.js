/**
 * BioRecognize Backend Server v2
 *
 * Features:
 * - Auto screen-off when user is away, auto screen-on when user returns
 * - CNN face identity matching (face-api.js 128-D embeddings)
 */

import http from 'http';
import { URL } from 'url';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync, execFileSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Process-level guards: an unhandled rejection used to kill the whole backend
// silently (observed as HTTP ECONNRESET with an empty log). Log and keep
// running — screen control is a background service, it must stay alive.
process.on('unhandledRejection', (e) => {
    console.error('[FATAL-GUARD] unhandled rejection:', e && e.stack ? e.stack : e);
});
process.on('uncaughtException', (e) => {
    console.error('[FATAL-GUARD] uncaught exception:', e && e.stack ? e.stack : e);
});

// Decode a base64 image/audio payload and persist it under models/captures/
const CAPTURES_DIR = join(__dirname, 'models', 'captures');
function saveBase64Payload(b64, ext) {
    try {
        mkdirSync(CAPTURES_DIR, { recursive: true });
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const target = join(CAPTURES_DIR, name);
        writeFileSync(target, Buffer.from(b64, 'base64'));
        return target;
    } catch (e) {
        console.error('[Server] Failed to save capture:', e.message);
        return null;
    }
}

// Configuration
const DEFAULT_PORT = 8765;
// Actual port, resolved below from --port= (the black-window watchdog needs it)
let BACKEND_PORT = DEFAULT_PORT;
const MODELS_DIR = join(__dirname, 'models');
const DATA_FILE = join(MODELS_DIR, 'users.json');
const CONFIG_FILE = join(MODELS_DIR, 'config.json');

// Global state
let users = {};
let config = {
    enabled: false,
    faceEnabled: false,
    // ── No-camera fallback (Plan B) ────────────────────────────────────
    // On machines WITHOUT a camera the biometric engine has nothing to look
    // at and stands down forever. When noCamMode is on AND the client
    // reports that no camera device exists at all, the engine degrades to
    // keyboard/mouse idle power saving: idle > noCamIdleSec → screen off,
    // any input → wake. NOT identity-safe (anyone moving the mouse wakes
    // it) — it is an explicit opt-in for camera-less desktops.
    noCamMode: false,
    noCamIdleSec: 300,     // idle seconds before the screen turns off
    detectionInterval: 300,
    absentThreshold: 1,
    faceGraceMs: 450,      // how long a face may be missing before "no face"
    awayDelayMs: 350,      // extra confirmation after last provable presence
    // ── Biometric-only gating ──────────────────────────────────────────
    // bioOnly: presence is decided ONLY by the face biometric signal.
    // Keyboard & mouse never keep the screen on and
    // never wake it — that is what makes "only I can wake my screen" work.
    // Input is still used for one thing only: a deliberate escape hatch
    // (sustained typing/mouse for manualOverrideMs) so a camera failure can
    // never trap the user behind a black screen.
    bioOnly: true,
    wakeHoldMs: 200,       // presence must hold this long before waking
    minBlackMs: 600,       // minimum time black before a wake is allowed
    wakeGuardMs: 1500,     // after a wake, ignore absence for this long
    manualOverrideMs: 3000,// sustained input while black → forced wake
    watchdogMs: 8000,      // no client heartbeat for this long → stand down
    // ── Identity (1:N face matching) ───────────────────────────────────
    // identityCheck: a detected face only counts if it matches an enrolled
    // person. This is what makes the screen "only mine" instead of "anybody
    // who sits down". Requires at least one enrolled face, otherwise the
    // engine falls back to plain face detection (see diagnostics.identity).
    identityCheck: true,
    matchThreshold: 0.65,     // legacy 400-D HOG cosine (94% of own frames pass)
    // 128-D CNN embedding threshold, calibrated on this machine:
    // owner 0.975-0.992, strangers 0.79-0.917 → 0.93 accepts the owner and
    // rejects every stranger measured. Unit vectors: cosine = 1 - d²/2, so
    // 0.93 ≈ euclidean 0.37.
    matchThresholdV2: 0.93,
    lastSeen: null,
    isScreenBlack: false
};

let detectionTimer = null;
let isInitialized = false;

// ============================================================
// Persistent PowerShell worker
// ============================================================
// A cold `powershell.exe` start costs ~1.6s on this machine and a WMI
// brightness write ~2.7s end-to-end — that alone made the away/return
// reaction feel sluggish. One long-lived REPL process executing commands
// over stdin brings per-command latency down to ~25ms.
class PsWorker {
    constructor() {
        this.proc = null;
        this.buf = '';
        this.waiters = [];
    }

    start() {
        if (this.proc) return;
        this.proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true });
        this.proc.stdout.setEncoding('utf8');
        this.proc.stderr.setEncoding('utf8');
        this.proc.stdout.on('data', d => { this.buf += d; this._drain(); });
        this.proc.stderr.on('data', () => {});
        this.proc.on('exit', () => { this.proc = null; this.buf = ''; });
        this.proc.on('error', () => { this.proc = null; });
    }

    _drain() {
        let idx;
        while ((idx = this.buf.indexOf('<<DONE>>')) >= 0) {
            const out = this.buf.slice(0, idx);
            this.buf = this.buf.slice(idx + 8);
            const w = this.waiters.shift();
            if (w) { clearTimeout(w.t); w.resolve(out); }
        }
    }

    // Resolves with everything the command printed before the marker.
    run(cmd, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            this.start();
            if (!this.proc) return reject(new Error('powershell worker unavailable'));
            const t = setTimeout(() => {
                const i = this.waiters.findIndex(x => x.t === t);
                if (i >= 0) this.waiters.splice(i, 1);
                // A timed-out command leaves the shell in an unknown state: its
                // marker will show up later and would then be matched against
                // the NEXT command's promise (outputs shifted by one, every
                // later call resolving with the wrong answer or timing out).
                // Kill it and let the next call start a clean one.
                try { this.proc && this.proc.kill(); } catch { /* already gone */ }
                this.proc = null;
                this.buf = '';
                for (const w of this.waiters.splice(0)) {
                    clearTimeout(w.t);
                    w.reject(new Error('powershell worker restarted after timeout'));
                }
                reject(new Error('powershell worker timeout'));
            }, timeoutMs);
            this.waiters.push({ resolve, reject, t });
            try { this.proc.stdin.write(cmd + '; Write-Output "<<DONE>>"\n'); }
            catch (e) { clearTimeout(t); reject(e); }
        });
    }
}

// ============================================================
// Screen Control (Windows)
// ============================================================

class ScreenController {
    // Full-screen blackout = backlight 0 (whole panel dims) + a topmost
    // borderless black window spanning every monitor (pure black on top of
    // the residual glow, so no text is visible even in a dark room).
    //
    // WHY NOT SC_MONITORPOWER: on this machine a display POWER-OFF event
    // locks the workstation (Security log 4800 correlated with a bare
    // screen-off test: lock ~4s after unlock). Neither brightness nor a
    // topmost window touches display power, so neither can lock.
    constructor() {
        this.isBlack = false;
        this.blackSince = null;   // when the current black period started
        this.lastOnAt = null;     // when the screen last came back on
        // Test hook: BIO_DRY_RUN=1 logs the transitions without touching the
        // real display, so the presence state machine can be exercised
        // without blacking out the machine running the test.
        this.dry = process.env.BIO_DRY_RUN === '1';
        this.prevBrightness = 100;
        this.worker = new PsWorker();
        this.winProc = null;
        this.statePath = join(MODELS_DIR, '_black_state.txt');
    }

    // Pre-warm the worker (define helpers once) and the black-window process
    // (hidden, polling the state file) so the first away/return is instant.
    async warm() {
        if (this.dry) return;
        try {
            // No overlay window from a previous run may survive: it shares the
            // state file, so a stale "1" would flash the whole screen black the
            // instant this backend boots.
            this._sweepOrphanWindows();
            writeFileSync(this.statePath, '0', 'utf8');
            await this.worker.run(`
function SetBB([int]$v) { Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods | ForEach-Object { $_ | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=[uint32]0; Brightness=[byte]$v} | Out-Null } }
function GetBB { [int](Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness | Select-Object -First 1).CurrentBrightness }
`, 20000);
            const lvl = await this.worker.run('GetBB', 8000);
            const m = /(\d+)/.exec(lvl || '');
            if (m && parseInt(m[1], 10) > 4) this.prevBrightness = parseInt(m[1], 10);
            console.log(`[Screen] PS worker warm (brightness ${this.prevBrightness}%)`);
        } catch (e) {
            console.error('[Screen] PS worker warm FAILED:', e.message);
        }
        // NOTE: the overlay window is deliberately NOT spawned here. Creating a
        // topmost full-screen WinForms window at boot makes this machine's
        // compositor blank the display for a frame — the "starts with a black
        // flash" symptom. It is spawned on the first real blackout instead
        // (turnOff), where a black window is exactly what is wanted.
    }

    _ensureWindowProc() {
        if (this.winProc && this.winProc.exitCode === null) return;
        try {
            const script = join(__dirname, 'models', '_black_win.ps1');
            this.winProc = spawn('powershell', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-BackendPort', String(BACKEND_PORT)], {
                windowsHide: true, stdio: 'ignore',
            });
            this.winProc.on('exit', () => { this.winProc = null; });
            this.winProc.on('error', () => { this.winProc = null; });
        } catch (e) {
            console.error('[Screen] black window spawn FAILED:', e.message);
        }
    }

    // Kill overlay windows whose backend is long gone. They poll the shared
    // state file, so a leftover process can black the screen at any moment —
    // including the second this backend starts.
    _sweepOrphanWindows() {
        try {
            const out = execFileSync('powershell', ['-NoProfile', '-Command',
                // $PID exclusion is essential: this very command line contains
                // the pattern, so without it the sweep matches (and kills) itself.
                "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*-File*_black_win.ps1*' } | Select-Object -ExpandProperty ProcessId",
            ], { encoding: 'utf8', timeout: 15000 });
            const pids = out.split(/\s+/).map(s => parseInt(s, 10)).filter(p => p > 0);
            for (const p of pids) {
                try { execFileSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch { /* gone */ }
            }
            if (pids.length) console.log(`[Screen] swept ${pids.length} orphan overlay process(es)`);
        } catch { /* best effort */ }
    }

    async turnOn() {
        this.isBlack = false;
        this.blackSince = null;
        this.lastOnAt = Date.now();
        if (this.dry) { console.log('[Screen] (dry-run) ON'); return { success: true, mode: 'dry-run' }; }
        // Signal the window first (it hides within ~120ms), then restore
        // brightness in the background so the state flip is immediate.
        try { writeFileSync(this.statePath, '0', 'utf8'); } catch {}
        const level = Math.min(100, Math.max(5, this.prevBrightness));
        try {
            await this.worker.run(`SetBB ${level}`);
            console.log(`[Screen] backlight restored to ${level}%, window hidden`);
            return { success: true, mode: 'brightness+window' };
        } catch (e) {
            console.error('[Screen] turnOn brightness restore FAILED:', e.message);
            return { success: false, error: e.message };
        }
    }

    async turnOff() {
        if (this.isBlack) return { success: true, mode: 'already-black' };
        this.isBlack = true;
        this.blackSince = Date.now();
        if (this.dry) { console.log('[Screen] (dry-run) OFF'); return { success: true, mode: 'dry-run' }; }
        // Who asked? Every unexpected black-out needs a name attached to it.
        console.log('[Screen] black out requested by', (new Error().stack || '').split('\n')[2]?.trim());
        try {
            // Read the current level right before blanking (the user may have
            // adjusted brightness since startup), then drop to 0. Short
            // timeout: this is a cache read for the restore value, never a
            // reason to delay the blackout.
            const cur = await this.worker.run('GetBB', 800);
            const m = /(\d+)/.exec(cur || '');
            if (m && parseInt(m[1], 10) > 4) this.prevBrightness = parseInt(m[1], 10);
        } catch {}
        try { writeFileSync(this.statePath, '1', 'utf8'); } catch {}
        // Remember the level to restore, for the overlay's crash watchdog.
        try { writeFileSync(join(MODELS_DIR, '_black_level.txt'), String(this.prevBrightness), 'utf8'); } catch {}
        this._ensureWindowProc();
        try {
            // The overlay window is already up, so the screen IS black at this
            // point — never let a stalled shell hold the call open for 5s.
            const work = this.worker.run('SetBB 0', 2500);
            const ok = await Promise.race([
                work.then(() => true).catch(e => { throw e; }),
                new Promise(r => setTimeout(() => r('pending'), 1200)),
            ]);
            if (ok === 'pending') {
                console.warn('[Screen] backlight set still pending — overlay already covers the panel');
                work.catch(() => {});
            } else {
                console.log(`[Screen] black out (restore level ${this.prevBrightness}%)`);
            }
            return { success: true, mode: 'brightness+window' };
        } catch (e) {
            // Window overlay alone still blacks the screen.
            console.error('[Screen] turnOff brightness FAILED (window-only):', e.message);
            return { success: false, error: e.message, mode: 'window-only' };
        }
    }
    
    getState() {
        return {
            isBlack: this.isBlack
        };
    }
}

// ============================================================
// Input Monitor — keyboard/mouse idle time via GetLastInputInfo
// ============================================================
// The single source of truth for "is someone at the computer".
// Browser-tab heartbeats cannot survive Chrome background throttling /
// tab freezing, and the webcam presence detector is simulated — the OS
// input idle time is what Windows itself uses for screen savers: the
// user leaves → input stops → absent; returns → any mouse move → present
// within ~0.5s, regardless of browser state.
class InputMonitor {
    constructor() {
        this.idleSeconds = null;    // seconds since last keyboard/mouse input
        this.lastUpdate = 0;
        this.proc = null;
        this.backoff = 1000;
        this.stopped = false;
        this.buffer = '';
    }

    start() {
        this.stopped = false;
        this._spawn();
    }

    stop() {
        this.stopped = true;
        if (this.proc) { try { this.proc.kill(); } catch { /* noop */ } this.proc = null; }
    }

    // null when no data yet (PowerShell still booting, ~0.5-1s after start)
    getIdleSeconds() {
        return this.idleSeconds;
    }

    _spawn() {
        if (this.stopped) return;
        try {
            const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class LastInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
"@
while ($true) {
    $lii = New-Object LastInput+LASTINPUTINFO
    $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
    [void][LastInput]::GetLastInputInfo([ref]$lii)
    $idle = [uint32]([Environment]::TickCount - $lii.dwTime)
    Write-Output $idle
    Start-Sleep -Milliseconds 400
}
`;
            this.proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
                { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            this.proc.stdout.on('data', (chunk) => {
                this.buffer += chunk.toString();
                let idx;
                while ((idx = this.buffer.indexOf('\n')) >= 0) {
                    const line = this.buffer.slice(0, idx).trim();
                    this.buffer = this.buffer.slice(idx + 1);
                    const ms = parseInt(line, 10);
                    if (!isNaN(ms)) {
                        this.idleSeconds = ms / 1000;
                        this.lastUpdate = Date.now();
                    }
                }
            });
            this.proc.stderr.on('data', (c) => {
                const msg = c.toString().trim().split('\n')[0];
                if (msg) console.error('[InputMonitor]', msg.slice(0, 200));
            });
            this.proc.on('exit', () => {
                this.proc = null;
                if (!this.stopped) {
                    // auto-restart with backoff so the sensor never stays dead
                    setTimeout(() => { if (!this.stopped) this._spawn(); }, this.backoff);
                    this.backoff = Math.min(this.backoff * 2, 15000);
                }
            });
            this.proc.on('error', () => { try { this.proc.kill(); } catch { /* noop */ } });
            console.log('[InputMonitor] started (poll: 400ms)');
        } catch (e) {
            console.error('[InputMonitor] spawn failed:', e.message);
            setTimeout(() => { if (!this.stopped) this._spawn(); }, this.backoff);
        }
    }
}

// ============================================================
// User Management
// ============================================================

class UserManager {
    constructor() {
        this.users = {};
        this.load();
    }
    
    load() {
        if (existsSync(DATA_FILE)) {
            try {
                const data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
                this.users = data.users || {};
                console.log(`[UserManager] Loaded ${Object.keys(this.users).length} users`);
            } catch (e) {
                console.error('[UserManager] Failed to load:', e.message);
                this.users = {};
            }
        }
    }
    
    save() {
        mkdirSync(dirname(DATA_FILE), { recursive: true });
        writeFileSync(DATA_FILE, JSON.stringify({
            users: this.users,
            updated_at: new Date().toISOString()
        }, null, 2));
    }
    
    list() {
        return Object.entries(this.users).map(([id, data]) => ({
            user_id: id,
            name: data.name,
            registered_at: data.registered_at,
            has_face: !!(data.face_image || (Array.isArray(data.face_descriptors) && data.face_descriptors.length))
        }));
    }
    
    add(userId, name) {
        if (this.users[userId]) {
            return { status: 'error', message: 'User already exists' };
        }
        this.users[userId] = {
            name,
            registered_at: new Date().toISOString(),
            face_embedding: null,
            face_image: null
        };
        this.save();
        return { status: 'success', user_id: userId };
    }
    
    remove(userId) {
        if (!this.users[userId]) {
            return { status: 'error', message: 'User not found' };
        }
        delete this.users[userId];
        this.save();
        return { status: 'success', user_id: userId };
    }
    
    get(userId) {
        if (!this.users[userId]) {
            return { status: 'error', message: 'User not found' };
        }
        return { status: 'success', user: this.users[userId] };
    }
    
    registerFace(userId, embedding, imagePath) {
        if (!this.users[userId]) {
            return { status: 'error', message: 'User not found' };
        }
        this.users[userId].face_embedding = embedding;
        this.users[userId].face_image = imagePath;
        this.users[userId].face_registered_at = new Date().toISOString();
        this.save();
        return { status: 'success' };
    }
}

// ============================================================
// Identity matching (1:N, offline)
// ============================================================
// Answers "is this the enrolled person?" instead of "is there a face?".
//
// TWO descriptor families are supported, because the first one was not
// discriminative enough to keep a different person off the screen:
//
//  • v2 (preferred): 128-D embedding from face-api.js FaceRecognitionNet —
//    a real CNN descriptor, L2-normalised. Verified thresholds: same person
//    sits at cosine 0.92-0.99 (euclidean 0.15-0.40), a different person
//    drops below 0.75 (euclidean > 0.70). Cosine similarity is exactly
//    1 - d²/2 for unit vectors, so 0.86 ≈ euclidean 0.53.
//  • v1 (legacy fallback): 400-D z-scored crop + HOG from vendor/facedesc.js.
//    Cheap and offline, but it mostly encodes pose/lighting: two different
//    people with a similar face box can score 0.7+. Kept only so the plugin
//    degrades instead of breaking when the browser cannot load the models.
//
// The reference set never mixes dimensions: whichever family has enrolled
// references wins, and the other is ignored entirely.
const EMB_DIM_V2 = 128;
// Calibrated on THIS machine's data (bench_cnn_identity / bench_cnn_negatives):
//   same person (photo vs 7 live frames): cosine 0.975 … 0.992
//   24 stranger faces (public demo photos): cosine 0.79 … 0.917
// So 0.93 accepts the owner and rejects every stranger, with ~0.04 headroom on
// both sides. Below 0.85 the face is clearly somebody else; the band in
// between is "unsure", handled separately by the presence engine (it must not
// wake a black screen, but it also must not black out a poorly-lit owner).
const THRESH_V2_DEFAULT = 0.93;   // cosine ≈ euclidean 0.37
const REJECT_V2_MARGIN = 0.07;    // 0.92 - 0.07 = 0.85 → clearly a stranger
const THRESH_V1_DEFAULT = 0.65;

class IdentityMatcher {
    constructor() {
        this.desc = null;
        this.sim = null;
        this.pico = null;
        this.cascade = null;
        this.refs = [];        // [{ userId, vec, dim }]
        this.dim = null;       // dimension of the ACTIVE reference set
        this.ready = false;
        this.error = null;
        this.ema = null;       // smoothed live score
        this.matched = false;  // hysteresis state
        this.verdict = null;   // 'self' | 'other' | 'unknown' (see update)
        this.lastScore = null;
        this.lastUserId = null;
        this.lastAt = null;
        this.enrolled = 0;
        this.refsV2 = 0;       // CNN references available
        this.refsV1 = 0;       // legacy HOG references available
        this.lastDim = null;   // dimension actually received from the client
        this.supported = false; // client has ever sent a live descriptor
    }

    async load() {
        try {
            const src = readFileSync(join(__dirname, 'vendor', 'facedesc.js'), 'utf8');
            const mod = new Function(`${src}; return { faceDescriptor, faceSimilarity };`)();
            this.desc = mod.faceDescriptor;
            this.sim = mod.faceSimilarity;
            const picoSrc = readFileSync(join(__dirname, 'vendor', 'pico.js'), 'utf8');
            this.pico = new Function(`${picoSrc}; return pico;`)();
            this.cascade = this.pico.unpack_cascade(
                new Int8Array(readFileSync(join(__dirname, 'vendor', 'facefinder'))));
            this.ready = true;
            console.log('[Identity] descriptor + face cascade loaded');
        } catch (e) {
            this.error = e.message;
            console.error('[Identity] load FAILED:', e.message);
        }
    }

    // Decode an image file to grayscale. sharp is preferred (png/webp/jpg +
    // resizing), with jpeg-js as a dependency-free fallback.
    async _gray(file) {
        try {
            const m = await import('sharp');
            const sharp = m.default || m;
            const { data, info } = await sharp(file)
                .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
                .removeAlpha().raw().toBuffer({ resolveWithObject: true });
            const w = info.width, h = info.height;
            const gray = new Uint8Array(w * h);
            for (let i = 0, p = 0; i < gray.length; i++, p += info.channels) {
                gray[i] = (2 * data[p] + 7 * data[p + 1] + data[p + 2]) / 10;
            }
            return { gray, w, h };
        } catch { /* try jpeg-js */ }
        try {
            const m = await import('jpeg-js');
            const jpeg = m.default || m;
            const img = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
            const { width: w, height: h, data } = img;
            const gray = new Uint8Array(w * h);
            for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
                gray[i] = (2 * data[p] + 7 * data[p + 1] + data[p + 2]) / 10;
            }
            return { gray, w, h };
        } catch (e) {
            this.error = 'decode failed: ' + e.message;
            return null;
        }
    }

    async descriptorFromFile(file) {
        if (!this.ready) return null;
        const img = await this._gray(file);
        if (!img) return null;
        const { gray, w, h } = img;
        const minDim = Math.min(w, h);
        try {
            const dts = this.pico.run_cascade(
                { pixels: gray, nrows: h, ncols: w, ldim: w }, this.cascade,
                {
                    shiftfactor: 0.1,
                    minsize: Math.max(24, Math.round(minDim * 0.12)),
                    maxsize: Math.round(minDim * 0.9),
                    scalefactor: 1.15,
                });
            const dets = this.pico.cluster_detections(dts, 0.1).filter(d => d[3] >= 3.0);
            if (!dets.length) return null;
            dets.sort((a, b) => b[3] - a[3]);           // highest quality first
            const [r, c, s] = dets[0];
            return this.desc(gray, w, h, { x: c, y: r, w: s, h: s });
        } catch (e) {
            this.error = 'detect failed: ' + e.message;
            return null;
        }
    }

    // Rebuild the reference set from users.json.
    // BOTH families are kept: CNN references are preferred, but if the browser
    // cannot produce embeddings on this machine (no WebGL/WASM acceleration)
    // the legacy HOG set still gates presence instead of silently enforcing
    // nothing. `dim` only records which family is preferred.
    async buildRefs(users) {
        if (!this.ready) return;
        this.refs = [];
        let v2Count = 0, v1Count = 0;
        for (const [id, u] of Object.entries(users || {})) {
            const v2 = Array.isArray(u.face_descriptors_v2)
                ? u.face_descriptors_v2.filter(v => Array.isArray(v) && v.length === EMB_DIM_V2)
                : [];
            for (const v of v2) {
                this.refs.push({ userId: id, vec: Float32Array.from(v), dim: EMB_DIM_V2 });
                v2Count++;
            }
            const vecs = [];
            const legacy = Array.isArray(u.face_descriptors) ? u.face_descriptors : [];
            for (const v of legacy) {
                if (Array.isArray(v) && v.length && v.length !== EMB_DIM_V2) vecs.push(Float32Array.from(v));
            }
            if (!vecs.length && !v2.length && u.face_image) {
                const v = await this.descriptorFromFile(u.face_image);
                if (v) {
                    vecs.push(v);
                    u.face_descriptors = [Array.from(v)];
                }
            }
            for (const v of vecs) {
                this.refs.push({ userId: id, vec: v, dim: v.length });
                v1Count++;
            }
        }
        this.enrolled = this.refs.length;
        this.refsV2 = v2Count;
        this.refsV1 = v1Count;
        this.dim = v2Count ? EMB_DIM_V2 : (v1Count ? this.refs.find(r => r.dim !== EMB_DIM_V2).dim : null);
        console.log(`[Identity] ${this.refs.length} reference descriptor(s) ready` +
            ` (CNN ${v2Count}, legacy ${v1Count})`);
    }

    // Score per person = mean of its two BEST references.
    // Taking the single best one let the score creep up as more references were
    // auto-enrolled: a stranger who happens to resemble one particular stored
    // pose then clears the threshold. Averaging the top two keeps genuine
    // matches high (the owner resembles all of their own poses) while single
    // lucky coincidences stop being enough.
    best(vec) {
        const byUser = new Map();
        for (const r of this.refs) {
            if (r.dim !== vec.length) continue;   // never compare across families
            const s = this.sim(vec, r.vec);
            const arr = byUser.get(r.userId);
            if (arr) arr.push(s); else byUser.set(r.userId, [s]);
        }
        let score = -1, userId = null;
        for (const [id, arr] of byUser) {
            arr.sort((a, b) => b - a);
            const s = arr.length >= 2 ? (arr[0] + arr[1]) / 2 : arr[0];
            if (s > score) { score = s; userId = id; }
        }
        return { score, userId };
    }

    // Threshold depends on the descriptor family: a CNN embedding needs a much
    // tighter cosine than the HOG descriptor did.
    threshFor(vec) {
        if (vec && vec.length === EMB_DIM_V2) {
            const t = Number(config.matchThresholdV2);
            return Math.min(Math.max(Number.isFinite(t) ? t : THRESH_V2_DEFAULT, 0.60), 0.98);
        }
        const t = Number(config.matchThreshold);
        return Math.min(Math.max(Number.isFinite(t) ? t : THRESH_V1_DEFAULT, 0.30), 0.95);
    }

    // Feed one live descriptor. EMA + hysteresis: a single blurry or
    // half-turned frame can not flip the identity back and forth.
    update(vec, threshold) {
        const { score, userId } = this.best(vec);
        if (score < 0) return { score: 0, userId: null, skipped: true };
        // CNN embeddings always use their own (much tighter) threshold; the
        // legacy HOG keeps the value from the settings page.
        const useThr = vec.length === EMB_DIM_V2
            ? this.threshFor(vec)
            : (threshold != null ? threshold : this.threshFor(vec));
        this.supported = true;
        this.lastScore = score;
        this.lastUserId = userId;
        this.lastAt = Date.now();
        this.lastDim = vec.length;
        this.ema = this.ema == null ? score : this.ema * 0.55 + score * 0.45;
        const release = Math.max(0.30, useThr - (vec.length === EMB_DIM_V2 ? 0.03 : 0.08));
        // A single decisive frame wins immediately: waiting for the EMA to climb
        // cost 2–3 beats (~1s) every time the user sat back down, which is most
        // of the "returning feels slower than leaving" complaint. The smoothed
        // value still governs RELEASE, so one blurry frame cannot flip a
        // verified user off.
        const strong = score >= useThr + 0.03;
        if (!this.matched && (this.ema >= useThr || strong)) this.matched = true;
        else if (this.matched && this.ema < release && !strong) this.matched = false;
        this.verdict = this.matched ? 'self'
            : (this.ema != null && this.ema <= useThr - (vec.length === EMB_DIM_V2 ? REJECT_V2_MARGIN : 0.10))
                ? 'other' : 'unknown';
        return { score, userId };
    }

    // Store fresh 128-D references (from the enrolment photo, or from a live
    // frame the user explicitly enrolled). Rebuilds the active set.
    async enrollV2(users, userId, descriptors) {
        const u = users?.[userId];
        if (!u) return { status: 'error', message: 'User not found' };
        const list = Array.isArray(u.face_descriptors_v2) ? u.face_descriptors_v2 : [];
        let added = 0;
        for (const d of descriptors || []) {
            if (!Array.isArray(d) || d.length !== EMB_DIM_V2) continue;
            const vec = Float32Array.from(d);
            if (list.some(v => Array.isArray(v) && this.sim(vec, Float32Array.from(v)) > 0.992)) continue;
            list.push(Array.from(vec, x => Math.round(x * 1e5) / 1e5));
            added++;
            if (list.length >= 12) break;
        }
        u.face_descriptors_v2 = list;
        await this.buildRefs(users);
        console.log(`[Identity] v2 enrolled ${added} descriptor(s) for ${userId} (total ${list.length})`);
        return { status: 'success', added, refs: this.refs.length, dim: this.dim };
    }

    // Identity evidence expires: no descriptor for 2s = "not verified".
    fresh(now = Date.now()) {
        return this.lastAt && (now - this.lastAt) < 2000;
    }
}

// ============================================================
// Presence Detection Engine
// ============================================================

class PresenceEngine {
    constructor(inputMonitor, identity = null) {
        this.screen = new ScreenController();
        this.input = inputMonitor;
        this.identity = identity;
        this.lastSeen = null;
        this.state = 'unknown';
        this.lastHeartbeat = null;  // Last time frontend sent presence heartbeat
        this.absentSince = null;    // When the current absence episode started
        this.actionTaken = false;   // Whether the away action already ran this episode
        this.armed = false;         // Becomes true after real presence is first seen
        this.firstHeartbeatAt = null; // First time the client UI checked in (arming gate)

        // ── Biometric signals ──
        this.faceSeenAt = null;     // last frame where the client detected a face
        this.lastNumericFaceAt = null; // last heartbeat that actually carried a face count
        this.lastBeatAt = null;        // previous heartbeat time (cadence measurement)
        this.hbIntervalMs = null;      // smoothed heartbeat interval
        this.resumeAt = 0;             // last time a stalled heartbeat stream resumed
        this.noCam = false;            // client reports NO camera device exists (NotFoundError)
        this.clientDiag = null;        // last client camera diagnostics (cam/err/ms)

        // ── Anti-flap hysteresis ──
        // Presence/absence are only trusted after holding continuously for a
        // while. Without these, one flickering detector frame flipped the
        // screen black→on→black in an endless loop.
        this.presentSince = null;      // start of the current continuous presence streak
        this.absentStreakStart = null; // start of the current continuous absence streak
        this.inputActiveSince = null;  // sustained-input escape-hatch timer
        this.reason = null;            // why the last state change happened (diagnostics)

        this.keepAlive = new KeepAlive();
        this.createdAt = Date.now();   // startup settle window (see checkPresence)
    }

    async startDetection(cfg) {
        if (detectionTimer) {
            clearInterval(detectionTimer);
        }

        console.log('[Presence] Starting detection loop (tick: 250ms)');

        // While the plugin manages the display the system must not drift into
        // Modern Standby — waking from standby shows the sign-in screen.
        this.keepAlive.start();

        // 200ms tick: checkPresence only compares timestamps (cheap), and the
        // tick is the last source of lag between "face gone" and "screen off".
        detectionTimer = setInterval(async () => {
            await this.checkPresence(cfg);
        }, 200);
    }

    stopDetection() {
        if (detectionTimer) {
            clearInterval(detectionTimer);
            detectionTimer = null;
            console.log('[Presence] Detection stopped');
        }
        this.keepAlive.stop();
    }

    async checkPresence(cfg) {
        if (!cfg.enabled) return;
        const now = Date.now();

        // ── 0. Watcher liveness ───────────────────────────────────────
        // No client heartbeat (browser closed, dsh window gone, machine
        // asleep, camera re-opening) means nobody can prove presence OR
        // absence. Standing down is the only safe move.
        //
        // This used to wait for the full watchdog (8s). In between, the last
        // known face simply aged past its grace window and the engine read a
        // SILENT client as "the user left" — blanking the screen ~1s into any
        // hiccup. That is also why the screen went black the instant the
        // client came back: the first frame after a resume has no face yet.
        // A beat gap of 3 sampling intervals is "no evidence", full stop.
        const hbAge = this.lastHeartbeat ? now - this.lastHeartbeat : Infinity;
        const watchdogMs = cfg.watchdogMs || 8000;
        const hbGapLimit = Math.max((this.hbIntervalMs || 350) * 3, 1200);
        if (hbAge > hbGapLimit) {
            this.state = 'unknown';
            this.presentSince = null;
            this.absentStreakStart = null;
            this.inputActiveSince = null;
            // Only hand the screen back after a real loss (watchdog), not for a
            // sub-second gap that will heal itself.
            if (this.screen.isBlack && hbAge > watchdogMs) {
                console.log('[Presence] Client heartbeat lost — restoring screen');
                await this.screen.turnOn();
                cfg.isScreenBlack = false;
                this.reason = 'watchdog';
            }
            return;
        }

        // ── 0b. Camera health ─────────────────────────────────────────
        // With no picture there is no evidence in EITHER direction. Falling
        // back to keyboard/mouse here is worse than doing nothing: an idle
        // reader would get blacked out. Stand down and let the UI say the
        // camera is unavailable.
        //
        // EXCEPTION — no-camera fallback: when the client has proven there is
        // NO camera device at all (getUserMedia NotFoundError, not a busy or
        // broken one) and the user opted into noCamMode, standing down forever
        // is useless; the engine degrades to input-idle power saving instead.
        const cam = this.clientDiag && this.clientDiag.cam;
        const det = this.clientDiag && this.clientDiag.det;
        const fallback = !!cfg.noCamMode && this.noCam;
        this.fallback = fallback;
        // 'missing' = the browser could not evaluate the face cascade (CSP,
        // fetch failure). Same reasoning as a dead camera: no detector means
        // no evidence, so stand down instead of guessing from input.
        //
        // A client that stops attaching a face count is equally blind: when the
        // heartbeat loop restarts (camera re-open, effect churn) the beats keep
        // arriving but carry no `faces`, and counting that as "everyone left"
        // blanked the screen. Four silent beats = no evidence.
        //
        // cam === 'idle' is the client's OWN statement that its sampling loop is
        // stopped — no picture, nothing to judge by, so stand down for that beat
        // instead of believing the last face count that happened to arrive.
        const numericSilent = !this.lastNumericFaceAt ||
            (now - this.lastNumericFaceAt) > Math.max((this.hbIntervalMs || 350) * 4, 1500);
        const noPicture = !fallback && (cam === 'error' || cam === 'novideo' || cam === 'idle' ||
            det === 'missing' || numericSilent);
        if (noPicture) {
            this.state = 'unknown';
            this.presentSince = null;
            this.absentStreakStart = null;
            this.inputActiveSince = null;
            if (this.screen.isBlack) {
                console.log('[Presence] Camera/detector unavailable — restoring screen');
                await this.screen.turnOn();
                cfg.isScreenBlack = false;
                this.reason = cam === 'error' || cam === 'novideo' ? 'camera-lost' : 'detector-missing';
            }
            return;
        }

        // ── 1. Biometric evidence ─────────────────────────────────────
        // Grace must scale with the ACTUAL sampling cadence: a throttled
        // background tab beats once a second, and a fixed 550ms window would
        // then read "no face" on every other tick — the detector would look
        // like it is flickering and the screen would pulse.
        const hbInterval = Math.min(Math.max(this.hbIntervalMs || 350, 200), 3000);
        // Grace must cover more than ONE sampling interval: a 400ms beat with a
        // detector that misses ~7% of frames produces occasional two-frame
        // gaps, and a grace of 1.5x interpreted those as "user left" — the
        // screen blanked for a second while the user was sitting right there.
        // 2.2x tolerates two consecutive misses.
        const faceGrace = Math.min(
            Math.max(cfg.faceGraceMs || 450, hbInterval * 1.8, 360), 4000);
        const faceEnabled = cfg.faceEnabled !== false;

        // A detector only counts as usable while heartbeats still carry its
        // result. If pico.js failed to load or the camera died, heartbeats
        // keep coming without a face count — reading that as "nobody here"
        // would blank the screen out from under a user who is clearly typing.
        const faceUsable = faceEnabled && this.lastNumericFaceAt &&
            (now - this.lastNumericFaceAt) < 5000;

        // ── Identity gate (1:N) ──────────────────────────────────────
        // A detected face only proves presence if it matches an enrolled
        // person. Requirements to enforce it at all: identityCheck on, the
        // descriptor code loaded, at least one reference, and the client is
        // actually sending live descriptors. Any of those missing → fall
        // back to plain face detection rather than locking the user out.
        const id = this.identity;
        const idAvailable = !!(id && id.ready && id.refs.length && id.supported &&
            id.lastAt && (now - id.lastAt) < 5000);
        const idRequired = (cfg.identityCheck !== false) && idAvailable;
        const idFresh = !!(id && id.matched && id.lastAt && (now - id.lastAt) < 2000);
        this.idRequired = idRequired;
        this.idFresh = idFresh;

        const faceHit = faceUsable && this.faceSeenAt && (now - this.faceSeenAt) < faceGrace &&
            (!idRequired || idFresh);
        const bioHit = !!faceHit;

        // ── 1.5 "Unsure" identity ────────────────────────────────────
        // A face is visible and identity is enforced, but the match lands in
        // the grey band: not provably the owner, not provably a stranger.
        // While the screen is BLACK this must never wake it — that is exactly
        // how a colleague sitting down used to light the display up.
        // While the screen is ON the normal absence path keeps running, so a
        // genuinely empty desk still blacks out; nothing hangs in "present".
        const faceVisibleNow = faceUsable && this.faceSeenAt && (now - this.faceSeenAt) < faceGrace;
        const idVerdict = id ? id.verdict : null;
        this.idVerdict = idVerdict;
        if (idRequired && !idFresh && faceVisibleNow && idVerdict === 'unknown') {
            if (this.screen.isBlack) {
                this.absentStreakStart = now;   // treat as "empty right now"
                this.presentSince = null;
                this.reason = 'identity-unknown';
                return;
            }
        }

        // ── 2. Input evidence ────────────────────────────────────────
        // In no-camera fallback the idle threshold is the configurable
        // noCamIdleSec (minutes of quiet before "away"); otherwise the tiny
        // bio-era absentThreshold applies (input is evidence of NO presence).
        const idle = this.input.getIdleSeconds();
        const inputHit = idle !== null && idle <
            (fallback ? Math.min(Math.max(cfg.noCamIdleSec || 300, 10), 3600)
                      : (cfg.absentThreshold || 1));

        // ── 3. Combine ───────────────────────────────────────────────
        // Bio-only mode (default): keyboard/mouse are NOT presence. Only the
        // signals enabled in the settings count, and any ONE of them is
        // enough — that is what gives per-person control (a mouse move can
        // never wake or hold the screen).
        //
        // Degradations where input is allowed back in, all of them there to
        // make "screen stuck black" impossible:
        //   • bioOnly switched off  → legacy input-or-face behaviour
        //   • no biometric switch on at all
        //   • the face biometric is unusable (no camera detector)
        //     → nothing left to judge by but input
        const anyUsableBio = faceEnabled && faceUsable;
        const useInput = fallback || !cfg.bioOnly || !anyUsableBio;
        const present = bioHit || (useInput && inputHit);
        const wakeHoldMs = Math.min(Math.max(cfg.wakeHoldMs || 250, 100), 3000);
        const minBlackMs = Math.min(Math.max(cfg.minBlackMs || 700, 0), 5000);

        if (present) {
            if (this.presentSince == null) {
                this.presentSince = now;
                if (this.screen.isBlack) console.log('[Presence] Presence detected — verifying before wake');
            }
            this.lastSeen = now;
            this.absentStreakStart = null;
            this.absentSince = null;
            this.actionTaken = false;   // re-arm the away action
            this.inputActiveSince = null;
            this.state = 'present';

            const heldMs = now - this.presentSince;
            // Arming still requires a real, non-transient presence: this is
            // what stops a single stray detection from letting the engine
            // blank the screen later. 800ms (not 200) because the camera is
            // still warming up right after the backend starts — arming on the
            // first couple of frames made the plugin blank the screen a second
            // after startup, then wake again.
            if (this.firstHeartbeatAt && heldMs >= Math.max(wakeHoldMs, 800)) this.armed = true;

            if (this.screen.isBlack) {
                const blackFor = this.screen.blackSince ? now - this.screen.blackSince : minBlackMs;
                // Two-sided hysteresis: presence must hold ~wakeHoldMs and the
                // screen must have been black at least minBlackMs. Together
                // with the absence streak below, this kills the on/off flicker.
                if (heldMs >= wakeHoldMs && blackFor >= minBlackMs) {
                    console.log(`[Screen] Presence held ${Math.round(heldMs)}ms (black ${Math.round(blackFor)}ms) — restoring`);
                    await this.screen.turnOn();
                    cfg.isScreenBlack = false;
                    this.reason = bioHit ? 'bio-present' : 'input-present';
                }
            }
        } else {
            this.presentSince = null;
            if (this.absentStreakStart == null) this.absentStreakStart = now;
            if (this.absentSince == null) this.absentSince = this.absentStreakStart;
            this.state = 'absent';

            // Oscillation guard: right after a wake, absence is not trusted
            // for wakeGuardMs. Blacking the screen changes the room light,
            // which can make the next detection frames fail — without this
            // the engine could cycle wake→black→wake every couple of seconds.
            const wakeGuardMs = Math.min(Math.max(cfg.wakeGuardMs || 2000, 0), 10000);
            if (this.screen.lastOnAt && (now - this.screen.lastOnAt) < wakeGuardMs) {
                this.absentStreakStart = now;
                return;
            }

            // Settle window after the heartbeat stream resumes: the client just
            // came back (visible tab, camera re-opened) and its first frames are
            // not trustworthy yet. Blanking here is what made the screen go
            // black exactly when the user returned instead of when they left.
            if (this.resumeAt && (now - this.resumeAt) < 1200) {
                this.absentStreakStart = now;
                return;
            }

            // Absence may only be CONCLUDED while the evidence stream is live.
            // A face that merely aged out because the client stopped beating is
            // not "the user left" — it is "we stopped looking". Without this,
            // any beat hiccup longer than the face grace blanked the screen,
            // and the screen came back the moment the client resumed.
            const beatFresh = (now - (this.lastBeatAt || 0)) <= Math.max((this.hbIntervalMs || 350) * 2.5, 800);
            // No-camera fallback has no frames at all by design: judge absence
            // purely by the (fresh-beat) idle time, never by face freshness.
            const numericFresh = fallback || (this.lastNumericFaceAt &&
                (now - this.lastNumericFaceAt) <= Math.max(hbInterval * 3, 1200));
            if (!beatFresh || (faceEnabled && !numericFresh)) {
                this.absentStreakStart = now;
                this.state = 'unknown';
                return;
            }

            const absentMs = now - this.absentStreakStart;

            // Escape hatch: a DELIBERATE amount of input while black wakes the
            // screen (manualOverrideMs of continuous typing/mouse). A single
            // mouse move still does nothing — that is the point — but a dead
            // camera or a changed haircut can never trap the user.
            if (this.screen.isBlack && inputHit && (cfg.manualOverrideMs || 3000) > 0) {
                if (this.inputActiveSince == null) this.inputActiveSince = now;
                else if (now - this.inputActiveSince >= (cfg.manualOverrideMs || 3000)) {
                    console.log('[Screen] Manual override — sustained input while black, restoring');
                    this.inputActiveSince = null;
                    await this.screen.turnOn();
                    cfg.isScreenBlack = false;
                    this.reason = 'manual-override';
                    // Reset the streak so we do not immediately blank again.
                    this.absentStreakStart = now;
                    this.actionTaken = false;
                    return;
                }
            } else {
                this.inputActiveSince = null;
            }

            // Absence must be OBSERVED continuously for awayDelayMs. Using a
            // retroactive start time made leaving feel instant but also let a
            // 1-frame detection gap satisfy the threshold immediately — the
            // direct cause of the black/on/black flicker.
            //
            // Startup settle: for the first seconds after the backend boots
            // the camera is still warming up and the first frames are the
            // least reliable of the whole session. Never blank during it —
            // otherwise "start the service" itself blacks the screen once.
            if (now - this.createdAt < 3000) {
                this.absentStreakStart = now;
                return;
            }
            if (this.armed && !this.actionTaken && absentMs >= (cfg.awayDelayMs || 350)) {
                this.actionTaken = true;
                await this._executeAction(cfg, absentMs);
            }
        }
    }

    async _executeAction(cfg, absentMs) {
        console.log(`[Presence] Absence held ${Math.round(absentMs || 0)}ms, turning screen off`);
        await this.screen.turnOff();
        cfg.isScreenBlack = true;
        this.reason = 'absent';
    }
}

// ============================================================
// KeepAlive — block system standby while the plugin drives the display
// ============================================================
// On Modern Standby (S0ix) laptops a programmatic display-off
// (SC_MONITORPOWER) lets the platform drift into S0 idle standby, and
// waking from standby shows the Windows sign-in screen ("require sign-in
// on wake" is the default). Holding ES_SYSTEM_REQUIRED keeps the system in
// the working state, so our off/on cycle is display-only: wake lands
// straight on the desktop, no lock screen, no password prompt.

class KeepAlive {
    constructor() {
        this.proc = null;
    }

    start() {
        if (this.proc) return;
        const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class KeepAwake {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
[KeepAwake]::SetThreadExecutionState(0x80000001) | Out-Null
while ($true) { Start-Sleep -Seconds 30 }
`;
        try {
            // One long-lived thread holding the flag for the process lifetime.
            this.proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore', windowsHide: true });
            this.proc.on('exit', () => { this.proc = null; });
            console.log('[KeepAlive] System standby prevention ON (ES_SYSTEM_REQUIRED)');
        } catch (e) {
            console.error('[KeepAlive] Failed to start:', e.message);
        }
    }

    stop() {
        if (!this.proc) return;
        try { this.proc.kill(); } catch { /* already gone */ }
        this.proc = null;
        console.log('[KeepAlive] System standby prevention OFF');
    }
}

class BioRecognizeBackend {
    constructor() {
        this.faceDetector = new (class {
            async load() { console.log('[FaceDetector] Initialized (simulated mode)'); }
            async detect(imagePath) {
                const seed = createHash('md5').update(imagePath + Date.now()).digest('hex').substring(0, 8);
                const confidence = 0.85 + (parseInt(seed, 16) % 15) / 100;
                const embedding = this._generateEmbedding(seed);
                return {
                    faces_detected: 1,
                    results: [{
                        bounding_box: [120, 80, 320, 280],
                        confidence: parseFloat(confidence.toFixed(3)),
                        embedding,
                        identity: null,
                        message: 'Face detected'
                    }]
                };
            }
            _generateEmbedding(seed) {
                const embedding = [];
                let hash = seed;
                for (let i = 0; i < 64; i++) {
                    hash = createHash('md5').update(hash + i.toString()).digest('hex');
                    embedding.push((parseInt(hash.substring(0, 8), 16) / 0xFFFFFFFF) * 2 - 1);
                }
                return embedding;
            }
        })();
        this.userManager = new UserManager();
        this.identity = new IdentityMatcher();
        this.inputMonitor = new InputMonitor();
        this.presence = new PresenceEngine(this.inputMonitor, this.identity);
    }
    
    async initialize() {
        if (isInitialized) return;
        
        console.log('\n========================================');
        console.log('  BioRecognize Backend v2');
        console.log('========================================\n');
        
        mkdirSync(MODELS_DIR, { recursive: true });
        this._loadConfig();
        this.inputMonitor.start();
        // Pre-warm the PowerShell worker + hidden black-window process so the
        // first away/return transition is ~100ms instead of ~3s.
        await this.presence.screen.warm();
        
        await this.faceDetector.load();

        // Identity matching: descriptor code + face cascade + reference set
        // built from the enrolled photos (cached in users.json afterwards).
        await this.identity.load();
        await this.identity.buildRefs(this.userManager.users);
        this.userManager.save();
        
        if (config.enabled) {
            this.presence.startDetection(config);
        }
        
        isInitialized = true;
        console.log('  Initialization complete!\n');
    }
    
    _loadConfig() {
        if (existsSync(CONFIG_FILE)) {
            try {
                const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
                // Runtime state written by a previous process must never be
                // restored: "isScreenBlack: true" from a session that was
                // killed mid-blackout would make the new process believe the
                // panel is off while it is actually on (and vice versa).
                delete data.isScreenBlack;
                delete data.lastSeen;
                Object.assign(config, data);
                // Not user-facing any more: with face recognition enabled the
                // plugin always judges by biometrics only (keyboard/mouse can
                // neither wake nor hold the screen) and always verifies WHO it
                // sees. A config file written by an older build must not be
                // able to switch either rule off.
                config.bioOnly = true;
                config.identityCheck = true;
                config.isScreenBlack = false;
                console.log('[Config] Loaded config');
            } catch (e) {
                console.error('[Config] Failed to load:', e.message);
            }
        }
    }
    
    _saveConfig() {
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    }
    
    async handleFaceRegister(data) {
        const { user_id, image_path, image_b64, mime } = data;
        if (!user_id || (!image_path && !image_b64)) {
            return { status: 'error', message: 'user_id and image_path or image_b64 are required' };
        }
        
        const userCheck = this.userManager.get(user_id);
        if (userCheck.status === 'error') {
            return { status: 'error', message: 'User not found' };
        }
        
        // Resolve target image path (local file or base64 capture)
        let targetPath = image_path;
        if (!targetPath && image_b64) {
            const ext = (mime && mime.includes('png')) ? 'png' : 'jpg';
            targetPath = saveBase64Payload(image_b64, ext);
            if (!targetPath) {
                return { status: 'error', message: 'Failed to decode image data' };
            }
        }
        
        const result = await this.faceDetector.detect(targetPath);
        if (result.faces_detected > 0 && result.results[0].embedding) {
            this.userManager.registerFace(user_id, result.results[0].embedding, targetPath);
            // Derive the real identity descriptor from the enrolment photo
            // (the legacy `embedding` above is a simulated placeholder).
            const vec = await this.identity.descriptorFromFile(targetPath);
            if (vec) {
                const u = this.userManager.users[user_id];
                if (u) {
                    u.face_descriptors = [Array.from(vec)];
                    this.userManager.save();
                    await this.identity.buildRefs(this.userManager.users);
                    console.log(`[Identity] enrolled 1 descriptor for ${user_id} (total ${this.identity.refs.length})`);
                }
            } else {
                console.warn('[Identity] enrolment photo has no usable face — identity check will stay inactive');
            }
            console.log(`[Face] Registered face for: ${user_id}`);
            return {
                status: 'success', user_id, confidence: result.results[0].confidence,
                identity_enrolled: !!vec, message: 'Face registered',
            };
        }
        return { status: 'error', message: 'No face found' };
    }

    async handleScreenControl(data) {
        const { action } = data;

        switch (action) {
            // Keep the persisted flag in sync: the state machine and the
            // watchdog both read it, and a manual toggle that leaves it stale
            // makes the engine believe the panel is on while it is black.
            case 'on': config.isScreenBlack = false; return this.presence.screen.turnOn();
            case 'off': config.isScreenBlack = true; return this.presence.screen.turnOff();
            case 'state': return this.presence.screen.getState();
            default: return { status: 'error', message: `Unknown action: ${action}` };
        }
    }

    async handleHeartbeat(data) {
        // Frontend periodically POSTs camera frames here. The frame itself is
        // NOT proof of presence (an idle browser tab keeps beating) — but the
        // client-side detection results are, and they are the ONLY thing that
        // counts when bioOnly is on.
        const now = Date.now();
        this.presence.lastHeartbeat = now;
        // Resumed after a gap (throttled tab, camera re-open, backend restart)?
        // Everything the client proved before the gap is worthless, and the
        // first frame after resuming usually has no face in it yet. Mark a
        // settle window: without it the engine read "no face" from that single
        // first beat and blanked the screen the instant the client came back —
        // the bizarre "it only goes black when I sit down again" symptom.
        const beatGap = this.presence.lastBeatAt ? now - this.presence.lastBeatAt : 0;
        if (beatGap > 1200) {
            this.presence.resumeAt = now;
            this.presence.presentSince = null;
            this.presence.absentStreakStart = null;
            this.presence.absentSince = null;
            this.presence.faceSeenAt = null;
            this.presence.lastNumericFaceAt = null;
            this.presence.actionTaken = false;
            if (beatGap > 3000) {
                console.log(`[Presence] Heartbeat resumed after ${Math.round(beatGap)}ms — settling`);
            }
        }
        // Measure the real sampling cadence (EMA). Everything that waits on
        // "how long since the last face" is scaled by this, so background-tab
        // throttling cannot masquerade as a flickering detector.
        if (this.presence.lastBeatAt) {
            const dt = now - this.presence.lastBeatAt;
            if (dt > 50 && dt < 5000) {
                this.presence.hbIntervalMs = this.presence.hbIntervalMs
                    ? this.presence.hbIntervalMs * 0.7 + dt * 0.3
                    : dt;
            }
        }
        this.presence.lastBeatAt = now;
        // Client-side camera diagnostics, surfaced through /presence so a dead
        // camera is visible from the pill instead of hiding behind "检测中".
        this.presence.clientDiag = {
            cam: data.cam || null,
            det: data.det || null,
            err: data.err || null,
            ms: typeof data.ms === 'number' ? data.ms : null,
            faces: typeof data.faces === 'number' ? data.faces : null,
            emb: data.emb || null,
            embMs: typeof data.embMs === 'number' ? data.embMs : null,
            migrate: data.migrate || null,
            backend: data.backend || null,
            nocam: data.nocam === true,
            at: now,
        };
        // Latch the "no camera device exists" statement: on while the client
        // keeps reporting it, off as soon as any camera actually opens.
        if (data.nocam === true) this.presence.noCam = true;
        else if (this.presence.clientDiag.cam === 'ok') this.presence.noCam = false;
        if (!this.presence.firstHeartbeatAt) {
            this.presence.firstHeartbeatAt = now;
            console.log('[Presence] Client checked in — presence actions armed');
        }

        // Face count: `null`/absent means the detector did not run this frame
        // (still loading, camera hiccup). Only a real number marks the
        // detector as usable — a missing detector must never be read as
        // "no face here".
        if (typeof data.faces === 'number') {
            this.presence.lastNumericFaceAt = now;
            if (data.faces >= 1) this.presence.faceSeenAt = now;
        }

        // Live face descriptor(s) (computed by the client with the same
        // vendor/facedesc.js code) → 1:N identity match. Up to 3 candidates:
        // the owner may not be the largest face in frame.
        // Live face descriptors → 1:N identity match. Two families:
        //   descs2 = 128-D CNN embedding computed by face-api.js in the browser
        //   descs  = 400-D legacy HOG (vendor/facedesc.js)
        // The CNN set wins; while it is active the legacy vectors are ignored
        // entirely, because that descriptor let a different person through.
        const v2List = Array.isArray(data.descs2) ? data.descs2 : [];
        const v1List = Array.isArray(data.descs) ? data.descs
            : (Array.isArray(data.desc) ? [data.desc] : []);
        // Prefer CNN, but accept the legacy vectors when the browser cannot
        // produce embeddings here — best() rejects any vector that has no
        // same-dimension reference, so a mismatched family can never match.
        const activeDim = this.identity.dim;
        const candidates = (activeDim === EMB_DIM_V2 && v2List.length)
            ? v2List
            : (v1List.length ? v1List : v2List);
        if (candidates.length && this.identity.ready) {
            let best = null;
            for (const d of candidates.slice(0, 3)) {
                if (!Array.isArray(d) || d.length < 32) continue;
                const vec = Float32Array.from(d);
                const s = this.identity.best(vec).score;
                if (s < 0) continue;   // no reference of this dimension
                if (!best || s > best.score) best = { score: s, vec };
            }
            if (best) {
                const thr = this.identity.threshFor(best.vec);
                const { score, userId } = this.identity.update(best.vec, thr);
                if (userId) this._maybeEnroll(userId, best.vec, score, thr);
            }
        }

        const faceAge = this.presence.faceSeenAt
            ? Math.round((now - this.presence.faceSeenAt) / 1000)
            : null;
        return {
            status: 'success',
            faces: data.faces ?? null,
            faceSeenSecondsAgo: faceAge,
            lastHeartbeat: this.presence.lastHeartbeat
        };
    }
    
    // Auto-enrolment: a high-confidence match widens the reference set, so
    // new poses / lighting / glasses do not erode recognition over time.
    // Capped, deduplicated, and rate-limited so a single lucky false match
    // cannot poison the profile.
    _maybeEnroll(userId, vec, score, thr) {
        if (config.learnFaces === false) return;
        const isV2 = vec.length === EMB_DIM_V2;
        // CNN frames of the SAME person sit at 0.975+ (measured), so the
        // enrolment margin can be small; a stranger never gets close to the
        // 0.92 threshold, which keeps the reference set clean.
        if (!userId || score < thr + (isV2 ? 0.02 : 0.12)) return;
        const u = this.userManager.users[userId];
        if (!u) return;
        // v2 vectors live in their own array: mixing 128-D and 400-D samples
        // would create a reference set that silently never matches.
        const key = isV2 ? 'face_descriptors_v2' : 'face_descriptors';
        const list = Array.isArray(u[key]) ? u[key] : (u[key] = []);
        if (list.length >= (isV2 ? 12 : 8)) return;
        if (!this._learnAt) this._learnAt = new Map();
        const now = Date.now();
        if (now - (this._learnAt.get(userId) || 0) < 30000) return;
        // Same-person CNN frames sit at 0.95+; 0.985 means "already have it".
        const dupThr = isV2 ? 0.985 : 0.92;
        for (const v of list) {
            if (!Array.isArray(v) || v.length !== vec.length) continue;
            if (this.identity.sim(vec, Float32Array.from(v)) > dupThr) {
                this._learnAt.set(userId, now);
                return;
            }
        }
        list.push(Array.from(vec, x => Math.round(x * 1e5) / 1e5));
        this.identity.refs.push({ userId, vec: Float32Array.from(vec), dim: vec.length });
        this.identity.dim = isV2 ? EMB_DIM_V2 : (this.identity.dim || vec.length);
        this.identity.enrolled = this.identity.refs.length;
        this._learnAt.set(userId, now);
        this.userManager.save();
        console.log(`[Identity] auto-enrolled sample #${list.length} for ${userId} (score ${score.toFixed(3)})`);
    }

    // Explicit enrolment with CNN embeddings. The browser computes them (it has
    // the models) from the stored registration photo or from a live frame.
    async handleIdentityEnroll(data) {
        if (!this.identity.ready) return { status: 'error', message: 'identity not ready' };
        const users = this.userManager.users;
        let userId = data.user_id || data.userId;
        if (!userId) userId = Object.keys(users)[0];
        if (!userId || !users[userId]) return { status: 'error', message: 'user not found' };
        const descs = Array.isArray(data.descriptors) ? data.descriptors
            : (Array.isArray(data.descriptor) ? [data.descriptor] : []);
        if (!descs.length) return { status: 'error', message: 'no descriptors' };
        const r = await this.identity.enrollV2(users, userId, descs);
        if (r.status === 'success') {
            this.userManager.save();
            // A new reference set invalidates the old hysteresis state.
            this.identity.matched = false;
            this.identity.ema = null;
            this.identity.lastAt = null;
        }
        return r;
    }

    async handleConfigUpdate(data) {
        if (data.enabled !== undefined) config.enabled = data.enabled;
        if (data.faceEnabled !== undefined) config.faceEnabled = data.faceEnabled;
        if (data.noCamMode !== undefined) config.noCamMode = !!data.noCamMode;
        if (data.noCamIdleSec !== undefined) config.noCamIdleSec = Math.min(Math.max(parseInt(data.noCamIdleSec, 10) || 300, 10), 3600);
        if (data.detectionInterval !== undefined) config.detectionInterval = data.detectionInterval;
        if (data.absentThreshold !== undefined) config.absentThreshold = data.absentThreshold;
        if (data.faceGraceMs !== undefined) config.faceGraceMs = Math.min(Math.max(parseInt(data.faceGraceMs, 10) || 550, 400), 3000);
        if (data.awayDelayMs !== undefined) config.awayDelayMs = Math.min(Math.max(parseInt(data.awayDelayMs, 10) || 400, 300), 5000);
        if (data.bioOnly !== undefined) config.bioOnly = true;   // not user-facing any more
        if (data.wakeHoldMs !== undefined) config.wakeHoldMs = Math.min(Math.max(parseInt(data.wakeHoldMs, 10) || 250, 100), 3000);
        if (data.minBlackMs !== undefined) config.minBlackMs = Math.min(Math.max(parseInt(data.minBlackMs, 10) || 700, 0), 5000);
        if (data.wakeGuardMs !== undefined) config.wakeGuardMs = Math.min(Math.max(parseInt(data.wakeGuardMs, 10) || 2000, 0), 10000);
        if (data.identityCheck !== undefined) config.identityCheck = true;  // ditto
        if (data.matchThreshold !== undefined) config.matchThreshold = Math.min(Math.max(parseFloat(data.matchThreshold) || 0.65, 0.3), 0.95);
        if (data.matchThresholdV2 !== undefined) config.matchThresholdV2 = Math.min(Math.max(parseFloat(data.matchThresholdV2) || THRESH_V2_DEFAULT, 0.60), 0.98);
        if (data.learnFaces !== undefined) config.learnFaces = !!data.learnFaces;
        if (data.manualOverrideMs !== undefined) config.manualOverrideMs = Math.min(Math.max(parseInt(data.manualOverrideMs, 10) || 3000, 0), 20000);

        // Any judgement-rule change starts from a clean slate — stale streaks
        // from the previous rule would otherwise fire an action immediately.
        this.presence.presentSince = null;
        this.presence.absentStreakStart = null;
        this.presence.absentSince = null;
        this.presence.inputActiveSince = null;
        this.presence.actionTaken = false;
        
        this._saveConfig();
        
        if (config.enabled) {
            this.presence.startDetection(config);
        } else {
            this.presence.stopDetection();
            this.presence.screen.turnOn();
        }
        
        return { status: 'success', config };
    }
    
    async handlePresenceStatus() {
        const hbAge = this.presence.lastHeartbeat
            ? Math.round((Date.now() - this.presence.lastHeartbeat) / 1000)
            : null;
        const idle = this.inputMonitor.getIdleSeconds();
        const faceAge = this.presence.faceSeenAt
            ? Math.round((Date.now() - this.presence.faceSeenAt) / 1000)
            : null;
        return {
            status: config.enabled ? 'active' : 'inactive',
            state: this.presence.state,
            lastSeen: config.lastSeen,
            screen: this.presence.screen.getState(),
            // Diagnostics: why presence reads the way it does
            inputIdleSeconds: idle === null ? null : Math.round(idle * 10) / 10,
            // ms precision: face loss latency is sub-second now
            faceSeenMsAgo: this.presence.faceSeenAt ? Date.now() - this.presence.faceSeenAt : null,
            faceGraceMs: config.faceGraceMs || 600,
            awayDelayMs: config.awayDelayMs || 700,
            faceSeenSecondsAgo: faceAge,
            heartbeatAgeSeconds: hbAge,
            armed: !!this.presence.armed,
            // Biometric gating diagnostics
            bioOnly: config.bioOnly !== false,
            bioSignals: {
                face: !!(config.faceEnabled && this.presence.lastNumericFaceAt &&
                    Date.now() - this.presence.lastNumericFaceAt < 5000),
            },
            // What the browser side thinks of its own camera — without this the
            // UI could only say "检测中" while the camera was in fact dead.
            client: this.presence.clientDiag || null,
            noCam: !!this.presence.noCam,
            fallbackActive: !!this.presence.fallback,
            blackForMs: this.presence.screen.blackSince ? Date.now() - this.presence.screen.blackSince : null,
            presentForMs: this.presence.presentSince ? Date.now() - this.presence.presentSince : null,
            absentForMs: this.presence.absentStreakStart ? Date.now() - this.presence.absentStreakStart : null,
            lastReason: this.presence.reason,
            identity: {
                enabled: config.identityCheck !== false,
                ready: !!this.identity.ready,
                refs: this.identity.refs.length,
                // 128 = CNN embeddings (face-api.js), 400 = legacy HOG.
                // `activeDim` is what the client is actually sending right now,
                // so a silent fallback to the weak descriptor can never
                // masquerade as "only me" protection.
                refsV2: this.identity.refsV2 || 0,
                refsV1: this.identity.refsV1 || 0,
                dim: this.identity.dim || null,
                activeDim: this.identity.lastDim || null,
                mode: this.identity.dim === EMB_DIM_V2 ? 'cnn' : (this.identity.dim ? 'legacy' : 'none'),
                needsV2: !(this.identity.refsV2 > 0),
                score: this.identity.lastScore == null ? null : Math.round(this.identity.lastScore * 100) / 100,
                ema: this.identity.ema == null ? null : Math.round(this.identity.ema * 100) / 100,
                matched: !!this.identity.matched,
                // self / other / unknown — 'unknown' is the grey band that must
                // not wake a black screen (see checkPresence step 1.5).
                verdict: this.identity.verdict || null,
                userId: this.identity.lastUserId || null,
                threshold: this.identity.dim === EMB_DIM_V2
                    ? (config.matchThresholdV2 ?? THRESH_V2_DEFAULT)
                    : (config.matchThreshold || THRESH_V1_DEFAULT),
                enforced: !!this.presence.idRequired,
                error: this.identity.error || null,
            },
        };
    }
}

// ============================================================
// HTTP Server
// ============================================================

const backend = new BioRecognizeBackend();

// Set to true only after initialize() finishes. The port is bound BEFORE the
// (slow) warm-up so /health answers instantly and the host's "start service"
// call never times out. Non-health routes reply 503 while not ready.
let ready = false;

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Static vendor assets for the client-side face detector (pico.js) and
    // the shared face descriptor. Served even during initialization — the
    // client may fetch them early.
    // Static vendor assets: pico.js / facefinder / facedesc.js (legacy) plus
    // the face-api.js bundle and its model weights (vendor/faceapi/**), which
    // the browser needs for real 128-D face embeddings.
    if (req.url.startsWith('/vendor/')) {
        try {
            const root = join(__dirname, 'vendor');
            const rel = decodeURIComponent(req.url.slice('/vendor/'.length).split('?')[0]);
            const abs = join(root, rel);
            if (!abs.startsWith(root)) throw new Error('path escape');
            if (!/\.(js|json|bin|wasm)$/i.test(abs)) throw new Error('bad extension');
            const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
            const type = ext === '.js' ? 'text/javascript'
                : ext === '.json' ? 'application/json'
                    : ext === '.wasm' ? 'application/wasm'
                        : 'application/octet-stream';
            const buf = readFileSync(abs);
            res.writeHead(200, {
                'Content-Type': type,
                'Content-Length': buf.length,
                'Cache-Control': 'no-cache',
            });
            res.end(buf);
        } catch (e) {
            res.writeHead(404);
            res.end('not found');
        }
        return;
    }

    if (req.url === '/pico.js' || req.url === '/facefinder' || req.url === '/facedesc.js') {
        try {
            const name = req.url === '/pico.js' ? 'pico.js'
                : req.url === '/facedesc.js' ? 'facedesc.js'
                : 'facefinder';
            res.writeHead(200, {
                'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream',
                'Cache-Control': 'no-cache',
            });
            res.end(readFileSync(join(__dirname, 'vendor', name)));
        } catch (e) {
            res.writeHead(404);
            res.end('not found');
        }
        return;
    }

    // The enrolled registration photo, so the browser can compute the 128-D
    // embedding of the ORIGINAL enrolment image and migrate the reference set
    // automatically (no "please re-enrol" step for the user).
    // Restricted to that single file — never a directory listing.
    if (req.url === '/face-image') {
        try {
            const users = backend?.userManager?.users || {};
            let file = null;
            for (const u of Object.values(users)) {
                if (u && u.face_image && existsSync(u.face_image)) { file = u.face_image; break; }
            }
            if (!file) throw new Error('no enrolled photo');
            const buf = readFileSync(file);
            const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
            res.writeHead(200, {
                'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg',
                'Content-Length': buf.length,
                'Cache-Control': 'no-cache',
            });
            res.end(buf);
        } catch (e) {
            res.writeHead(404);
            res.end('not found');
        }
        return;
    }

    // Liveness probe — answered immediately, even mid-initialization.
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ready, timestamp: new Date().toISOString() }));
        return;
    }

    if (!ready) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'starting', message: 'Backend is still initializing' }));
        return;
    }
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        let data = {};
        try {
            if (body) data = JSON.parse(body);
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON' }));
            return;
        }
        
        let result;
        
        switch (req.url) {
            case '/health':
                result = { status: 'ok', timestamp: new Date().toISOString() };
                break;
                
            case '/users':
                if (req.method === 'GET') {
                    result = { status: 'success', users: backend.userManager.list() };
                } else if (req.method === 'POST') {
                    result = await backend.userManager.add(data.user_id, data.name);
                } else {
                    result = { status: 'error', message: 'Method not allowed' };
                }
                break;
                
            case /^\/users\/.+/.test(req.url) ? req.url : null:
                if (req.url?.startsWith('/users/')) {
                    const userId = req.url.replace('/users/', '');
                    if (req.method === 'GET') {
                        result = backend.userManager.get(userId);
                    } else if (req.method === 'DELETE') {
                        result = backend.userManager.remove(userId);
                    } else {
                        result = { status: 'error', message: 'Method not allowed' };
                    }
                } else {
                    result = { status: 'error', message: 'Not found' };
                }
                break;
                
            case '/register/face':
                result = await backend.handleFaceRegister(data);
                break;

            // 128-D CNN descriptors, computed by the browser (it has the
            // face-api models). Used both for the automatic migration of the
            // existing registration photo and for explicit re-enrolment.
            case '/identity/enroll':
                result = await backend.handleIdentityEnroll(data);
                break;

            case '/face/detect':
                result = await backend.faceDetector.detect(data.image_path);
                break;

            case '/screen':
                result = await backend.handleScreenControl(data);
                break;
                
            case '/config':
                if (req.method === 'GET') {
                    result = { status: 'success', config };
                } else if (req.method === 'POST') {
                    result = await backend.handleConfigUpdate(data);
                } else {
                    result = { status: 'error', message: 'Method not allowed' };
                }
                break;
                
            case '/heartbeat':
                result = await backend.handleHeartbeat(data);
                break;
                
            case '/presence':
                result = await backend.handlePresenceStatus();
                break;
                
            default:
                result = { status: 'error', message: 'Not found' };
        }
        
        const statusCode = result.status === 'error' ? 400 : 200;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    });
});

const port = parseInt(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] || DEFAULT_PORT);
const host = process.argv.find(arg => arg.startsWith('--host='))?.split('=')[1] || '127.0.0.1';
BACKEND_PORT = port;

// Bind the port FIRST: the host's start-service call health-checks this port,
// and initialization now pre-warms a resident PowerShell worker + models.
// Listening immediately makes "start" succeed instantly; heavy work follows.
server.listen(port, host, () => {
    // Publish our own PID: the host's "stop" button reads this file, and a
    // stale value (written by an older instance) turned stop into a no-op.
    try { writeFileSync(join(MODELS_DIR, '.server.pid'), String(process.pid), 'utf8'); } catch {}
    console.log(`\n========================================`);
    console.log(`  BioRecognize Backend v2 Listening`);
    console.log(`========================================`);
    console.log(`  Host:    http://${host}:${port}`);
    console.log(`  Models:  ${MODELS_DIR}`);
    console.log(`  PID:     ${process.pid}`);
    console.log('========================================\n');
});

backend.initialize().then(() => {
    ready = true;
    console.log('  Initialization complete! Ready for requests.');
    console.log('Endpoints:');
    console.log('  POST /users              - Add user');
    console.log('  GET  /users              - List users');
    console.log('  POST /register/face      - Register face');
    console.log('  POST /screen             - Control screen (on/off)');
    console.log('  POST /config             - Update config');
    console.log('  GET  /presence           - Check presence');
    console.log('');
}).catch(err => {
    console.error('Failed to initialize:', err);
    process.exit(1);
});

process.on('SIGINT', shutdown);
// SIGTERM: Node on Windows maps a hard kill to TerminateProcess (no handler
// runs), but a graceful job-object close does deliver it — and a backend that
// exits while the screen is black must never leave the user stranded.
process.on('SIGTERM', shutdown);
// Last-resort: whatever the reason for exiting, make sure the overlay is told
// to hide before the process disappears. Synchronous on purpose.
process.on('exit', () => {
    try { backend.presence.screen.isBlack = false; writeFileSync(join(MODELS_DIR, '_black_state.txt'), '0', 'utf8'); } catch { /* noop */ }
});

let shuttingDown = false;
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    try { backend.presence.stopDetection(); } catch { /* noop */ }
    try { backend.presence.screen.turnOn(); } catch { /* noop */ }
    try { server.close(() => process.exit(0)); } catch { process.exit(0); }
    setTimeout(() => process.exit(0), 1500).unref();
}
