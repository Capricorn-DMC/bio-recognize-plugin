// Uninstall / disable self-cleanup regression test (dry-run, isolated copies).
// The backend is detached on purpose, so neither death path can reach it
// through a lifecycle hook:
//   1. UNINSTALL — the host deletes the plugin directory.
//   2. TOGGLE OFF — dsh's plugin switch only writes a "disabled" list into the
//      profile state; no files are deleted, no hook fires.
// After the fix the backend polls for both: when its files are gone, or it
// shows up in the disabled list, it must clean up and exit on its own —
// instead of keeping the screen-dimming loop alive forever ("uninstalled but
// the screen still goes dark"). `--uninstall` is the manual one-shot cleanup.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const SRC = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PORT = 8798;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeCopy() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-uninstall-'));
    fs.cpSync(SRC, tmp, {
        recursive: true,
        filter: s => {
            const rel = path.relative(SRC, s).replace(/\\/g, '/');
            return !rel.startsWith('.git') && !rel.includes('/.git') && !rel.startsWith('node_modules');
        },
    });
    return tmp;
}

function health(port = PORT) {
    return new Promise(resolve => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 1500 },
            res => { res.resume(); res.on('end', () => resolve(true)); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
    const tag = ok ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${name}${detail ? '  — ' + detail : ''}`);
    ok ? pass++ : fail++;
}

async function waitExit(proc, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const done = await new Promise(resolve => {
            const t = setTimeout(() => resolve(false), 1000);
            proc.once('exit', (c, s) => { clearTimeout(t); resolve({ code: c, signal: s }); });
        });
        if (done) return done;
    }
    return null;
}

const ENV = { ...process.env, BIO_DRY_RUN: '1', BIO_TEST_WATCH_MS: '1200' };

// ── Scenario A: uninstall by file deletion ────────────────────────────
{
    const tmp = makeCopy();
    const proc = spawn(process.execPath, ['server.js', `--port=${PORT}`], { cwd: tmp, stdio: 'ignore', detached: false, env: ENV });
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { up = await health(); if (!up) await sleep(500); }
    check('A1 backend is up', up, `pid=${proc.pid}`);

    // The host deletes the plugin directory. On Windows a running script file
    // CAN be deleted (node read it into memory) — exactly what a real
    // uninstall leaves behind.
    try {
        fs.rmSync(path.join(tmp, 'server.js'));
        fs.rmSync(path.join(tmp, 'package.json'));
    } catch (e) {
        check('A2 could simulate uninstall by deleting files', false, e.message);
    }
    check('A2 files deleted (uninstall simulated)', !fs.existsSync(path.join(tmp, 'server.js')));

    const done = await waitExit(proc, 20000);
    check('A3 backend self-terminated after uninstall', !!done, done ? `code=${done.code} sig=${done.signal}` : 'still running after 20s');
    check('A4 exit was clean (no crash signal)', !!done && done.signal === null, done ? `code=${done.code}` : 'n/a');
    await sleep(500);
    check('A5 port released', !(await health()));
    try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
}

// ── Scenario B: dsh plugin toggle OFF (disabled list) ─────────────────
{
    // The backend derives the profile dir as three levels up from its own
    // folder, so mirror the real layout: <profile>/node_modules/@local/<pkg>.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-disable-'));
    const pluginDir = path.join(root, 'profile', 'node_modules', '@local', 'bio-recognize');
    fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
    fs.cpSync(SRC, pluginDir, {
        recursive: true,
        filter: s => {
            const rel = path.relative(SRC, s).replace(/\\/g, '/');
            return !rel.startsWith('.git') && !rel.includes('/.git') && !rel.startsWith('node_modules');
        },
    });
    fs.mkdirSync(path.join(root, 'profile', '.dsh-market'), { recursive: true });
    fs.writeFileSync(path.join(root, 'profile', '.dsh-market', 'state.json'),
        JSON.stringify({ disabled: ['dsh-dream-skin'] }), 'utf8');

    const proc = spawn(process.execPath, ['server.js', `--port=${PORT}`], { cwd: pluginDir, stdio: 'ignore', detached: false, env: ENV });
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { up = await health(); if (!up) await sleep(500); }
    check('B1 backend is up (plugin enabled)', up, `pid=${proc.pid}`);

    // The user flips the toggle: the plugin joins the disabled list.
    fs.writeFileSync(path.join(root, 'profile', '.dsh-market', 'state.json'),
        JSON.stringify({ disabled: ['dsh-dream-skin', '@local/bio-recognize'] }), 'utf8');

    const done = await waitExit(proc, 20000);
    check('B2 backend self-terminated after being disabled', !!done, done ? `code=${done.code} sig=${done.signal}` : 'still running after 20s');
    check('B3 exit was clean (no crash signal)', !!done && done.signal === null, done ? `code=${done.code}` : 'n/a');
    await sleep(500);
    check('B4 port released', !(await health()));
    try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
}

// ── Scenario C: manual one-shot `--uninstall` ─────────────────────────
{
    const tmp = makeCopy();
    // A stale pidfile (dead pid) must not crash the cleanup.
    fs.writeFileSync(path.join(tmp, 'models', '.server.pid'), '999999', 'utf8');
    const proc = spawn(process.execPath, ['server.js', '--uninstall', `--port=${PORT}`], { cwd: tmp, env: ENV });
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => out += d);
    const done = await waitExit(proc, 30000);
    check('C1 --uninstall exits promptly', !!done && done.code === 0, done ? `code=${done.code}` : 'timeout');
    check('C2 --uninstall never binds the port', !(await health()), 'port should stay free');
    check('C3 pidfile cleared', !fs.existsSync(path.join(tmp, 'models', '.server.pid')));
    check('C4 reports completion', /BioRecognize uninstalled/.test(out), out.split('\n')[0] || '(no output)');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
