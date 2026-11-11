// Liveness-loop regression for bio-recognize client.js.
//
// Field bug it locks down: the page stayed open, the camera stayed open, and
// the server received no heartbeat for minutes. Two mechanisms could do that
// and both are silent:
//   - a beat threw before its own try{} left `inFlight = true` forever, so
//     every later beat returned at the guard;
//   - the beat clock died (interval cleared, worker message lost, main thread
//     frozen long enough), and nothing ever noticed.
// client.js is loaded here with a stub DOM, a stub Worker and a stub fetch, so
// the loop can be driven exactly as the page would drive it.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'client.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
};

// ── Browser stubs ──────────────────────────────────────────────────────────
const beats = [];          // every POST /heartbeat body, in order
let fetchImpl = null;      // per-test override
const workers = [];        // every created Worker

class FakeWorker {
  constructor() { this.onmessage = null; this.terminated = false; workers.push(this); }
  postMessage() { /* commands are irrelevant for the test */ }
  terminate() { this.terminated = true; }
  // Deliver a tick the way the real worker would.
  tick(kind) { if (!this.terminated && this.onmessage) this.onmessage({ data: { t: kind } }); }
}

function fakeCanvas() {
  return {
    width: 0, height: 0,
    getContext: () => ({
      drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      fillRect() {}, set fillStyle(_v) {}, get fillStyle() { return ''; },
    }),
    toDataURL: () => '',
  };
}

const listeners = {};
const documentStub = {
  hidden: false,
  head: { appendChild() {} },
  body: { appendChild() {} },
  createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : { style: {}, appendChild() {}, play: () => Promise.resolve() }),
  addEventListener: (n, f) => { (listeners[n] ||= []).push(f); },
  querySelector: () => null,
};

const windowStub = {
  addEventListener: (n, f) => { (listeners[n] ||= []).push(f); },
  __ModuleLoader__: { load({ factory }) { windowStub.__mod = factory(requireStub); } },
  setTimeout, clearTimeout, setInterval, clearInterval,
};

const requireStub = (name) => {
  if (name === 'react') return { createElement: () => null, useRef: () => ({ current: null }), useEffect() {}, useState: () => [null, () => {}] };
  return {};
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  performance,
  Blob: class { constructor() {} },
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
  Worker: FakeWorker,
  fetch: async (url, opts) => {
    if (fetchImpl) return fetchImpl(url, opts);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (String(url).includes('/heartbeat')) beats.push(body);
    return { ok: true, json: async () => ({ status: 'success' }) };
  },
  AbortController,
  Error, TypeError, Math, Date, JSON, Object, Array, String, Number, Promise, Set, Map, isNaN, parseInt, parseFloat,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const code = fs.readFileSync(SRC, 'utf8');
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: path.basename(SRC) });

const mod = windowStub.__mod;
const hb = mod && mod.__heartbeat;
ok('client module loads and exposes the loop', !!hb);

// ── Test 1: a throw inside _send must never wedge the loop ──────────────────
{
  const H = hb;
  H.running = true;
  H.tokens.clear();
  H.tokens.add({ ms: 300 });
  H.beatWorker = new FakeWorker();
  H.inFlight = false;
  H.video = { get videoWidth() { throw new Error('boom in camera probe'); }, readyState: 2 };
  H.stream = { getVideoTracks: () => [{ readyState: 'live' }] };

  const before = beats.length;
  await H._send().catch(() => {});
  ok('T1 a throwing beat releases the in-flight slot', H.inFlight === false, 'inFlight=' + H.inFlight);

  H.video = null; H.stream = null;
  await H._send().catch(() => {});
  ok('T1b the next beat is actually sent', beats.length > before, `beats ${before}→${beats.length}`);
}

// ── Test 2: a beat stuck in flight is released by the watchdog ──────────────
{
  const H = hb;
  H.inFlight = true;
  H.inFlightSince = Date.now() - 7000;
  H.lastBeatAt = Date.now();
  H._watchdogTick();
  ok('T2 watchdog releases a 7s-stuck beat', H.inFlight === false, 'stuck=' + (H.diag.stuck || 0));
}

// ── Test 3: a silent clock is detected and restarted ────────────────────────
{
  const H = hb;
  H.running = true;
  H.inFlight = false;
  H.lastBeatAt = Date.now() - 12000;
  const before = beats.length;
  const workersBefore = workers.length;
  H._watchdogTick();
  await new Promise(r => setTimeout(r, 20));
  ok('T3 watchdog restarts a dead clock', workers.length > workersBefore, `workers ${workersBefore}→${workers.length}`);
  ok('T3b watchdog beats immediately after the restart', beats.length > before, `beats ${before}→${beats.length}`);
}

// ── Test 4: a beat carries the diagnostics the server now records ───────────
{
  const H = hb;
  H.running = true;
  H.beatWorker = new FakeWorker();
  H.lastBeatAt = Date.now();
  H.inFlight = false;
  H.picoReady = false;
  H.picoLoading = false;
  H.picoRetryAt = 0;
  const before = beats.length;
  await H._send();
  const b = beats[beats.length - 1];
  ok('T4 beat reports det=missing without a detector', b && b.det === 'missing', JSON.stringify(b && { det: b.det, clock: b.clock, tok: b.tok }));
  ok('T4b beat reports clock and token count', b && b.clock === 'worker' && typeof b.tok === 'number', `clock=${b && b.clock} tok=${b && b.tok}`);
  ok('T4c a missing detector is retried', H.picoRetryAt > Date.now(), 'retryIn=' + Math.round((H.picoRetryAt - Date.now()) / 1000) + 's');
}

// ── Test 5: the retry is rate-limited (no script storm) ────────────────────
{
  const H = hb;
  const retryAt = H.picoRetryAt;
  const beatBefore = beats.length;
  await H._send();
  ok('T5 no second retry inside 15s', H.picoRetryAt === retryAt, 'unchanged=' + (H.picoRetryAt === retryAt));
  ok('T5b beats keep flowing regardless', beats.length > beatBefore);
}

// ── Test 6: unhandled rejections are counted and reported ──────────────────
{
  const H = hb;
  const fns = listeners['unhandledrejection'] || [];
  ok('T6 page-level rejection hook installed', fns.length > 0, 'hooks=' + fns.length);
  if (fns.length) {
    const before = H.rejCount;
    fns[0]({ reason: new Error('M_II') });
    ok('T6b rejections are counted', H.rejCount === before + 1, 'rejCount=' + H.rejCount);
    await H._send();
    const b = beats[beats.length - 1];
    ok('T6c count rides along in the next beat', b && b.rj === H.rejCount, 'rj=' + (b && b.rj));
  }
}

// ── Test 7: a rejected promise from _beat is swallowed, not left unhandled ──
{
  const H = hb;
  H.inFlight = false;
  H.video = { get videoWidth() { throw new Error('boom'); }, readyState: 2 };
  H.stream = null;
  let unhandled = 0;
  const onRej = () => { unhandled++; };
  process.on('unhandledRejection', onRej);
  H._beat();
  await new Promise(r => setTimeout(r, 30));
  process.off('unhandledRejection', onRej);
  ok('T7 _beat never leaks an unhandled rejection', unhandled === 0, 'unhandled=' + unhandled + ' inFlight=' + H.inFlight);
}

// ── Test 8: intent is the truth — a stopped loop is restarted ───────────────
{
  const H = hb;
  // The exact field state: config says "detect", the page is alive, the loop is
  // stopped and its token is gone (a render called setIntent(false) with an
  // empty config before the fetch landed).
  H.intent = true;
  H.intentToken = null;
  H.tokens.clear();
  H.running = false;
  H._teardownBeatTimer();
  H._reviveCheck();
  await new Promise(r => setTimeout(r, 10));
  ok('T8 reviver restarts a stopped loop', H.running === true, 'running=' + H.running);
  ok('T8b reviver restores the intent token', !!H.intentToken && H.tokens.has(H.intentToken), 'tok=' + H.tokens.size);
  ok('T8c a clock exists again', !!(H.beatWorker || H.timer), 'worker=' + !!H.beatWorker + ' timer=' + !!H.timer);
}

// ── Test 9: with the intent off, the reviver stays out of the way ──────────
{
  const H = hb;
  H.intent = false;
  H.intentToken = null;
  H.tokens.clear();
  H.running = false;
  const revived = H.diag.revived || 0;
  H._reviveCheck();
  ok('T9 reviver does nothing when detection is off',
    H.running === false && (H.diag.revived || 0) === revived, 'running=' + H.running);
}

// ── Test 10: the freeze exemption is a single, reversible audio stream ─────
{
  const H = hb;
  let created = 0, closed = 0, resumed = 0;
  class FakeAC {
    constructor() { created++; this.state = 'running'; this.destination = {}; }
    createOscillator() { return { frequency: {}, connect() {}, start() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
    close() { closed++; }
    resume() { resumed++; return Promise.resolve(); }
  }
  windowStub.AudioContext = FakeAC;
  H._ac = null;
  H._keepAudible(true);
  H._keepAudible(true);
  ok('T10 one audio context, not one per beat', created === 1, 'created=' + created);
  H._keepAudible(false);
  ok('T10b turning detection off releases it', closed === 1 && H._ac === null, 'closed=' + closed);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
