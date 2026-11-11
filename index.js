/**
 * BioRecognize DSH Plugin - Face Biometric Recognition & Smart Screen Off
 *
 * Features:
 * - Face registration (overwrite allowed) with CNN identity matching
 * - Smart screen control: black screen when away, wake when the owner returns
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { spawn, execFileSync } from 'child_process';
import { createWriteStream, readFileSync, writeFileSync, statSync, unlinkSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const inject = ['tools', 'connection'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, 'server.js');
const SERVER_PORT = 8765;

// Track a running server process (module-level, survives tool calls)
let serverProcess = null;
let serverStarting = false;

/**
 * Ensure the backend server is running. Spawns node server.js if the port is not
 * already serving. Idempotent: returns immediately if health responds.
 */
async function ensureServer() {
    // Resolve the REAL owner of the port first — never the /health answer.
    //
    // /health is served by whatever process holds the socket, and a wedged
    // backend can hold the socket while its event loop is too busy to answer
    // (field evidence: /presence silent for 10s, health replying intermittently
    // while one core burned at 90%). Trusting /health alone spawned a fresh
    // copy against an occupied port; that copy died on EADDRINUSE, and the
    // stale code kept running — "I restarted DSH and nothing changed", again.
    let livePid = listenerPid(SERVER_PORT);
    if (livePid) {
        const ours = readPidFile();
        // Two independent reasons to replace it:
        //   - the pid file names someone else (or nobody): it is not ours;
        //   - it IS "ours" but started before server.js was last written, so
        //     it is running code we have already replaced. Without this the
        //     backend survived every restart untouched and every fix looked
        //     like it had done nothing.
        const stale = (livePid === ours) && backendRunsStaleCode(livePid);
        // The port owner is the truth. If the file names a process that no
        // longer exists, drop the file now so diagnostics stop chasing it.
        if (ours && ours !== livePid && !pidAlive(ours)) {
            try { unlinkSync(join(__dirname, 'models', '.server.pid')); } catch { /* noop */ }
        }
        if (livePid !== ours || stale) {
            console.log(`[Plugin] Port ${SERVER_PORT} is held by pid ${livePid} ` +
                `(pidfile: ${ours || 'none'}${stale ? ', started before server.js was last modified' : ''}) — replacing it`);
            // Order matters: ask it to quit over HTTP first. That needs no
            // process rights, so it also works when the old backend runs with
            // higher privileges than us ("taskkill: 拒绝访问").
            if (await requestShutdown()) {
                await waitPortFree(5000);
            }
            if (listenerPid(SERVER_PORT) && !(await replaceStaleBackend())) {
                // Deliberately NOT spawning a second copy: it would die on
                // EADDRINUSE and the user would be told "started" while
                // nothing serves. Report the blocker instead.
                const pid = listenerPid(SERVER_PORT);
                return {
                    running: false,
                    pid: pid || livePid,
                    error: `端口 ${SERVER_PORT} 被进程 ${pid || livePid} 占用且无法结束（可能是以管理员权限启动的）。` +
                        `请以管理员身份执行：taskkill /PID ${pid || livePid} /F，然后再点启动服务。`,
                };
            }
            livePid = listenerPid(SERVER_PORT);
        }
        if (livePid) {
            const up = await probeHealth();
            return { running: true, pid: livePid, message: up ? 'Server already running' : 'Server running (health slow — port is held)' };
        }
    }

    // Another start is already in flight (e.g. the auto-start fired on plugin
    // load). Wait for it to finish instead of claiming success immediately —
    // the user clicked "start" and expects a verdict, not a guess.
    if (serverProcess || serverStarting) {
        const up = await waitHealth(25000);
        return {
            running: up,
            pid: serverProcess?.pid || null,
            message: up ? 'Server started' : 'Server process launched but health check failed',
        };
    }

    serverStarting = true;
    try {
        sweepOrphanBlackWindows();
        sweepZombieBackends();
        // Detached so the backend outlives a DSH restart; pid file for later stop.
        const pidFile = join(__dirname, 'models', '.server.pid');
        serverProcess = spawn(process.execPath, [SERVER_SCRIPT], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });
        const childPid = serverProcess.pid;
        // Wire the log BEFORE anything else can fail. A child that dies on
        // EADDRINUSE exits in a few milliseconds, and with the pipes attached
        // afterwards its only explanation ("bind failed") was discarded — the
        // pid file then pointed at a dead pid, /presence kept answering from
        // the old process, and the restart looked like a no-op.
        try {
            const logFile = join(__dirname, 'models', 'server.log');
            const logStream = createWriteStream(logFile, { flags: 'a' });
            const stamp = () => Buffer.from(`\n=== ${new Date().toISOString()} ===\n`);
            logStream.write(stamp());
            serverProcess.stdout?.on('data', d => logStream.write(d));
            serverProcess.stderr?.on('data', d => logStream.write(d));
            serverProcess.on('exit', () => { try { logStream.end(); } catch {} });
        } catch { /* logging is best-effort */ }
        // Write the pid IMMEDIATELY (not after the health check): a DSH
        // restart during the boot window would otherwise leave a stale pid
        // file, and the next ensureServer would treat our own fresh backend
        // as a foreign process and kill it.
        try { writeFileSync(pidFile, String(childPid)); } catch { /* best effort */ }
        serverProcess.on('error', (e) => {
            console.error(`[Plugin] backend spawn failed: ${e?.message || e}`);
            serverProcess = null; serverStarting = false;
        });
        serverProcess.on('exit', (code) => {
            // The pid file must never outlive the process it names: a stale
            // entry makes the NEXT start believe a backend is running.
            try { if (readPidFile() === childPid) unlinkSync(pidFile); } catch { /* noop */ }
            if (!serverProcess || serverProcess.pid === childPid) { serverProcess = null; serverStarting = false; }
            const holder = listenerPid(SERVER_PORT);
            if (holder && holder !== childPid) {
                console.error(`[Plugin] backend pid ${childPid} exited (code ${code}) while pid ${holder} still holds port ${SERVER_PORT} — that process is running old code`);
            }
        });
        serverProcess.unref();
        serverStarting = false;
        // Poll health until the backend answers (it pre-warms a resident
        // PowerShell worker + models at boot, so first start can take a few
        // seconds). Previously a fixed 4s window made "start" report failure
        // while the server was in fact still booting.
        const up = await waitHealth(25000);
        return { running: up, pid: serverProcess?.pid || null, message: up ? 'Server started' : 'Server process launched but health check failed' };
    } finally {
        if (serverStarting) serverStarting = false;
    }
}

// Poll /health every 400ms until it answers or the budget runs out.
async function waitHealth(budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (await probeHealth()) return true;
        if (serverProcess === null && !serverStarting) return false; // spawned process died
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}

async function probeHealth() {
    return await new Promise(resolve => {
        const req = http.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: '/health', method: 'GET', timeout: 1500 },
            res => { res.resume(); res.on('end', () => resolve(true)); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

// A backend that lost the bind race stays alive but owns nothing: no socket,
// no client, only a presence loop and ~60MB. Found in the field after a failed
// replace — one at 0% CPU, a harmless-looking leftover that still shows up in
// the process list and confuses every later diagnosis. Sweep them.
function sweepZombieBackends() {
    try {
        const out = execFileSync('powershell', ['-NoProfile', '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
            "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*bio-recognize*server.js*' } | " +
            'Select-Object -ExpandProperty ProcessId',
        ], { encoding: 'utf8', timeout: 15000 });
        const pids = out.split(/\s+/).map(s => parseInt(s, 10)).filter(p => p > 0);
        const live = listenerPid(SERVER_PORT);
        let swept = 0;
        for (const p of pids) {
            if (p === live) continue;            // the real backend: handled by replaceStaleBackend
            if (p === serverProcess?.pid) continue;
            try { execFileSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); swept++; } catch {}
        }
        if (swept) console.log(`[Plugin] swept ${swept} zombie backend process(es)`);
    } catch { /* best effort */ }
}

function readPidFile() {
    try { return parseInt(readFileSync(join(__dirname, 'models', '.server.pid'), 'utf8').trim(), 10) || 0; }
    catch { return 0; }
}

// Ask the backend to exit on its own. Requires nothing but a socket, which is
// the whole point: a higher-privileged process cannot be signalled by us, but
// it can always answer its own HTTP port.
async function requestShutdown() {
    return await new Promise(resolve => {
        const req = http.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: '/shutdown', method: 'POST', timeout: 2000 },
            res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

async function waitPortFree(budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (!listenerPid(SERVER_PORT)) return true;
        await new Promise(r => setTimeout(r, 250));
    }
    return !listenerPid(SERVER_PORT);
}

// Kill a backend we did not start (pid file mismatch) and free the port.
// Returns true when the port is free and a fresh spawn should follow.
async function replaceStaleBackend() {
    const live = listenerPid(SERVER_PORT);
    if (!live) return false;                     // nothing to replace
    const ours = readPidFile();
    if (ours && live === ours) return false;     // ours, in sync

    // 1) Ask it to quit over HTTP — privilege-free.
    if (await requestShutdown() && await waitPortFree(4000)) return true;

    // 2) Fall back to a signal.
    let signalled = false;
    try {
        execFileSync('taskkill', ['/PID', String(live), '/T', '/F'], { stdio: 'ignore', timeout: 8000 });
        signalled = true;
    } catch {
        try { process.kill(live, 'SIGTERM'); signalled = true; } catch { signalled = false; }
    }
    if (!signalled) {
        console.error(`[Plugin] Cannot stop pid ${live} holding port ${SERVER_PORT} — insufficient privileges.`);
        return false;
    }
    if (await waitPortFree(5000)) return true;
    console.error(`[Plugin] pid ${live} was signalled but still holds port ${SERVER_PORT}.`);
    return false;
}

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

// When did this process start, in epoch ms? 0 when it cannot be determined.
//
// ToFileTimeUtc()/10000 - 11644473600000 is exact and locale-free; formatting
// CreationDate as a string and parsing it back breaks on a Chinese locale
// ("2026/11/10 17:28:58"), and this value decides whether we kill a process.
function processStartMs(pid) {
    if (!pid) return 0;
    try {
        const out = execFileSync('powershell', ['-NoProfile', '-Command',
            `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
            'if($p){[int64]($p.CreationDate.ToFileTimeUtc()/10000-11644473600000)}',
        ], { encoding: 'utf8', timeout: 10000 }).trim();
        const ms = parseInt(out, 10);
        return Number.isFinite(ms) && ms > 0 ? ms : 0;
    } catch { return 0; }
}

// Is the backend on the port running OLD code?
//
// The pid file matched and the port was held, so ensureServer used to answer
// "already running" — even when that process had been started BEFORE server.js
// was last edited. Field evidence: the backend was 8 minutes older than the
// fix, so every restart "changed nothing", the plugin kept the behaviour that
// had just been fixed, and the pid file pointed at a pid that had long since
// died. Comparing the process start time with the file's mtime is the only
// check that answers the question the user is actually asking.
function backendRunsStaleCode(pid, codeFile = SERVER_SCRIPT) {
    const started = processStartMs(pid);
    if (!started) return false;                 // unknown → never kill blindly
    try {
        const codeMtime = statSync(codeFile).mtimeMs;
        return started + 2000 < codeMtime;      // 2s covers write/boot ordering
    } catch { return false; }
}

// Whoever is LISTENING on the backend port — that is the real backend, no
// matter who started it (plugin, dsh auto-start, a terminal, a previous run).
function listenerPid(port) {
    try {
        const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000 });
        for (const line of out.split(/\r?\n/)) {
            if (!line.includes('LISTENING')) continue;
            const cols = line.trim().split(/\s+/);
            if (cols.length < 5) continue;
            const local = cols[1];
            if (!local.endsWith(':' + port)) continue;
            const pid = parseInt(cols[cols.length - 1], 10);
            if (pid > 0) return pid;
        }
    } catch { /* netstat unavailable */ }
    return 0;
}

// Leftover black-overlay windows from a previous run keep reacting to the
// shared state file and can flash a full-screen black window the moment the
// backend boots. Nothing else owns them once their server died, so sweep them
// before starting a new instance.
function sweepOrphanBlackWindows() {
    try {
        const out = execFileSync('powershell', ['-NoProfile', '-Command',
            // $PID exclusion: the query's own command line contains the
            // pattern, so a naive filter makes the sweep kill itself first.
            "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*-File*_black_win.ps1*' } | Select-Object -ExpandProperty ProcessId"
        ], { encoding: 'utf8', timeout: 15000 });
        const pids = out.split(/\s+/).map(s => parseInt(s, 10)).filter(p => p > 0);
        for (const p of pids) {
            try { execFileSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {}
        }
        if (pids.length) console.log(`[Plugin] swept ${pids.length} orphan black-window process(es)`);
    } catch { /* best effort */ }
}

async function stopServer() {
    const pidFile = join(__dirname, 'models', '.server.pid');
    const fs = await import('fs');
    const dropPidFile = () => { try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch {} };

    const alive = await probeHealth();

    // Resolve the real backend PID. A stale pid file used to make "stop" a
    // no-op (signal sent to a dead PID, health probe timed out, UI reported
    // "stopped" while the server kept running), so validity is checked and
    // the port owner is used as the fallback.
    let pid = serverProcess?.pid || 0;
    if (!pid) {
        let fromFile = 0;
        try { if (fs.existsSync(pidFile)) fromFile = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) || 0; } catch {}
        if (fromFile && pidAlive(fromFile)) pid = fromFile;
    }
    if (!pid || !pidAlive(pid)) pid = listenerPid(SERVER_PORT);

    if (!pid) {
        dropPidFile();
        return { running: alive, message: alive
            ? '未找到可结束的后端进程（端口 8765 被占用但无法定位 PID）'
            : 'stopped' };
    }

    // Restore the display BEFORE killing anything: if the backend is stopped
    // while the screen is black, brightness stays 0 and the overlay window
    // survives until its watchdog notices — which looks like "stopping the
    // service blacks the screen".
    try { await callBackend('/screen', { action: 'on' }, { backendUrl: `http://127.0.0.1:${SERVER_PORT}` }); } catch {}

    // Privilege-free path first: a backend started by an elevated DSH cannot
    // be signalled from a normal-privilege context, but it always answers its
    // own port.
    if (await requestShutdown()) await waitPortFree(3000);

    // /T kills the whole tree: the resident PowerShell worker and the black
    // overlay window are children of the server and would otherwise survive
    // as orphans, piling up on every restart.
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 }); }
    catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    serverProcess = null;
    serverStarting = false;
    dropPidFile();

    // "Signal sent" is not proof — wait for the port to actually close.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
        if (!(await probeHealth())) return { running: false, message: 'stopped' };
        await new Promise(r => setTimeout(r, 200));
    }
    return { running: true, message: '后端仍在运行：结束进程失败' };
}

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8765';

async function callBackend(endpoint, data, config) {
  const backendUrl = config?.backendUrl || DEFAULT_BACKEND_URL;
  const url = `${backendUrl}${endpoint}`;
  
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    };
    
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ status: 'error', message: 'Invalid response' }); }
      });
    });
    
    req.on('error', err => resolve({ status: 'backend_error', message: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', endpoint }); });
    req.write(JSON.stringify(data));
    req.end();
  });
}

async function callBackendGet(endpoint, config) {
  const backendUrl = config?.backendUrl || DEFAULT_BACKEND_URL;
  const url = `${backendUrl}${endpoint}`;
  
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname,
      method: 'GET'
    };
    
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ status: 'error', message: 'Invalid response' }); }
      });
    });
    
    req.on('error', err => resolve({ status: 'backend_error', message: err.message }));
    req.end();
  });
}

function renderJson(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

export function apply(ctx, config) {
  const pluginConfig = config || {};

  // ============================================================
  // Client-facing Management RPC (Host side)
  // Exposes start/stop/status of the backend server.js process to the
  // browser UI via the DSH /api carrier.
  // ============================================================

  if (ctx?.connection?.fetch?.register) {
    const unregister = ctx.connection.fetch.register({
      path: '/api/bio-recognize',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let message;
        try { message = await request.json(); }
        catch {
          return Response.json({ type: 'server-response', rpcId: 'invalid-request', result: { ok: false, error: { code: 'bad-request', message: 'Body is not JSON', details: {} } } });
        }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
        const call = message?.payload;
        const method = call?.method;

        // The DSH connection protocol REQUIRES the envelope to be either
        //   result: { ok: true,  value: <any> }
        //   result: { ok: false, error: { code: string, message: string, details: object } }
        // Anything else makes the client throw
        // "TypeError: connection: invalid server-response result", masking the
        // real error. So: always answer with ok:true at the ENVELOPE level and
        // carry the plugin's own success/failure inside `value` (the client UI
        // reads value.ok / value.result / value.error).
        const reply = (value) => Response.json({
          type: 'server-response',
          rpcId,
          result: {
            ok: true,
            value: {
              ...value,
              _diag: { receivedMethod: message?.method ?? null, endpoint: message?.endpoint ?? null, handled: method },
            },
          },
        });

        if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
            || !['/api/bio-recognize', 'bio-recognize'].includes(message.method)
            || !isRecord(call) || typeof method !== 'string') {
          return reply({ ok: false, error: { code: 'bad-request', message: 'Invalid BioRecognize management request', details: {} } });
        }

        try {
          switch (method) {
            case 'start': {
              const r = await ensureServer();
              if (!r.running) {
                return reply({ ok: false, result: r, error: { code: 'start-failed', message: r.message || '后端服务启动超时', details: {} } });
              }
              return reply({ ok: true, result: r });
            }
            case 'stop': {
              const r = await stopServer();
              // ok only when the port really closed — a sent signal is not proof.
              return reply({ ok: !r.running, result: r });
            }
            case 'status': {
              let alive = await probeHealth();
              // A managed process may still be booting (pre-warm + models).
              // Give it a short grace window so the UI doesn't flash "offline".
              if (!alive && (serverProcess || serverStarting)) alive = await waitHealth(8000);
              return reply({ ok: true, result: { running: alive, managedPid: serverProcess?.pid || null, message: alive ? 'Backend online' : 'Backend offline' } });
            }
            default:
              return reply({ ok: false, error: { code: 'unknown-method', message: `Unknown method: ${method}`, details: {} } });
          }
        } catch (e) {
          return reply({ ok: false, error: { code: 'handler-failed', message: e?.message || 'Management handler failed', details: {} } });
        }
      },
    });
    // Plugin deactivation / uninstall: the backend is detached on purpose, so
    // without an explicit cleanup here it outlives the plugin (the host just
    // deletes the directory) and keeps dimming the screen on its own — the
    // "uninstalled but the screen still goes dark" report. stopServer restores
    // brightness BEFORE killing the tree, so the display is always left sane.
    ctx.effect?.(() => () => { stopServer().catch(() => {}); });

  // Auto-start backend on plugin activation (fire-and-forget; UI can re-trigger)
  ensureServer().catch(() => {});
  }

  function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  async function probeHealth() {
    return await new Promise(resolve => {
      const req = http.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: '/health', method: 'GET', timeout: 1500 },
        res => { res.resume(); res.on('end', () => resolve(true)); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  // ============================================================
  // Registration Tools
  // ============================================================

  ctx.tools.register({
    name: 'biometric_register_face',
    description: 'Register face for a user. Max 1 face per user - new registration overwrites previous. Requires user to exist first.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'User identifier' },
        image_path: { type: 'string', description: 'Path to face image (JPG/PNG)' }
      },
      required: ['user_id', 'image_path']
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, user_id: { type: 'string' }, confidence: { type: 'number' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      return await callBackend('/register/face', { user_id: args.user_id, image_path: args.image_path }, pluginConfig);
    }
  });

  // ============================================================
  // Detection Tools
  // ============================================================

  ctx.tools.register({
    name: 'biometric_face_detect',
    description: 'Detect and recognize faces from image or camera. Returns face embeddings and identity matches.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Path to image file' },
        camera_index: { type: 'integer', description: 'Camera index (default: 0)', default: 0 }
      }
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, faces_detected: { type: 'integer' }, results: { type: 'array' } } }, render: renderJson },
    async execute(args) {
      return await callBackend('/face/detect', { image_path: args.image_path }, pluginConfig);
    }
  });

  // ============================================================
  // Screen Control Tools
  // ============================================================

  ctx.tools.register({
    name: 'biometric_screen_control',
    description: 'Control screen state: on (wake) or off (black). Lock screen is not supported — this plugin only blacks the display and never touches the Windows session.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['on', 'off', 'state'],
          description: 'Screen action: on=亮屏, off=黑屏, state=查询状态'
        }
      },
      required: ['action']
    },
    output: { schema: { type: 'object', properties: { success: { type: 'boolean' }, isBlack: { type: 'boolean' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      return await callBackend('/screen', { action: args.action }, pluginConfig);
    }
  });

  // ============================================================
  // Configuration Tools
  // ============================================================

  ctx.tools.register({
    name: 'biometric_set_config',
    description: 'Configure plugin settings: enable/disable detection, time thresholds, identity thresholds.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Enable presence detection' },
        faceEnabled: { type: 'boolean', description: 'Enable face detection' },
        absentThreshold: { type: 'integer', description: 'Seconds before acting when user absent (default: 30)' },
        detectionInterval: { type: 'integer', description: 'Detection check interval in ms (default: 5000)' }
      }
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, config: { type: 'object' } } }, render: renderJson },
    async execute(args) {
      return await callBackend('/config', args, pluginConfig);
    }
  });

  ctx.tools.register({
    name: 'biometric_get_config',
    description: 'Get current plugin configuration.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, config: { type: 'object' } } }, render: renderJson },
    async execute() { return await callBackendGet('/config', pluginConfig); }
  });

  ctx.tools.register({
    name: 'biometric_presence_status',
    description: 'Get current presence detection status and screen state.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, state: { type: 'string' }, lastSeen: { type: 'string' }, screen: { type: 'object' } } }, render: renderJson },
    async execute() { return await callBackendGet('/presence', pluginConfig); }
  });

  // ============================================================
  // User Management Tools
  // ============================================================

  ctx.tools.register({
    name: 'biometric_manage_users',
    description: 'Manage registered users. Add, remove, or list users.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'get'], description: 'Action to perform' },
        user_id: { type: 'string', description: 'User identifier' },
        name: { type: 'string', description: 'Display name (for add)' }
      }
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, users: { type: 'array' } } }, render: renderJson },
    async execute(args) {
      if (args.action === 'list') return await callBackendGet('/users', pluginConfig);
      if (args.action === 'add') return await callBackend('/users', { user_id: args.user_id, name: args.name }, pluginConfig);
      if (args.action === 'remove') return await callBackend(`/users/${args.user_id}`, {}, pluginConfig);
      if (args.action === 'get') return await callBackend(`/users/${args.user_id}`, {}, pluginConfig);
      return { status: 'error', message: 'Invalid action' };
    }
  });

  ctx.tools.register({
    name: 'biometric_combine',
    description: 'Combined multi-modal biometric analysis for identity verification.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Path to face image' },
        mode: { type: 'string', enum: ['verify', 'identify'], default: 'verify' },
        target_user: { type: 'string', description: 'Target user ID for verification' }
      }
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, mode: { type: 'string' }, combined_confidence: { type: 'number' }, identified_user: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      let faceResult = null;
      if (args.image_path) faceResult = await callBackend('/face/detect', { image_path: args.image_path }, pluginConfig);

      let combinedConfidence = 0;
      if (faceResult?.faces_detected > 0) {
        combinedConfidence = faceResult.results?.[0]?.confidence || 0;
      }
      
      return {
        status: 'success',
        mode: args.mode,
        combined_confidence: combinedConfidence,
        identified_user: combinedConfidence >= 0.6 ? args.target_user : null
      };
    }
  });

  // ============================================================
  // Base64 Capture Registration Tools (camera uploads)
  // ============================================================

  ctx.tools.register({
    name: 'biometric_register_face_photo',
    description: 'Register face from a base64 image captured by the user\'s camera (or any uploaded image). Accepts image_b64 data; MIME hints the extension. Overwrites any existing face registration for the user.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'User identifier' },
        image_b64: { type: 'string', description: 'Base64-encoded image data (no data: prefix required; with prefix also accepted)' },
        mime: { type: 'string', description: 'MIME type hint, e.g. image/png or image/jpeg' }
      },
      required: ['user_id', 'image_b64']
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, user_id: { type: 'string' }, confidence: { type: 'number' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      let b64 = String(args.image_b64 || '');
      const m = b64.match(/^data:[^;]+;base64,(.*)$/s);
      if (m) b64 = m[1];
      return await callBackend('/register/face', { user_id: args.user_id, image_b64: b64, mime: args.mime }, pluginConfig);
    }
  });

  // ============================================================
  // Service Lifecycle Tool
  // ============================================================

  ctx.tools.register({
    name: 'biometric_service_control',
    description: 'Start, stop, or check status of the BioRecognize backend service (node server.js on 127.0.0.1:8765). Use before other biometric tools when health fails. Use service_manager: the managed instance is a detached node process and survives across DSH restarts.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start=ensure server running; stop=stop managed process; status=health probe' },
        wait: { type: 'number', description: 'For start: milliseconds to wait for health after spawning (default 3000)' }
      },
      required: ['action']
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, running: { type: 'boolean' }, pid: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      const probe = () => new Promise(resolve => {
        const req = http.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: '/health', method: 'GET', timeout: 2000 },
          res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ status: 'unknown' }); } }); });
        req.on('error', () => resolve({ status: 'down', message: 'Connection refused' }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout' }); });
        req.end();
      });

      if (args.action === 'status') {
        const r = await probe();
        return { status: r.status === 'ok' ? 'online' : 'offline', running: r.status === 'ok', ...r };
      }
      if (args.action === 'start') {
        const before = await probe();
        if (before.status === 'ok') return { status: 'success', running: true, message: 'Server already running' };
        const t0 = Date.now();
        const spawnRes = await ensureServer();
        const after = await probe();
        return {
          status: after.status === 'ok' ? 'success' : 'error',
          running: after.status === 'ok',
          pid: spawnRes.pid,
          message: after.status === 'ok' ? `Server started (pid ${spawnRes.pid}, took ${Date.now() - t0}ms)` : `Failed to start: ${spawnRes.message}`
        };
      }
      if (args.action === 'stop') {
        const res = await stopServer();
        const after = await probe();
        return {
          status: res.message.includes('stopped') ? 'success' : 'warn',
          running: after.status === 'ok',
          message: after.status === 'ok' ? 'Stopped managed process, but port still serves (an external instance may be running)' : res.message
        };
      }
      return { status: 'error', message: `Unknown action: ${args.action}` };
    }
  });
}
