// Uninstall-watchdog regression test (dry-run, isolated copy).
// The backend is detached on purpose, so an uninstall (the host deleting the
// plugin directory) cannot reach it through a lifecycle hook. After the fix
// the backend polls for its own files: when they are gone it must clean up
// and exit on its own — instead of keeping the screen-dimming loop alive
// forever ("uninstalled but the screen still goes dark").
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

function health() {
    return new Promise(resolve => {
        const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/health', method: 'GET', timeout: 1500 },
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

const tmp = makeCopy();
const proc = spawn(process.execPath, ['server.js', `--port=${PORT}`], { cwd: tmp, stdio: 'ignore', detached: false });
const pid = proc.pid;

// Wait for ready
let up = false;
for (let i = 0; i < 30 && !up; i++) { up = await health(); if (!up) await sleep(500); }
check('U1 backend is up', up, `pid=${pid}`);

// Simulate the uninstall: the host deletes the plugin directory.
// On Windows a running script file CAN be deleted (node read it into memory),
// which is exactly how the real uninstall left a live backend behind.
try {
    fs.rmSync(path.join(tmp, 'server.js'));
    fs.rmSync(path.join(tmp, 'package.json'));
} catch (e) {
    check('U2 could simulate uninstall by deleting files', false, e.message);
}
check('U2 files deleted (uninstall simulated)', !fs.existsSync(path.join(tmp, 'server.js')));

// The watchdog fires every 15s and needs 2 strikes → up to ~35s.
const deadline = Date.now() + 60000;
let exited = false, code = null, sig = null;
while (Date.now() < deadline) {
    const done = await new Promise(resolve => {
        const t = setTimeout(() => resolve(false), 1000);
        proc.once('exit', (c, s) => { clearTimeout(t); code = c; sig = s; resolve(true); });
    });
    if (done) { exited = true; break; }
}
check('U3 backend self-terminated after uninstall', exited, exited ? `code=${code} sig=${sig}` : 'still running after 60s');

// It must be a CLEAN exit, not a crash.
check('U4 exit was clean (no crash signal)', exited && sig === null, exited ? `code=${code}` : 'n/a');

// Port must be released.
await sleep(500);
check('U5 port released', !(await health()));

try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
