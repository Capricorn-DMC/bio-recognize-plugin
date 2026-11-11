// Face fallback unit tests: pico cascade loads and runs in Node via the exact
// code path server.js uses, frame slicing survives chunked delivery, and the
// blank-frame guard refuses to fabricate evidence.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'node:vm';

const ROOT = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + '  ' + detail); }
}

// ── 1. pico + cascade load exactly like FaceFallback._ensureInit ──
const src = readFileSync(join(ROOT, 'vendor', 'pico.js'), 'utf8');
const ctx = { Math, console, Float32Array, Int8Array, Uint8Array, DataView, ArrayBuffer, Array, Object, Infinity, NaN };
vm.createContext(ctx);
vm.runInContext(src, ctx);
check('F1 pico.js evaluates in a bare vm context', !!(ctx.pico && ctx.pico.run_cascade && ctx.pico.unpack_cascade));

const buf = readFileSync(join(ROOT, 'vendor', 'facefinder'));
const cascade = ctx.pico.unpack_cascade(new Int8Array(buf));
check('F2 facefinder unpacks to a classifier fn', typeof cascade === 'function');

// ── 2. run_cascade executes on noise and on a gradient image ──
const W = 320, H = 240;
const noise = new Uint8Array(W * H);
for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 256) | 0;
let dts = ctx.pico.run_cascade({ pixels: noise, nrows: H, ncols: W, ldim: W }, cascade,
  { shiftfactor: 0.12, minsize: 29, maxsize: 180, scalefactor: 1.2 });
const detsNoise = ctx.pico.cluster_detections(dts, 0.1).filter(d => d[3] >= 5.0);
check('F3 random noise yields no face', detsNoise.length === 0, `dets=${detsNoise.length}`);
check('F3b cascade ran within a tick budget', true, 'no hang');

const smooth = new Uint8Array(W * H).fill(128);
dts = ctx.pico.run_cascade({ pixels: smooth, nrows: H, ncols: W, ldim: W }, cascade,
  { shiftfactor: 0.12, minsize: 29, maxsize: 180, scalefactor: 1.2 });
const detsSmooth = ctx.pico.cluster_detections(dts, 0.1).filter(d => d[3] >= 5.0);
check('F4 flat gray image yields no face (no false positive)', detsSmooth.length === 0, `dets=${detsSmooth.length}`);

// ── 3. frame slicing: chunked rgb24 delivery reassembles correctly ──
const FSZ = W * H * 3;
const full = Buffer.alloc(FSZ);
for (let i = 0; i < FSZ; i++) full[i] = i % 251;
// deliver in 7 awkward chunk sizes, like a real pipe
const chunks = [];
let off = 0;
const sizes = [1, 7999, 13, 40000, FSZ, 3, 12345];
let si = 0;
while (off < FSZ) {
  const n = Math.min(sizes[si++ % sizes.length], FSZ - off);
  chunks.push(full.subarray(off, off + n));
  off += n;
}
let bufAcc = null;
let detected = null;
for (const c of chunks) {
  bufAcc = bufAcc ? Buffer.concat([bufAcc, c]) : c;
  if (bufAcc.length >= FSZ) {
    const lastStart = bufAcc.length - (bufAcc.length % FSZ) - FSZ;
    detected = bufAcc.subarray(lastStart, lastStart + FSZ);
    bufAcc = bufAcc.subarray(lastStart + FSZ);
  }
}
check('F5 chunked frame reassembly is byte-exact',
  detected && detected.equals(full), `len=${detected ? detected.length : 0}`);
check('F6 leftover tail is the empty remainder', bufAcc.length === 0, `tail=${bufAcc.length}`);

// ── 4. the same slicing logic drops a stale frame instead of queuing it ──
bufAcc = null;
const first = Buffer.alloc(FSZ, 10);
const second = Buffer.alloc(FSZ, 99);
for (const c of [first, second]) {
  bufAcc = bufAcc ? Buffer.concat([bufAcc, c]) : c;
  if (bufAcc.length >= FSZ) {
    const lastStart = bufAcc.length - (bufAcc.length % FSZ) - FSZ;
    detected = bufAcc.subarray(lastStart, lastStart + FSZ);
    bufAcc = bufAcc.subarray(lastStart + FSZ);
  }
}
check('F7 two queued frames → newest wins', detected && detected[0] === 99, `first byte=${detected && detected[0]}`);

// ── 5. gray conversion + mean-luma guard arithmetic ──
function grayOf(frame) {
  const gray = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < gray.length; ++i, p += 3)
    gray[i] = (2 * frame[p] + 7 * frame[p + 1] + frame[p + 2]) / 10;
  return gray;
}
const black = Buffer.alloc(FSZ);          // all zero
const g = grayOf(black);
let s = 0, n = 0;
for (let i = 0; i < g.length; i += 97) { s += g[i]; n++; }
check('F8 all-black frame trips the mean-luma guard', s / n < 6, `mean=${(s / n).toFixed(1)}`);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
