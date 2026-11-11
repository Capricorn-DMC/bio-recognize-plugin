// Escape-gate regression test for bio-recognize-plugin (dry-run, isolated copy).
// A: sustained mouse input while black must NEVER wake the screen.
// B: holding Shift/Esc for keyEscapeMs wakes it, and it blacks out again if no
//    recognised face shows up within escapeVerifyMs.
// C: a single face frame must not re-light a screen that just went black.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const SRC = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PORT = 8799;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeCopy() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-escape-'));
  fs.cpSync(SRC, tmp, {
    recursive: true,
    filter: s => {
      const rel = path.relative(SRC, s).replace(/\\/g, '/');
      return !rel.startsWith('.git') && !rel.includes('/.git') && !rel.startsWith('node_modules');
    },
  });
  let src = fs.readFileSync(path.join(tmp, 'server.js'), 'utf8');
  const idleOld = `    getIdleSeconds() {
        return this.idleSeconds;`;
  const idleNew = `    getIdleSeconds() {
        if (process.env.BIO_TEST_IDLE !== undefined) return parseFloat(process.env.BIO_TEST_IDLE);
        return this.idleSeconds;`;
  const escOld = `    isEscapeHeld() {
        return !!(this.shiftDown || this.escDown);`;
  const escNew = `    isEscapeHeld() {
        if (process.env.BIO_TEST_ESC === '1') return true;
        return !!(this.shiftDown || this.escDown);`;
  if (!src.includes(idleOld) || !src.includes(escOld)) throw new Error('patch anchors not found');
  src = src.replace(idleOld, idleNew).replace(escOld, escNew);
  // Don't fight the real models dir when several copies run.
  fs.writeFileSync(path.join(tmp, 'server.js'), src);
  return tmp;
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 } },
      res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
      });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

const beat = (faces, extra = {}) => req('POST', '/heartbeat', {
  faces, cam: 'ok', det: 'ok', ms: 10, emb: 'ok', embMs: 100, ...extra,
});
// A beat whose video died: still beating, but no `faces` field at all.
const beatDead = (cam = 'ok') => req('POST', '/heartbeat', { cam, det: 'ok', emb: 'ok', embMs: 100 });
const status = () => req('GET', '/presence');

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await req('GET', '/health'); return; } catch { await sleep(250); }
  }
  throw new Error('server did not come up');
}

async function boot(env) {
  const dir = makeCopy();
  // Default the fake camera to "no face": without it the degraded path really
  // opens the webcam, and pico detecting the developer sitting at the desk
  // kept waking the screen mid-scenario (server-face-back) — flaky by desk.
  const proc = spawn(process.execPath, ['server.js', `--port=${PORT}`], {
    cwd: dir, env: { ...process.env, BIO_DRY_RUN: '1', BIO_TEST_FACE_MODE: 'absent', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  proc.stdout.on('data', d => log.push(d.toString()));
  proc.stderr.on('data', d => log.push(d.toString()));
  await waitUp();
  return { dir, proc, log };
}

function stop(inst) {
  try { execFileSync('taskkill', ['/PID', String(inst.proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── Scenario A + C: sustained input never wakes; single frame never wakes ──
async function scenarioAC() {
  const inst = await boot({ BIO_TEST_IDLE: '0' });
  try {
    await sleep(3600);                                   // startup settle (3s)
    await req('POST', '/config', { enabled: true, faceEnabled: true });
    await sleep(400);
    // Let the engine arm itself with a real, stable presence first.
    for (let i = 0; i < 5; i++) { await beat(1); await sleep(300); }
    let s = await status();
    check('A0 armed before blackout', s.armed === true, `armed=${s.armed}`);

    await req('POST', '/screen', { action: 'off' });
    await sleep(300);
    s = await status();
    check('A1 screen is black', s.screen.isBlack === true, `isBlack=${s.screen.isBlack}`);

    // 12s of "the mouse is being wiggled" (idle forced to 0, no face).
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) { await beat(0); await sleep(300); }
    s = await status();
    check('A2 sustained input does NOT wake', s.screen.isBlack === true,
      `isBlack=${s.screen.isBlack} reason=${s.lastReason} idle=${s.inputIdleSeconds}`);

    // C: one face frame only.
    await beat(1);
    await sleep(450);
    s = await status();
    check('C1 single face frame does NOT wake', s.screen.isBlack === true,
      `isBlack=${s.screen.isBlack} reason=${s.lastReason}`);

    // C: continuous frames do wake it.
    for (let i = 0; i < 6; i++) { await beat(1); await sleep(300); }
    await sleep(900);
    s = await status();
    check('C2 continuous face frames wake it', s.screen.isBlack === false,
      `isBlack=${s.screen.isBlack} reason=${s.lastReason}`);
  } finally { stop(inst); }
}

// ── Scenario B: keyboard escape hatch + verification ──────────────────────
async function scenarioB() {
  const inst = await boot({ BIO_TEST_IDLE: '0', BIO_TEST_ESC: '1' });
  try {
    await sleep(3600);
    await req('POST', '/config', { enabled: true, faceEnabled: true, keyEscapeMs: 8000, escapeVerifyMs: 5000 });
    await sleep(300);
    // Keep the client heartbeat alive, otherwise the watchdog restores the
    // screen by itself (that is a different path, not the escape hatch).
    for (let i = 0; i < 5; i++) { await beat(1); await sleep(300); }
    await req('POST', '/screen', { action: 'off' });
    await sleep(300);
    let s = await status();
    check('B1 screen is black', s.screen.isBlack === true);

    const t0 = Date.now();
    while (Date.now() - t0 < 6500) { await beat(0); await sleep(300); }
    s = await status();
    check('B2 before keyEscapeMs nothing happens', s.screen.isBlack === true,
      `elapsed=${Math.round((Date.now() - t0) / 1000)}s`);

    while (Date.now() - t0 < 9000) { await beat(0); await sleep(300); }
    await sleep(400);
    s = await status();
    check('B3 key hold wakes the screen', s.screen.isBlack === false,
      `reason=${s.lastReason}`);

    // Nobody recognised → must black out again after escapeVerifyMs.
    const t1 = Date.now();
    while (Date.now() - t1 < 6500) { await beat(0); await sleep(300); }
    s = await status();
    check('B4 unverified wake blacks out again', s.screen.isBlack === true,
      `reason=${s.lastReason}`);
  } finally { stop(inst); }
}

// ── Scenario D: the detector goes blind for a moment right after a wake ────
// Restoring the backlight changes camera exposure; 1-2 beats without a face
// must not blank a screen that just lit up (the "wakes, blinks black once,
// then stays on" symptom).
async function scenarioD() {
  const inst = await boot({ BIO_TEST_IDLE: '0' });
  try {
    await sleep(3600);
    await req('POST', '/config', { enabled: true, faceEnabled: true });
    await sleep(300);
    for (let i = 0; i < 5; i++) { await beat(1); await sleep(300); }
    await req('POST', '/screen', { action: 'off' });
    await sleep(300);

    // Sit back down: continuous frames wake it.
    for (let i = 0; i < 4; i++) { await beat(1); await sleep(300); }
    await sleep(500);
    let s = await status();
    check('D1 face wakes the screen', s.screen.isBlack === false, `reason=${s.lastReason}`);

    // Exposure settles: up to 1.4s of no-face beats right after the wake.
    // (Kept under the 1.8s face grace on purpose: at exactly 1.8s the test
    // races the grace window and flakes; the real safety claim is "a brief
    // dropout right after a wake must not blank", and 1.4s is that.)
    const t0 = Date.now();
    while (Date.now() - t0 < 1400) { await beat(0); await sleep(300); }
    s = await status();
    check('D2 brief detector blindness does NOT blank it', s.screen.isBlack === false,
      `isBlack=${s.screen.isBlack} reason=${s.lastReason}`);

    // Face is back and stable — stays on.
    for (let i = 0; i < 6; i++) { await beat(1); await sleep(300); }
    await sleep(300);
    s = await status();
    check('D3 stays on while the face is there', s.screen.isBlack === false);

    // Genuinely leaving still blanks it (guard must not mean "never").
    const t1 = Date.now();
    while (Date.now() - t1 < 6000) { await beat(0); await sleep(300); }
    s = await status();
    check('D4 real absence still blanks the screen', s.screen.isBlack === true,
      `reason=${s.lastReason}`);
  } finally { stop(inst); }
}

// ── Scenario E: the client says "I could not see" ─────────────────────────
// A 2-3s CNN inference keeps the fast detector from getting a usable frame.
// Those beats carry blind:true instead of a plain faces=0, and must never be
// read as "the user left" — that was the blink this whole fix is about.
async function scenarioE() {
  const inst = await boot({ BIO_TEST_IDLE: '0' });
  try {
    await sleep(3600);
    await req('POST', '/config', { enabled: true, faceEnabled: true });
    await sleep(300);
    for (let i = 0; i < 5; i++) { await beat(1); await sleep(300); }
    await req('POST', '/screen', { action: 'off' });
    await sleep(300);
    for (let i = 0; i < 4; i++) { await beat(1); await sleep(300); }
    await sleep(500);
    let s = await status();
    check('E1 face wakes the screen', s.screen.isBlack === false, `reason=${s.lastReason}`);

    // 2.8s of "inference is running, the frame is unusable".
    const t0 = Date.now();
    while (Date.now() - t0 < 2800) { await beat(0, { blind: true, embMs: 2600 }); await sleep(300); }
    s = await status();
    check('E2 blind beats do NOT blank the screen', s.screen.isBlack === false,
      `isBlack=${s.screen.isBlack} reason=${s.lastReason}`);

    // Eyes back on: still on.
    for (let i = 0; i < 4; i++) { await beat(1); await sleep(300); }
    s = await status();
    check('E3 stays on after the blind window', s.screen.isBlack === false);

    // A blind window must not become a permanent excuse either.
    const t1 = Date.now();
    while (Date.now() - t1 < 6000) { await beat(0); await sleep(300); }
    s = await status();
    check('E4 real absence still blanks it', s.screen.isBlack === true,
      `reason=${s.lastReason}`);
  } finally { stop(inst); }
}

// ── Scenario F: heartbeat alive, video dead ───────────────────────────────
// The exact field failure behind "移开人脸不熄屏": the video element dies
// (page hidden → autoplay suspended / track ended), the beats keep coming
// with cam:'ok' and NO faces field, and the engine treated "no evidence" as
// "keep the screen on forever". Now: ON + no picture ≥ noPictureBlankMs →
// blank; BLACK + no picture ≥ noPictureRestoreMs → hand the screen back
// once, not immediately.
async function scenarioF() {
  const inst = await boot({ BIO_TEST_IDLE: '0' });
  try {
    await sleep(3600);
    await req('POST', '/config', {
      enabled: true, faceEnabled: true,
      noPictureBlankMs: 4000, noPictureRestoreMs: 5000,
    });
    await sleep(300);
    for (let i = 0; i < 5; i++) { await beat(1); await sleep(300); }
    let s = await status();
    check('F1 screen on with face', s.screen.isBlack === false);

    // Video dies: beats keep coming, no faces field.
    const t0 = Date.now();
    while (Date.now() - t0 < 5500) { await beatDead(); await sleep(300); }
    s = await status();
    check('F2 dead video blanks the screen', s.screen.isBlack === true,
      `isBlack=${s.screen.isBlack} reason=${s.lastReason}`);
    if (s.lastReason !== 'no-picture') check('F2b reason is no-picture', false, `reason=${s.lastReason}`);

    // Camera recovers, owner is there → back on quickly.
    for (let i = 0; i < 6; i++) { await beat(1); await sleep(300); }
    await sleep(400);
    s = await status();
    check('F3 recovered picture wakes it again', s.screen.isBlack === false,
      `reason=${s.lastReason}`);

    // Black + dead camera: no PREMATURE restore…
    await req('POST', '/screen', { action: 'off' });
    await sleep(300);
    const t1 = Date.now();
    while (Date.now() - t1 < 2500) { await beatDead('error'); await sleep(300); }
    s = await status();
    check('F4a black + dead camera stays black (no instant restore)', s.screen.isBlack === true,
      `reason=${s.lastReason}`);

    // …but after noPictureRestoreMs it hands the panel back once.
    while (Date.now() - t1 < 6500) { await beatDead('error'); await sleep(300); }
    s = await status();
    check('F4b black + long-dead camera restores once', s.screen.isBlack === false,
      `reason=${s.lastReason}`);
  } finally { stop(inst); }
}

// ── Scenario G: the client page is GONE (frozen/closed) — the OS decides ──
// The field case this guards: the dsh page freezes the moment its window
// loses focus, so the face channel disappears exactly when the user walks
// away. With no client at all, the only surviving sensor is the OS input
// idle time (PowerShell child of the server, immune to browser freezing).
async function scenarioG() {
  // G-I: screen on, nobody at the machine (idle 999s) → blank it anyway.
  {
    const inst = await boot({ BIO_TEST_IDLE: '999' });
    try {
      await sleep(3600);
      await req('POST', '/config', { enabled: true, faceEnabled: true, blindAwaySec: 0.8 });
      await sleep(300);
      for (let i = 0; i < 5; i++) { await beat(1); await sleep(300); }
      let s = await status();
      check('G1 armed, screen on before the page dies',
        s.armed === true && s.screen.isBlack === false,
        `armed=${s.armed} isBlack=${s.screen.isBlack}`);

      // The page freezes/closes: no more beats at all, screen still on.
      // Sensitivity is the point here: with blindAwaySec at its 0.8s default
      // the panel must be black within a few seconds of the last beat, not
      // after a three-minute grace period.
      await sleep(3500);
      s = await status();
      check('G2 dead client + idle → blank within ~3s',
        s.screen.isBlack === true,
        `isBlack=${s.screen.isBlack} reason=${s.lastReason}`);
      // Which sensor fired depends on whether the server-side camera could
      // take over: with it, the absence verdict is server-face-away (a REAL
      // camera beats keyboard-idle); without it, blind-away. Both are fast
      // and both are correct — only the evidence differs.
      check('G2b reason is server-face-away or blind-away',
        s.lastReason === 'server-face-away' || s.lastReason === 'blind-away',
        `reason=${s.lastReason}`);
    } finally { stop(inst); }
  }
  // G-II: screen black, someone IS at the machine (idle 0) → restore.
  {
    const inst = await boot({ BIO_TEST_IDLE: '0' });
    try {
      await sleep(3600);
      await req('POST', '/config', { enabled: true, faceEnabled: true });
      await sleep(300);
      for (let i = 0; i < 5; i++) { await beat(1); await sleep(300); }
      await req('POST', '/screen', { action: 'off' });
      await sleep(300);
      let s = await status();
      check('G3 screen is black', s.screen.isBlack === true, `isBlack=${s.screen.isBlack}`);

      // The client now dies while the screen is black. Semantics since the
      // server-side camera exists: when the takeover SUCCEEDS the camera is
      // the strongest evidence and outranks keyboard idle (the fake camera
      // here sees nobody → stays black). A real camera that DOES see the
      // user re-lights the panel — covered by H6. The keyboard-only restore
      // applies when the takeover FAILED, which the fake cannot simulate.
      await sleep(3500);
      s = await status();
      // reason is racy here: the panel may still carry the pre-death verdict
      // (or null when no new action fired). The invariant is: STAYS BLACK.
      check('G4 dead client + server camera sees nobody → stays black',
        s.screen.isBlack === true,
        `isBlack=${s.screen.isBlack} reason=${s.lastReason}`);
    } finally { stop(inst); }
  }
  // G-III: page dies with the user typing. With the server camera taken over,
  // the camera verdict (fake: nobody) wins over keyboard idle — see G4. The
  // keyboard guard still applies whenever the takeover could not open the
  // device (device busy), which is the case the handoff branch covers.
  {
    const inst = await boot({ BIO_TEST_IDLE: '0' });
    try {
      await sleep(3600);
      await req('POST', '/config', { enabled: true, faceEnabled: true });
      await sleep(300);
      for (let i = 0; i < 5; i++) { await beat(1); await sleep(300); }
      // Page dies, but the user keeps typing/moving the mouse.
      await sleep(3500);
      const s = await status();
      check('G5 dead client + server camera sees nobody → stays black',
        s.screen.isBlack === true && s.lastReason === 'server-face-away',
        `isBlack=${s.screen.isBlack} reason=${s.lastReason}`);
    } finally { stop(inst); }
  }
}

// ── Scenario H: camera handoff + server-side face fallback ────────────────
// The page hides and hands the camera over (`handoff` beat). From that
// moment the SERVER is the face sensor — beats keep flowing the whole time
// (a live-but-hidden page), which is exactly the case the old logic could
// never handle. BIO_TEST_FACE_MODE fakes what the "camera" sees.
async function scenarioH() {
  // H-I: hidden page, camera sees nobody → blank on the server's own eyes.
  {
    const inst = await boot({ BIO_TEST_IDLE: '0', BIO_TEST_FACE_MODE: 'away' });
    try {
      await sleep(3600);
      await req('POST', '/config', { enabled: true, faceEnabled: true, blindAwaySec: 60, serverFaceAwaySec: 3 });
      await sleep(300);
      for (let i = 0; i < 5; i++) { await beat(1, { vis: 'visible' }); await sleep(300); }
      let s = await status();
      check('H1 armed and screen on before handoff',
        s.armed === true && s.screen.isBlack === false,
        `armed=${s.armed} isBlack=${s.screen.isBlack}`);

      // The page hides and hands the camera over; beats keep flowing.
      const handoffBeat = () => req('POST', '/heartbeat',
        { cam: 'handoff', det: 'ok', vis: 'hidden', handoff: true, emb: 'ok' });
      await handoffBeat();
      await sleep(500);
      s = await status();
      check('H2 server took the camera on handoff',
        !!(s.faceFallback && s.faceFallback.active),
        `active=${s.faceFallback && s.faceFallback.active}`);

      const t0 = Date.now();
      while (Date.now() - t0 < 7000) { await handoffBeat(); await sleep(300); }
      s = await status();
      check('H3 server camera: no face for 3s → blank (beats alive!)',
        s.screen.isBlack === true && s.lastReason === 'server-face-away',
        `isBlack=${s.screen.isBlack} reason=${s.lastReason}`);

      // Page becomes visible again: the server releases the camera.
      await beat(0, { vis: 'visible' });
      await sleep(400);
      s = await status();
      check('H4 client-visible beat releases the camera',
        !!(s.faceFallback && !s.faceFallback.active),
        `active=${s.faceFallback && s.faceFallback.active}`);
    } finally { stop(inst); }
  }
  // H-II: screen black, server camera sees a face → wake. This is the
  // bioOnly promise kept by the server alone: a face wakes, input never does
  // (idle is 999s here, so only the face can do it).
  {
    const inst = await boot({ BIO_TEST_IDLE: '999', BIO_TEST_FACE_MODE: 'present' });
    try {
      await sleep(3600);
      await req('POST', '/config', { enabled: true, faceEnabled: true, blindAwaySec: 60, serverFaceAwaySec: 3 });
      await sleep(300);
      for (let i = 0; i < 5; i++) { await beat(1, { vis: 'visible' }); await sleep(300); }
      await req('POST', '/screen', { action: 'off' });
      await sleep(300);
      let s = await status();
      check('H5 screen is black', s.screen.isBlack === true, `isBlack=${s.screen.isBlack}`);

      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        await req('POST', '/heartbeat',
          { cam: 'handoff', det: 'ok', vis: 'hidden', handoff: true, emb: 'ok' });
        await sleep(300);
      }
      s = await status();
      check('H6 server camera: face while black → wake',
        s.screen.isBlack === false && s.lastReason === 'server-face-back',
        `isBlack=${s.screen.isBlack} reason=${s.lastReason}`);
    } finally { stop(inst); }
  }
}

try {
  await scenarioAC();
  await scenarioB();
  await scenarioD();
  await scenarioE();
  await scenarioF();
  await scenarioG();
  await scenarioH();
} catch (e) {
  console.error('ERROR', e.message);
  process.exitCode = 1;
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
