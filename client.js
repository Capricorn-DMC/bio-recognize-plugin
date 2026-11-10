// ─── Dual-protocol client module loader ──────────────────────────────────
// New DSH (>= 2026.x): window.__ModuleLoader__.load({ id, factory(require) })
// Old DSH (V0.2.x):    module.exports = { inject, apply(ctx) }
//   The factory body below runs once per protocol; it returns the module
//   object { inject, apply } which each host consumes differently.
(function () {
  const mod = (require) => {
    const React = require('react');
    const h = React.createElement;

    const BACKEND_URL = 'http://127.0.0.1:8765';

    // Real cordis ctx captured in apply(); components must not read it from React props.
    let realCtx = null;

    // ─── Theme (consistent purple brand, works in both light & dark) ──────
    const ACCENT = '#8b5cf6';      // vivid purple
    const ACCENT_SOFT = 'rgba(139, 92, 246, 0.12)';
    const BG_LAYER1 = '#1e1e2e';   // dark panel bg
    const BG_LAYER2 = '#2a2a3a';   // slightly lighter card bg
    const BORDER_L1 = '#3a3a4a';
    const BORDER_L2 = '#4a4a5a';
    const TEXT = '#e2e2f0';
    const TEXT2 = '#a6a6b8';
    const TEXT3 = '#8a8a9e';
    const INPUT_BG = '#252535';
    const SUCCESS = '#22c55e';
    const ERROR = '#ef4444';
    const WARN = '#f59e0b';
    const FONT = 'var(--dsw-font-family, system-ui, sans-serif)';

    const T = {
      bgLayer1: BG_LAYER1,
      bgLayer2: BG_LAYER2,
      borderL1: BORDER_L1,
      borderL2: BORDER_L2,
      text: TEXT,
      text2: TEXT2,
      text3: TEXT3,
      accent: ACCENT,
      accentSoft: ACCENT_SOFT,
      input: INPUT_BG,
      success: SUCCESS,
      error: ERROR,
      warn: WARN,
    };

    const s = {
      page: { padding: '24px 28px', fontFamily: FONT, fontSize: 14, color: T.text, maxWidth: 760 },
      header: { marginBottom: 20, paddingBottom: 14, borderBottom: `1px solid ${T.borderL2}`, display: 'flex', alignItems: 'center', gap: 12 },
      h1: { margin: 0, fontSize: 18, fontWeight: 600, color: T.text },
      subtitle: { margin: 0, fontSize: 12, color: T.text2, marginTop: 2 },
      section: { marginBottom: 14, padding: 14, background: T.bgLayer1, borderRadius: 12, border: `1px solid ${T.borderL1}` },
      sectionTitle: { fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, color: T.text },
      row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
      label: { width: 96, flex: '0 0 96px', fontSize: 13, color: T.text2 },
      input: { flex: 1, minWidth: 0, padding: '7px 10px', borderRadius: 6, border: `1px solid ${T.borderL2}`, background: T.input, color: T.text, fontSize: 13, outline: 'none' },
      inputSmall: { width: 72, padding: '5px 8px', borderRadius: 6, border: `1px solid ${T.borderL2}`, background: T.input, color: T.text, fontSize: 13, outline: 'none' },
      btnPrimary: { padding: '7px 14px', borderRadius: 6, border: 'none', background: T.accent, color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' },
      btnSecondary: { padding: '6px 12px', borderRadius: 6, border: `1px solid ${T.borderL2}`, background: T.bgLayer2, color: T.text, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
      btnSmall: { padding: '4px 10px', borderRadius: 5, border: 'none', background: T.accent, color: '#fff', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 10, fontSize: 12, fontWeight: 500 },
      card: { padding: 14, background: T.bgLayer2, borderRadius: 8, border: `1px solid ${T.borderL1}`, marginBottom: 10 },
      modalityCard: { display: 'flex', alignItems: 'center', gap: 10, padding: 12, background: T.bgLayer2, borderRadius: 8, border: `1px solid ${T.borderL1}` },
      toggle: { width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.15s', flex: '0 0 auto' },
      toggleKnob: { width: 16, height: 16, borderRadius: 8, background: '#fff', position: 'absolute', top: 2, transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' },
      msg: { padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12 },
      divider: { height: 1, background: T.borderL1, margin: '14px 0' },
      groupLabel: { fontSize: 11, fontWeight: 600, color: T.text3, marginBottom: 8, letterSpacing: '0.6px' },
      badgeOk: { background: 'rgba(34, 197, 94, 0.15)', color: T.success },
      badgeErr: { background: 'rgba(239, 68, 68, 0.15)', color: T.error },
      msgOk: { background: 'rgba(34, 197, 94, 0.12)', color: T.success, border: '1px solid rgba(34, 197, 94, 0.3)' },
      msgErr: { background: 'rgba(239, 68, 68, 0.12)', color: T.error, border: '1px solid rgba(239, 68, 68, 0.3)' },
      warnNote: { fontSize: 12, color: T.text2, margin: '8px 0 0 0', lineHeight: 1.5 },
      video: { width: '100%', maxWidth: 360, borderRadius: 8, background: '#000', display: 'block' },
    };

    // ─── Utilities ────────────────────────────────────────────────────────
    async function fetchJson(url, options, timeoutMs = 4000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        return await res.json();
      } finally {
        clearTimeout(t);
      }
    }

    // ─── Heartbeat Manager (module-level singleton) ─────────────────────
    // Drives camera heartbeats independent of which component is mounted.
    // The always-visible status panel (composer dock) acquires it, so presence
    // detection keeps working even when the settings page is closed. Uses a
    // detached <video> element (no DOM mount needed for drawImage capture).
    const HeartbeatMgr = {
      // Each acquire() returns an opaque token; release(token) removes exactly
      // that one. The old integer refcount was fragile: a consumer whose effect
      // cleanup ran without a matching acquire (React re-runs the cleanup on
      // every dependency change, even when the body returned early) could drive
      // the count to zero and KILL the heartbeat loop of every other consumer.
      // That is exactly how the pill ended up stuck on "心跳中断" forever —
      // camera closed, timer cleared, and nothing left to re-acquire it.
      tokens: new Set(),
      stream: null,
      video: null,
      timer: null,
      beatWorker: null,    // Worker-driven beat clock (immune to page throttling)
      retryTimer: null,
      supervisor: null,    // guarantees a beat keeps flowing no matter what
      watchdog: null,      // camera liveness watchdog (frames stopped arriving)
      noFrameSince: null,  // first time we saw videoWidth === 0 while running
      recoverAt: 0,        // rate-limit for camera re-open
      opening: false,      // a getUserMedia() call is in flight
      inFlight: false,     // a heartbeat POST is in flight
      noCam: false,        // no camera device exists at all (NotFoundError)
      lastBeatAt: 0,       // last completed beat (any outcome)
      diag: { cam: 'idle', err: null, ms: 0, beats: 0, lastBeatOk: null, emb: null, embErr: null, embMs: null, migrate: null, backend: null, warmMs: null },
      intervalMs: 350,
      running: false,
      lastError: null,     // last camera failure text (for UI diagnostics)
      // ── client-side face detection (pico.js, served by the backend) ──
      pico: null,
      picoReady: false,
      picoLoading: false,
      classifyRegion: null,
      detectCanvas: null,
      detectCtx: null,
      faceDesc: null,      // shared descriptor fn (vendor/facedesc.js)
      // ── CNN face embeddings (face-api.js, served by the backend) ──
      // The 400-D HOG descriptor could not tell two people apart reliably, so
      // identity is now decided by a real 128-D embedding. Everything below is
      // optional: if the models fail to load we fall back to the old path.
      faceapi: null,
      fapiReady: false,
      fapiLoading: false,
      embOk: false,        // warmed up AND fast enough to run live
      embAt: 0,            // last embedding attempt (ms, performance.now)
      // 1.2s cadence: one inference costs ~140ms on a GPU-backed Chrome, so
      // 600ms would eat a quarter of the main thread and make the heartbeat
      // stutter. Identity only needs to be fresher than the 2s "verified"
      // window on the server, so this is plenty.
      embIntervalMs: 1200,
      lastEmbAt: 0,
      lastEmbVec: null,
      embBusy: false,      // an inference is running in the background
      lastFaceCount: 0,    // previous beat's face count (detects "face appeared")
      migrating: false,
      migrated: false,

      // Load a first-party script served by the local backend via a <script>
      // tag (same mechanism as face-api.js below). Classic script evaluation
      // keeps globals on `window` without any dynamic-code eval pattern.
      _loadBackendScript(path) {
        return new Promise((resolve, reject) => {
          const el = document.createElement('script');
          el.src = `${BACKEND_URL}${path}`;
          el.async = true;
          el.onload = () => resolve();
          el.onerror = () => reject(new Error(`${path} load failed`));
          document.head.appendChild(el);
        });
      },

      async _loadFaceDetector() {
        if (this.picoReady || this.picoLoading) return;
        this.picoLoading = true;
        try {
          await this._loadBackendScript('/pico.js');
          const pico = window.pico;
          const buf = await (await fetch(`${BACKEND_URL}/facefinder`)).arrayBuffer();
          this.classifyRegion = pico.unpack_cascade(new Int8Array(buf));
          this.pico = pico;
          this.picoReady = true;
        } catch (e) {
          // Detector is optional: without it, presence falls back to
          // keyboard/mouse activity only.
          console.warn('[Heartbeat] face detector unavailable:', e?.message);
        } finally {
          this.picoLoading = false;
        }
        // Identity descriptor: SAME file the server uses, so the vectors it
        // computes here are directly comparable with the enrolled ones.
        try {
          await this._loadBackendScript('/facedesc.js');
          this.faceDesc = window.faceDescriptor;
        } catch (e) {
          console.warn('[Heartbeat] face descriptor unavailable:', e?.message);
        }
        // Real CNN embeddings — the thing that actually keeps other people out.
        this._loadFaceApi();
      },

      // face-api.js bundle + three model files, all served locally by the
      // backend (vendor/faceapi/**). No CDN at runtime.
      async _loadFaceApi() {
        if (this.fapiReady || this.fapiLoading) return;
        this.fapiLoading = true;
        try {
          if (!window.faceapi) {
            await new Promise((resolve, reject) => {
              const el = document.createElement('script');
              el.src = `${BACKEND_URL}/vendor/faceapi/face-api.js`;
              el.async = true;
              el.onload = () => resolve();
              el.onerror = () => reject(new Error('face-api.js load failed'));
              document.head.appendChild(el);
            });
          }
          const faceapi = window.faceapi;
          if (!faceapi || !faceapi.nets) throw new Error('faceapi global missing');
          const uri = `${BACKEND_URL}/vendor/faceapi/model`;
          await faceapi.nets.tinyFaceDetector.loadFromUri(uri);
          await faceapi.nets.faceLandmark68Net.loadFromUri(uri);
          await faceapi.nets.faceRecognitionNet.loadFromUri(uri);
          this.faceapi = faceapi;
          this.fapiReady = true;
          this.embOk = false;      // only true once the warm-up proves it is fast enough
          this.diag.emb = 'ok';
          console.log('[Heartbeat] CNN face embeddings ready');
          // Warm up BEFORE the first real frame: the very first inference
          // compiles the WebGL shaders and costs up to 15s. Doing it here
          // (page just loaded) keeps that cost off the presence path — and it
          // tells us whether this machine can afford CNN embeddings at all.
          await this._warmupEmbed();
        } catch (e) {
          this.diag.emb = 'missing';
          this.diag.embErr = String(e?.message || e).slice(0, 160);
          console.warn('[Heartbeat] CNN embeddings unavailable:', this.diag.embErr);
        } finally {
          this.fapiLoading = false;
        }
      },

      // Two things in one: pay the one-off compile cost, and measure steady
      // state. A machine without hardware acceleration takes seconds per frame
      // — running that on the heartbeat would freeze presence detection, so we
      // disable the CNN path instead of degrading everything else.
      async _warmupEmbed() {
        try {
          const faceapi = this.faceapi;
          const backend = (faceapi.tf && faceapi.tf.getBackend) ? faceapi.tf.getBackend() : 'unknown';
          this.diag.backend = backend;
          const c = document.createElement('canvas');
          c.width = 224; c.height = 224;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#808080';
          ctx.fillRect(0, 0, 224, 224);
          const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 });
          // 5 runs: the first one compiles the shaders and uploads the weights
          // (up to 15s), the second one still pays kernel autotuning. Judging on
          // the raw median therefore mis-read a perfectly capable machine as
          // "too slow". Take the median of the three FASTEST runs instead.
          const measure = async () => {
            const runs = [];
            for (let i = 0; i < 5; i++) {
              const t = performance.now();
              await faceapi.detectAllFaces(c, opts).withFaceLandmarks().withFaceDescriptors();
              runs.push(performance.now() - t);
            }
            runs.sort((a, b) => a - b);
            return Math.round(runs[1]);
          };
          let median = await measure();
          // Electron sometimes has no usable WebGL. The WASM backend is 5-10x
          // faster than the pure-JS fallback and needs no GPU — worth one try
          // before giving up on CNN identity entirely.
          if (median > 1000 && backend !== 'wasm' && faceapi.tf && faceapi.tf.setBackend) {
            try {
              if (faceapi.tf.setWasmPaths) faceapi.tf.setWasmPaths(`${BACKEND_URL}/vendor/faceapi/`);
              await faceapi.tf.setBackend('wasm');
              await faceapi.tf.ready();
              this.diag.backend = 'wasm';
              median = await measure();
            } catch (e) {
              this.diag.embErr = 'wasm: ' + String(e?.message || e).slice(0, 100);
            }
          }
          this.diag.warmMs = median;
          // A CPU-only backend needs seconds per frame; anything under ~1s
          // (WebGL, or WASM+SwiftShader) is fine for a 1.2s identity cadence.
          if (median > 1000) {
            this.diag.emb = 'slow';
            console.warn(`[Heartbeat] CNN too slow here (${this.diag.backend}, ${median}ms/frame) — keeping the legacy descriptor`);
            return;
          }
          console.log(`[Heartbeat] CNN warm-up done (${this.diag.backend}, ${median}ms/frame)`);
          this.embOk = true;
          this._ensureV2Refs();
        } catch (e) {
          this.diag.emb = 'slow';
          this.diag.embErr = 'warmup: ' + String(e?.message || e).slice(0, 140);
        }
      },

      // Compute the 128-D embedding of the largest face(s) currently visible.
      // Runs at most once per embIntervalMs; between runs the previous vector
      // is reused (valid for 1.5s), which keeps the heartbeat cadence intact.
      // Kick an embedding WITHOUT waiting for it. The heartbeat must never be
      // blocked by inference: in a hidden tab one inference can take 2-3s,
      // and awaiting it stretched the beat cadence past the server's identity
      // freshness window — which read as "user left" and blacked the screen,
      // then the next late beat said "present" again (the flicker loop).
      // `force` bypasses the rate limit when a face has just re-appeared, so
      // returning to the seat does not wait out the 1.2s interval.
      _pumpEmbed(force) {
        if (this.embBusy) return;
        const now = performance.now();
        if (!force && now - this.embAt < this.embIntervalMs) return;
        this.embAt = now;
        this.embBusy = true;
        this._embedNow()
          .catch(() => {})
          .finally(() => { this.embBusy = false; });
      },

      async _embedNow() {
        try {
          const faceapi = this.faceapi;
          const canvas = this.detectCanvas;
          if (!faceapi || !canvas || !canvas.width) return [];
          const t0 = performance.now();
          const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 });
          const res = await faceapi.detectAllFaces(canvas, opts)
            .withFaceLandmarks()
            .withFaceDescriptors();
          this.diag.embMs = Math.round(performance.now() - t0);
          if (!res || !res.length) { this.lastEmbVec = null; return []; }
          res.sort((a, b) => b.detection.box.width - a.detection.box.width);
          const out = [];
          for (const r of res.slice(0, 2)) {
            const d = r.descriptor;
            let n = 0;
            for (let i = 0; i < d.length; i++) n += d[i] * d[i];
            n = Math.sqrt(n) || 1;
            out.push(Array.from(d, v => Math.round((v / n) * 1e4) / 1e4));
          }
          this.lastEmbVec = out[0];
          this.lastEmbAt = performance.now();
          return out;
        } catch (e) {
          this.diag.embErr = String(e?.message || e).slice(0, 160);
          return [];
        }
      },

      // One-time migration: the browser computes the CNN embedding of the
      // ALREADY ENROLLED photo and hands it to the backend, so switching to
      // the stronger descriptor needs nothing from the user. Safe by design —
      // it only ever uses the registration photo, never a live stranger.
      async _ensureV2Refs() {
        if (this.migrating || this.migrated) return;
        this.migrating = true;
        try {
          const p = await fetchJson(`${BACKEND_URL}/presence`, {}, 3000);
          if (!p?.identity || !p.identity.needsV2) {
            this.migrated = true;
            return;
          }
          const res = await fetch(`${BACKEND_URL}/face-image`);
          if (!res.ok) { this.diag.migrate = 'no photo'; return; }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          let img;
          try {
            img = await new Promise((resolve, reject) => {
              const i = new Image();
              i.onload = () => resolve(i);
              i.onerror = () => reject(new Error('photo decode failed'));
              i.src = url;
            });
          } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
          const faceapi = this.faceapi;
          const r = await faceapi.detectAllFaces(img,
            new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
            .withFaceLandmarks()
            .withFaceDescriptors();
          if (!r || !r.length) { this.diag.migrate = 'photo: no face'; return; }
          r.sort((a, b) => b.detection.box.width - a.detection.box.width);
          const vecs = r.slice(0, 2).map(x => {
            const d = x.descriptor;
            let n = 0;
            for (let i = 0; i < d.length; i++) n += d[i] * d[i];
            n = Math.sqrt(n) || 1;
            return Array.from(d, v => Math.round((v / n) * 1e4) / 1e4);
          });
          const out = await fetchJson(`${BACKEND_URL}/identity/enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ descriptors: vecs }),
          }, 10000);
          this.migrated = out?.status === 'success' || out?.refs > 0;
          this.diag.migrate = this.migrated ? `ok ${out.refs || ''}` : (out?.message || 'failed');
          console.log('[Heartbeat] identity migrated to CNN:', this.diag.migrate);
        } catch (e) {
          this.diag.migrate = String(e?.message || e).slice(0, 120);
        } finally {
          this.migrating = false;
        }
      },

      // Returns { count, descs, ms } — descs holds the identity vector(s) for
      // the best face(s) in frame, or [] when the descriptor is unavailable.
      _detectFaces() {
        try {
          const video = this.video;
          if (!video || !video.videoWidth || !this.picoReady) return null;
          const t0 = performance.now();
          if (!this.detectCanvas) {
            this.detectCanvas = document.createElement('canvas');
            this.detectCtx = this.detectCanvas.getContext('2d', { willReadFrequently: true });
          }
          const canvas = this.detectCanvas;
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          this.detectCtx.drawImage(video, 0, 0);
          const rgba = this.detectCtx.getImageData(0, 0, canvas.width, canvas.height).data;
          // RGBA → grayscale (luma-ish weighted sum, as in the pico.js demo)
          const w = canvas.width, hgt = canvas.height;
          const gray = new Uint8Array(w * hgt);
          for (let r = 0; r < hgt; ++r)
            for (let c = 0; c < w; ++c)
              gray[r * w + c] = (2 * rgba[r * 4 * w + 4 * c] + 7 * rgba[r * 4 * w + 4 * c + 1] + rgba[r * 4 * w + 4 * c + 2]) / 10;
          const minDim = Math.min(w, hgt);
          // Window set tuned for a face in front of a laptop camera. The old
          // range (12%…90% of the short side, scale 1.15) produced ~15 cascade
          // scales and cost ~16ms per frame — 2x more than needed, and that CPU
          // time is exactly what made every reaction feel sluggish.
          // Measured on 59 real captures: identical recall (55/59), identical
          // identity scores, 7.5ms per frame.
          const dts = this.pico.run_cascade(
            { pixels: gray, nrows: hgt, ncols: w, ldim: w },
            this.classifyRegion,
            {
              shiftfactor: 0.12,
              minsize: Math.max(26, Math.round(minDim * 0.12)),
              maxsize: Math.max(48, Math.round(minDim * 0.75)),
              scalefactor: 1.2,
            }
          );
          const dets = this.pico.cluster_detections(dts, 0.1).filter(d => d[3] >= 5.0);
          const ms = performance.now() - t0;
          if (!dets.length) return { count: 0, descs: [], ms };
          const descs = [];
          if (this.faceDesc) {
            dets.sort((a, b) => b[3] - a[3]);      // best quality face first
            // Up to 2 faces: if the owner is not the largest/highest-quality
            // face in frame (someone else leaning in), the second descriptor
            // still has a chance to match.
            for (const [r, c, s] of dets.slice(0, 2)) {
              const vec = this.faceDesc(gray, w, hgt, { x: c, y: r, w: s, h: s });
              if (vec) descs.push(Array.from(vec, v => Math.round(v * 1000) / 1000));
            }
          }
          return { count: dets.length, descs, ms };
        } catch (e) {
          this.diag.err = 'detect: ' + (e?.message || e);
          return null;
        }
      },

      _mediaErrorText(e) {
        const name = e?.name || 'unknown';
        switch (name) {
          case 'NotFoundError':
          case 'OverconstrainedError':
            return '未找到摄像头设备：请连接摄像头后重试';
          case 'NotAllowedError':
          case 'SecurityError':
            return '浏览器拒绝摄像头权限：请在地址栏左侧允许摄像头';
          case 'NotReadableError':
            return '摄像头被其他程序占用：请关闭占用方后重试';
          default:
            return `无法访问摄像头：${e?.message || name}`;
        }
      },

      acquire(intervalMs) {
        const token = { ms: Math.max(intervalMs || 500, 250) };
        this.tokens.add(token);
        this._applyInterval();
        if (!this.running) {
          this.running = true;
          this._installWakeHooks();
          // The beat timer is started HERE, not in _openCamera(): a camera that
          // fails to open (busy device, permission prompt, hung getUserMedia)
          // used to leave the client with no timer at all, so not a single
          // heartbeat was sent and the server declared the client dead.
          this._ensureBeatTimer();
          this._startSupervisor();
          this._openCamera();
        }
        return token;
      },

      // Background/hidden windows get their timers throttled or frozen by the
      // browser, which silently stops the heartbeat and leaves the server
      // thinking the client is gone. Beat immediately whenever the window
      // becomes visible or focused again, and nudge a paused video back to
      // life — that is the moment the user is actually looking at the screen.
      _installWakeHooks() {
        if (this._wakeHooks) return;
        this._wakeHooks = true;
        const wake = () => {
          if (!this.running) return;
          try {
            if (this.video && this.video.paused) this.video.play().catch(() => {});
            if (this.video && this.video.videoWidth) this.noFrameSince = null;
          } catch { /* noop */ }
          this._ensureBeatTimer();
          this._send();
        };
        document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
        window.addEventListener('focus', wake);
        window.addEventListener('pageshow', wake);
      },

      release(token) {
        if (token && this.tokens.delete(token)) {
          // fall through to interval/stop bookkeeping
        } else if (!token) {
          // Legacy call with no token: stop everything (old behaviour).
          this.tokens.clear();
        } else {
          return;   // unknown token: never punish the other consumers
        }
        if (this.tokens.size === 0) this._stop();
        else this._applyInterval();
      },

      _applyInterval() {
        const eff = this.tokens.size
          ? Math.max(250, Math.min(...Array.from(this.tokens, t => t.ms)))
          : 500;
        if (eff === this.intervalMs) return;
        this.intervalMs = eff;
        this._ensureBeatTimer(true);
      },

      // (Re)create the beat interval. Idempotent; `force` restarts it after an
      // interval change.
      //
      // The clock lives in a dedicated Web Worker on purpose. When the dsh tab
      // is hidden (user switched to another window/tab), browsers clamp page
      // timers to >=1s (and to 1/min under intensive throttling) — the 350ms
      // heartbeat degraded into ~4s gaps, and the server read every gap as
      // "person left" (screen off) followed by the next throttled beat as
      // "person back" (screen on): the off/on flicker loop. Dedicated worker
      // timers are NOT subject to page-visibility throttling, and message
      // events on the main thread are delivered promptly even while hidden, so
      // the beat keeps its cadence no matter where the user is. Falls back to
      // a plain interval if workers are unavailable.
      _ensureBeatTimer(force) {
        if (!this.running) return;
        const hasClock = !!(this.beatWorker || this.timer);
        if (hasClock && !force) return;
        this._teardownBeatTimer();
        try {
          const src =
            'let h=null;onmessage=(e)=>{const d=e.data||{};' +
            'if(d.cmd==="start"){if(h)clearInterval(h);h=setInterval(()=>postMessage(1),d.ms);}' +
            'else if(d.cmd==="stop"){if(h){clearInterval(h);h=null;}}};';
          const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
          const w = new Worker(url);
          URL.revokeObjectURL(url);
          w.onmessage = () => { try { this._send(); } catch { /* noop */ } };
          w.postMessage({ cmd: 'start', ms: this.intervalMs });
          this.beatWorker = w;
          // Visible marker so it is obvious from DevTools which build is live
          // (dsh serves the client bundle from memory captured at startup).
          console.info('[Heartbeat] worker clock active (' + this.intervalMs + 'ms, v20261110c)');
        } catch {
          // Worker construction blocked (strict CSP etc.) — old behaviour.
          this.timer = setInterval(() => this._send(), this.intervalMs);
        }
      },

      _teardownBeatTimer() {
        if (this.beatWorker) {
          try { this.beatWorker.postMessage({ cmd: 'stop' }); } catch { /* noop */ }
          try { this.beatWorker.terminate(); } catch { /* noop */ }
          this.beatWorker = null;
        }
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
      },

      // Last line of defence: every second, make sure the loop is actually
      // alive. Any bug that clears the timer, throttles it away, or loses the
      // camera now self-heals within a second instead of silently dying until
      // the user restarts dsh.
      _startSupervisor() {
        if (this.supervisor) return;
        this.supervisor = setInterval(() => {
          if (!this.running) return;
          if (!this.tokens.size) return;      // nothing wants heartbeats
          this._ensureBeatTimer();
          const age = Date.now() - (this.lastBeatAt || 0);
          if (age > Math.max(this.intervalMs * 3, 1500)) {
            console.warn('[Heartbeat] loop stalled ' + Math.round(age) + 'ms — forcing a beat');
            this._send();
          }
          // Camera side: recover a dead/missing picture without waiting on the
          // (throttled) watchdog tick.
          const v = this.video;
          if (!this.opening && (!v || !v.videoWidth)) {
            if (this.noFrameSince == null) this.noFrameSince = Date.now();
          }
        }, 1000);
      },

      _stop() {
        this.running = false;
        this.lastError = null;
        this.diag.cam = 'idle';
        this._teardownBeatTimer();
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
        if (this.supervisor) { clearInterval(this.supervisor); this.supervisor = null; }
        this.noFrameSince = null;
        this.opening = false;
        if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
        if (this.video) { try { this.video.pause(); } catch { /* noop */ } this.video.srcObject = null; this.video = null; }
      },

      // Camera liveness: a stream can be killed by the OS (device sleep, another
      // app grabbing it, USB hiccup) without any JS error. When that happens
      // `videoWidth` stays 0 and — before this watchdog existed — heartbeats
      // stopped being sent at all, so the UI sat on "检测中" forever and nothing
      // reacted to a face. Poll once a second and re-open the camera.
      _startWatchdog() {
        if (this.watchdog) return;
        this.watchdog = setInterval(() => {
          if (!this.running) return;
          const v = this.video;
          const alive = !!(v && v.videoWidth && v.readyState >= 2 &&
            this.stream && this.stream.getVideoTracks().some(t => t.readyState === 'live'));
          if (alive) { this.noFrameSince = null; if (this.diag.cam !== 'ok' && this.diag.cam !== 'idle') { this.diag.cam = 'ok'; this.diag.err = null; } return; }
          if (this.noFrameSince == null) this.noFrameSince = Date.now();
          this.diag.cam = this.video ? 'novideo' : 'error';
          // 2.5s of no frames = the stream is dead, not just warming up.
          if (Date.now() - this.noFrameSince > 2500 && Date.now() > this.recoverAt) {
            this.recoverAt = Date.now() + 4000;
            console.warn('[Heartbeat] camera stalled — reopening');
            this._reopen();
          }
        }, 1000);
      },

      _reopen() {
        if (!this.running) return;
        if (this.opening) return;          // one getUserMedia at a time
        // NOTE: the beat timer is deliberately NOT touched here. Reopening the
        // camera must never interrupt the heartbeat — a beat with
        // cam='novideo' still tells the server "client alive, no picture yet",
        // which is what keeps the state machine honest instead of guessing.
        if (this.stream) { try { this.stream.getTracks().forEach(t => t.stop()); } catch { /* noop */ } this.stream = null; }
        if (this.video) { try { this.video.pause(); } catch { /* noop */ } this.video.srcObject = null; this.video = null; }
        this.noFrameSince = null;
        this._openCamera();
      },

      async _openCamera() {
        if (!this.running) return;
        if (this.opening) return;
        this.opening = true;
        try {
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw Object.assign(new Error('浏览器不支持摄像头访问'), { name: 'Unsupported' });
          }
          // getUserMedia can hang forever (another app holding the device, a
          // permission prompt that never surfaces). Without this race the whole
          // camera pipeline — and, before this fix, the heartbeat — stayed dead
          // with no error and no retry.
          const stream = await Promise.race([
            navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } }),
            new Promise((_, reject) => setTimeout(
              () => reject(Object.assign(new Error('摄像头打开超时'), { name: 'TimeoutError' })), 6000)),
          ]);
          if (!this.running) { stream.getTracks().forEach(t => t.stop()); return; }
          this.stream = stream;
          this.lastError = null;
          this.diag.cam = 'ok';
          this.diag.err = null;
          this.noCam = false;   // camera found — clear the no-device statement
          const video = document.createElement('video');
          video.autoplay = true;
          video.muted = true;
          video.playsInline = true;
          video.srcObject = stream;
          video.play().catch(() => {
            // Autoplay can be rejected while the page is hidden; retry on the
            // next visible frame instead of leaving a dead video element.
            setTimeout(() => { try { video.play().catch(() => {}); } catch { /* noop */ } }, 500);
          });
          this.video = video;
          // A track can die silently — recover immediately rather than waiting
          // for the watchdog tick.
          stream.getVideoTracks().forEach(t => {
            t.addEventListener('ended', () => { if (this.running) setTimeout(() => this._reopen(), 400); });
          });
          this._loadFaceDetector();
          this._ensureBeatTimer();
          this._startWatchdog();
          // First beat right away: the server must learn the client is alive
          // even if the first frame is not decodable yet.
          this._send();
        } catch (e) {
          this.lastError = this._mediaErrorText(e);
          this.diag.cam = 'error';
          this.diag.err = this.lastError;
          // Distinguish "no camera hardware exists" (NotFoundError) from a
          // busy/broken one: only the former lets the server's no-camera
          // fallback engage, and only it deserves a slow retry cadence —
          // plugging a camera in later still recovers automatically.
          const noDevice = e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError');
          if (noDevice) this.noCam = true;
          // Transient failure (permission prompt / camera busy) must not kill
          // presence detection forever — retry while someone still holds it.
          if (this.running) {
            if (this.retryTimer) clearTimeout(this.retryTimer);
            const delay = noDevice ? 15000 : 3000;
            this.retryTimer = setTimeout(() => { this.retryTimer = null; this._openCamera(); }, delay);
          }
        } finally {
          this.opening = false;
        }
      },

      async _send() {
        // A heartbeat is sent on EVERY beat, camera or not. The server treats a
        // byte as proof-of-life only (faces/descs are the actual evidence), and
        // a silent client is indistinguishable from a dead one — which used to
        // freeze the UI on "检测中" and make the whole plugin look broken.
        //
        // Never queue beats: with a 3s request timeout and a 350ms cadence a
        // stalled backend would otherwise build an ever-growing backlog, and
        // every detection ran on stale frames (that is what made recognition
        // feel progressively slower).
        if (this.inFlight) return;
        this.inFlight = true;
        const body = { cam: this.diag.cam, det: this.picoReady ? 'ok' : 'missing' };
        // Tell the server this machine has NO camera device at all — the only
        // statement that may engage its input-idle fallback mode.
        if (this.noCam) body.nocam = true;
        // Report whether the CNN models are live: the settings page shows this
        // so a silent fallback to the weak descriptor is visible.
        if (this.diag.emb) body.emb = this.diag.emb;
        if (this.diag.embMs != null) body.embMs = this.diag.embMs;
        if (this.diag.migrate) body.migrate = this.diag.migrate;
        if (this.diag.backend) body.backend = this.diag.backend;
        try {
          const video = this.video;
          if (video && video.videoWidth) {
            const det = this._detectFaces();
            if (det) {
              this.diag.ms = Math.round(det.ms * 10) / 10;
              body.faces = det.count;
              body.ms = this.diag.ms;
              if (det.descs && det.descs.length) body.descs = det.descs;
              this.diag.err = null;
            }
            // CNN embedding: fired in the background, never awaited — the beat
            // itself must stay on schedule. Each beat carries the freshest
            // COMPLETED vector, so the server always sees the latest identity
            // evidence without the heartbeat paying the inference latency.
            if (det && det.count > 0 && this.embOk) {
              this._pumpEmbed(this.lastFaceCount === 0);   // face just (re)appeared
              if (this.lastEmbVec && performance.now() - this.lastEmbAt < 2500) {
                body.descs2 = [this.lastEmbVec];
              }
            }
            if (det) this.lastFaceCount = det.count;
          }
          if (this.diag.err) body.err = String(this.diag.err).slice(0, 200);
          const r = await fetchJson(`${BACKEND_URL}/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }, 3000);
          this.diag.beats += 1;
          this.diag.lastBeatOk = !!r;
          this.lastBeatAt = Date.now();
        } catch (e) {
          this.diag.lastBeatOk = false;
          this.diag.err = 'beat: ' + (e?.message || e);
          this.lastBeatAt = Date.now();
        } finally {
          this.inFlight = false;
        }
      },
    };

    // ─── Toggle ───────────────────────────────────────────────────────────
    function Toggle({ checked, onChange }) {
      return h('div', {
        onClick: e => { e.stopPropagation(); onChange(!checked); },
        onKeyDown: e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!checked); } },
        style: { ...s.toggle, background: checked ? T.accent : T.borderL2, opacity: checked ? 1 : 0.55 },
        role: 'switch', 'aria-checked': checked, tabIndex: 0,
      },
        h('div', { style: { ...s.toggleKnob, left: checked ? 16 : 2 } })
      );
    }

    // ─── Capture Panel (inline; camera preview) ──────────────────────────
    // Rendered inside the user card (no fixed overlay → not clipped by the
    // DSH settings host container's stacking context).
    function CapturePanel({ type, user, onDone }) {
      const videoRef = React.useRef(null);
      const streamRef = React.useRef(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [ready, setReady] = React.useState(false);

      const mediaOk = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

      // Map getUserMedia error codes to actionable Chinese messages.
      const mediaErrorText = (e) => {
        const name = e?.name || 'unknown';
        switch (name) {
          case 'NotFoundError':
          case 'OverconstrainedError':
            return '未找到摄像头设备。本机没有检测到摄像头硬件——请连接 USB 摄像头后重试，或改用"路径录入"。';
          case 'NotAllowedError':
          case 'SecurityError':
            return '浏览器拒绝访问摄像头。请在本页面地址栏左侧允许摄像头权限后重试。';
          case 'NotReadableError':
            return '摄像头被其他程序占用。请关闭占用摄像头的程序后重试。';
          default:
            return `无法访问摄像头：${e?.message || name}`;
        }
      };

      React.useEffect(() => {
        let cancelled = false;
        if (mediaOk) {
          navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
            .then(stream => {
              if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
              streamRef.current = stream;
              if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.play().catch(() => {});
                setReady(true);
                setError(null);
              }
            })
            .catch(e => { if (!cancelled) setError(mediaErrorText(e)); });
        }
        return () => {
          cancelled = true;
          if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
        };
      }, []);

      const retryCamera = () => {
        setError(null);
        setReady(false);
        navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
          .then(stream => {
            streamRef.current = stream;
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
              videoRef.current.play().catch(() => {});
              setReady(true);
            }
          })
          .catch(e => setError(mediaErrorText(e)));
      };

      const captureAndRegister = async () => {
        setBusy(true);
        try {
          const video = videoRef.current;
          if (!video || video.videoWidth === 0) throw new Error('摄像头未就绪');
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);
          const b64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
          const ep = '/register/face';
          const data = await fetchJson(`${BACKEND_URL}${ep}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: user.user_id, image_b64: b64, mime: 'image/jpeg' }),
          }, 15000);
          onDone(data);
        } catch (e) {
          setError(`录入失败：${e.message}`);
        } finally {
          setBusy(false);
        }
      };

      const title = '📷 摄像头采集人脸';

      return h('div', {
        style: {
          marginTop: 10, padding: 14,
          background: T.bgLayer1, borderRadius: 10,
          border: `1px solid ${T.accent}`,
        },
      },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10, color: T.text } }, title),
        mediaOk
          ? null
          : h('div', { style: { ...s.msg, ...s.msgErr, marginBottom: 10 } },
              '✕ 当前浏览器不支持摄像头 API（navigator.mediaDevices 不可用）。请使用"路径录入"方式。'),
        mediaOk
          ? h('div', null,
              h('video', { ref: videoRef, autoPlay: true, muted: true, playsInline: true, style: s.video }),
              h('p', { style: { fontSize: 12, color: T.text2, margin: '8px 0 0 0', lineHeight: 1.5 } },
                '请正对摄像头，保证面部清晰、光线均匀。'),
              ready
                ? h('button', {
                    onClick: captureAndRegister, disabled: busy,
                    style: { ...s.btnPrimary, width: '100%', marginTop: 10, padding: '10px 16px', opacity: busy ? 0.5 : 1 },
                  }, busy ? '处理中…' : '✓ 采集并录入')
                : h('div', { style: { marginTop: 10, textAlign: 'center', color: T.text3, fontSize: 13 } }, '摄像头启动中…'),
            )
          : null,
        error ? h('div', { style: { ...s.msg, ...s.msgErr, marginTop: 10, marginBottom: 0 } },
          h('div', null, `✕ ${error}`),
          h('button', { onClick: retryCamera, style: { ...s.btnSmall, marginTop: 8 } }, '🔄 重试摄像头')
        ) : null
      );
    }

    // ─── Main Config Panel ────────────────────────────────────────────────
    function BioRecognizeConfig(ctx) {
      const [config, setConfig] = React.useState({});
      const [dataReady, setDataReady] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [msg, setMsg] = React.useState(null);
      const [users, setUsers] = React.useState([]);
      const [newUserId, setNewUserId] = React.useState('');
      const [newUserName, setNewUserName] = React.useState('');
      const [showAddUser, setShowAddUser] = React.useState(false);
      const [service, setService] = React.useState({ running: null, managedPid: null, busy: false });
      const [capture, setCapture] = React.useState(null);

      const configRef = React.useRef(config);
      React.useEffect(() => { configRef.current = config; }, [config]);

      // Every toggle persists IMMEDIATELY. The status pill's 300ms heartbeat
      // holder follows the BACKEND's `enabled` flag (via /presence polling),
      // so a local-only change left the engine running: the user switched
      // "启用检测" off and the screen kept going dark. Server-side saving on
      // each change also means there is no separate "save" step to forget.
      const upd = (k, v) => {
        setConfig(p => ({ ...p, [k]: v }));
        const next = { ...configRef.current, [k]: v };
        fetchJson(`${BACKEND_URL}/config`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
        }, 5000).then(r => {
          if (r && r.status === 'success') showMsg('success', '配置已保存');
          else showMsg('error', (r && r.message) || '保存失败');
        }).catch(() => showMsg('error', '网络错误，请确认后端已启动'));
      };
      const showMsg = (type, text) => setMsg({ type, text });

      // ── Service control via Host RPC ──
      const hostCall = async (method, payload) => {
        const c = realCtx;
        if (!c) return null;
        const connection = c.get ? c.get('connection') : c.connection;
        if (connection?.rpc?.call) {
          try {
            return await connection.rpc.call('/api', 'bio-recognize', { method, payload: payload || {} });
          } catch (e) {
            // rpc.call threw: report the transport error with diagnostics.
            return { ok: false, result: null, error: { code: 'rpc-call-threw', message: `${e?.name || 'Error'}: ${e?.message || 'unknown'}`, details: {} } };
          }
        }
        return { ok: false, result: null, error: { code: 'connection-unavailable', message: 'ctx.connection.rpc 不可用（Host 端未注册 RPC 通道）', details: {} } };
      };

      const refreshServiceStatus = async () => {
        const res = await hostCall('status');
        if (res?.ok !== undefined && res.result !== undefined) {
          setService({ running: !!res.result?.running, managedPid: res.result?.managedPid || null, busy: false });
          return !!res.result?.running;
        }
        try {
          const probe = await fetchJson(`${BACKEND_URL}/health`, {}, 1500);
          const up = probe.status === 'ok';
          setService({ running: up, managedPid: null, busy: false });
          return up;
        } catch {
          setService({ running: false, managedPid: null, busy: false });
          return false;
        }
      };

      const loadBackendData = async () => {
        const up = await refreshServiceStatus();
        if (up) {
          try {
            const [c, u] = await Promise.all([
              fetchJson(`${BACKEND_URL}/config`, {}, 4000),
              fetchJson(`${BACKEND_URL}/users`, {}, 4000),
            ]);
            setConfig(c.config || {});
            setUsers(u.users || []);
          } catch { /* keep current data */ }
        }
        setDataReady(true);
      };

      const startService = async () => {
        setService(p => ({ ...p, busy: true }));
        const res = await hostCall('start');
        if (res?.ok === false) {
          const diag = res.result?._diag ? ` [Host 诊断: 收到 method=${res.result._diag.receivedMethod ?? '无'}, endpoint=${res.result._diag.endpoint ?? '无'}]` : '';
          showMsg('error', `启动失败：${res.error?.message || '未知原因'}${diag}`);
        } else if (res?.ok) {
          showMsg('success', '后端服务已启动');
        }
        await refreshServiceStatus();
        loadBackendData();
      };

      const stopService = async () => {
        setService(p => ({ ...p, busy: true }));
        const res = await hostCall('stop');
        // "Stopped" is only reported when the port actually closed — the host
        // now verifies it instead of trusting that a signal was sent.
        if (res?.ok === false) {
          showMsg('error', `停止失败：${res.result?.message || res.error?.message || '后端仍在运行'}`);
        } else if (res?.ok) {
          showMsg('success', '服务已停止');
        }
        await refreshServiceStatus();
      };

      React.useEffect(() => { loadBackendData(); }, []);

      // ── User & registration actions ──
      const addNewUser = async () => {
        if (!newUserId || !newUserName) { showMsg('error', '请输入用户ID和姓名'); return; }
        try {
          const data = await fetchJson(`${BACKEND_URL}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: newUserId, name: newUserName }),
          }, 5000);
          if (data.status === 'success') {
            setUsers(p => [...p, { user_id: newUserId, name: newUserName }]);
            setNewUserId(''); setNewUserName(''); setShowAddUser(false);
            showMsg('success', `用户 ${newUserName} 创建成功`);
          } else showMsg('error', data.message || '创建失败');
        } catch { showMsg('error', '网络错误，请确认后端已启动'); }
      };

      const registerFromPath = async (userId, type, path) => {
        if (!path) {
          showMsg('error', '请输入人脸文件路径'); return;
        }
        try {
          const data = await fetchJson(`${BACKEND_URL}/register/face`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, image_path: path }),
          }, 15000);
          if (data.status === 'success') showMsg('success', '人脸录入成功');
          else showMsg('error', data.message || '录入失败');
        } catch { showMsg('error', '网络错误，请确认后端已启动'); }
      };

      const onCaptureDone = (data) => {
        const cap = capture;
        setCapture(null);
        if (data && data.status === 'success') {
          if (cap?.type === 'face' && data.identity_enrolled === false) {
            showMsg('error', '人脸已保存，但未能从照片中提取特征：身份比对不会生效，请换一张正面、光线均匀的照片重录');
          } else {
            showMsg('success', '人脸录入成功');
          }
          loadBackendData();
        } else {
          showMsg('error', (data && data.message) || '录入失败');
        }
      };

      const saveConfig = async () => {
        setSaving(true);
        try {
          const data = await fetchJson(`${BACKEND_URL}/config`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
          }, 8000);
          if (data.status === 'success') showMsg('success', '配置已保存');
          else showMsg('error', data.message || '保存失败');
        } catch { showMsg('error', '网络错误，请确认后端已启动'); }
        finally { setSaving(false); }
      };

      const online = service.running === true;

      // ── Presence heartbeat via camera (HeartbeatMgr singleton) ──
      // The status panel keeps heartbeats running even with this page closed;
      // acquiring here only bumps the refcount / applies the configured interval.
      React.useEffect(() => {
        const shouldRun = !!(online && config.enabled && config.faceEnabled);
        // Must NOT return a cleanup when nothing was acquired: the cleanup runs
        // on every dependency change, and the unpaired release() used to drop
        // the refcount to zero and shut the camera down for the status panel.
        if (!shouldRun) return undefined;
        const token = HeartbeatMgr.acquire(config.detectionInterval);
        return () => HeartbeatMgr.release(token);
      }, [online, config.enabled, config.faceEnabled, config.detectionInterval]);

      // ── Live diagnostics: shows WHICH signal keeps the screen awake ──
      const [diag, setDiag] = React.useState(null);
      React.useEffect(() => {
        if (!online) { setDiag(null); return undefined; }
        let disposed = false;
        let timer = 0;
        const tick = async () => {
          try {
            const d = await fetchJson(`${BACKEND_URL}/presence`, {}, 2500);
            if (!disposed) setDiag(d);
          } catch { if (!disposed) setDiag(null); }
          if (!disposed) timer = window.setTimeout(tick, 1500);
        };
        tick();
        return () => { disposed = true; clearTimeout(timer); };
      }, [online]);

      // Early return must come AFTER every hook: returning before a useEffect
      // changed the hook count between renders and crashed the
      // component with React error #310 (blank settings page).
      if (!dataReady) {
        return h('div', { style: { padding: 48, textAlign: 'center', color: T.text2, fontFamily: FONT } }, '加载中…');
      }

      return h('div', { style: s.page },
        // ── Header ──
        h('div', { style: s.header },
          h('span', { style: { fontSize: 32 } }, '🔐'),
          h('div', null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h('h1', { style: s.h1 }, '智能熄屏 · 生物识别'),
              h('span', { style: { ...s.badge, ...(online ? s.badgeOk : s.badgeErr) } },
                online ? '● 在线' : '● 离线'),
            ),
            h('p', { style: s.subtitle }, '离开自动熄屏 · 返回自动亮屏')
          )
        ),

        // ── Backend service control ──
        h('div', { style: s.section },
          h('div', { style: s.sectionTitle },
            h('span', null, '🔌'), h('span', null, '后端服务')
          ),
          h('div', { style: { ...s.row, marginBottom: 8 } },
            h('span', { style: s.label }, '服务地址'),
            h('span', { style: { fontSize: 13, color: T.text, fontFamily: 'monospace', flex: 1 } }, BACKEND_URL),
            h('button', { onClick: () => loadBackendData(), style: s.btnSecondary, disabled: service.busy }, '刷新')
          ),
          h('div', { style: s.row },
            h('span', { style: s.label }, '服务开关'),
            h('div', { style: { display: 'flex', gap: 8, flex: 1 } },
              // Single toggle button: the label itself reflects the state,
              // so there is exactly ONE control instead of button + switch.
              online
                ? h('button', { onClick: stopService, disabled: service.busy, style: { ...s.btnSecondary, borderColor: T.error, color: T.error } },
                    service.busy ? '停止中…' : '⏹ 关闭服务')
                : h('button', { onClick: startService, disabled: service.busy, style: s.btnPrimary },
                    service.busy ? '启动中…' : '▶ 启动服务')
            )
          ),
          service.running === null
            ? h('p', { style: s.warnNote }, '状态探测中…')
            : online
              ? h('p', { style: s.warnNote }, service.managedPid ? `运行中 · PID ${service.managedPid}` : '运行中（外部实例）')
              : h('p', { style: s.warnNote }, '离线 — 点击"启动服务"，或手动运行：node server.js --port=8765')
        ),

        // ── Detection settings ──
        h('div', { style: s.section },
          h('div', { style: s.sectionTitle },
            h('span', null, '⚙️'), h('span', null, '智能检测')
          ),
          h('div', { style: s.row },
            h('span', { style: { ...s.label, color: T.text, fontWeight: 500 } }, '启用检测'),
            h('div', { style: { flex: 1 } }),
            h(Toggle, { checked: config.enabled || false, onChange: v => upd('enabled', v) })
          ),
          h('div', { style: s.divider }),
          h('div', { style: s.groupLabel }, '检测模态'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr', gap: 10 } },
            [
              { key: 'faceEnabled', icon: '👤', title: '人脸', desc: '实时识别 + 身份比对' },
            ].map(m => {
              const active = config[m.key];
              return h('div', { key: m.key, style: { ...s.modalityCard, ...(active ? { borderColor: T.accent } : {}) } },
                h('span', { style: { fontSize: 20, flex: '0 0 24px', textAlign: 'center' } }, m.icon),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontSize: 13, fontWeight: 500, color: T.text } }, m.title),
                  h('div', { style: { fontSize: 11, color: T.text2, marginTop: 2 } }, m.desc)
                ),
                h(Toggle, { checked: !!active, onChange: v => upd(m.key, v) })
              );
            })
          ),
          h('div', { style: s.divider }),
          h('div', { style: s.groupLabel }, '在场判定'),
          // "仅生物识别" and "只认本人" are no longer switches: once face
          // recognition is on, judging only by biometrics (keyboard/mouse can
          // neither wake nor hold the screen) and verifying WHO is in front of
          // the camera are the only modes that make sense for this plugin.
          h('div', { style: s.row },
            h('span', { style: s.label }, '匹配阈值'),
            h('input', {
              type: 'number',
              value: Math.round((config.matchThreshold == null ? 0.65 : config.matchThreshold) * 100),
              onChange: e => upd('matchThreshold', Math.min(Math.max(parseInt(e.target.value) || 65, 30), 95) / 100),
              min: 30, max: 95, step: 1, style: s.inputSmall,
            }),
            h('span', { style: { fontSize: 12, color: T.text2 } }, '%，越大越严格（认不出时可用 3 秒键鼠强制亮屏）')
          ),
          h('div', { style: s.modalityCard },
            h('span', { style: { fontSize: 16 } }, '🌑'),
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontSize: 13, fontWeight: 500, color: T.text } }, '黑屏模式'),
              h('div', { style: { fontSize: 11, color: T.text2, marginTop: 2, lineHeight: 1.5 } },
                '只认人脸生物特征：命中即保持亮屏、命中即亮屏；消失并持续"离场确认"后熄屏。键鼠完全无权唤醒。人脸须与已登记本人匹配（1:N 特征比对）。')
            )
          ),
          h('div', { style: s.divider }),
          h('div', { style: s.groupLabel }, '无摄像头降级'),
          h('div', { style: s.row },
            h('span', { style: s.label }, '键鼠节能模式'),
            h('div', { style: { flex: 1 } }),
            h(Toggle, { checked: !!config.noCamMode, onChange: v => upd('noCamMode', v) })
          ),
          h('div', { style: { fontSize: 11, color: T.text2, margin: '4px 0 10px', lineHeight: 1.5 } },
            '本机没有摄像头时可用：键鼠空闲达到下方时长即熄屏，动键鼠即亮屏。仅节能、无身份安全（任何人动键鼠都能亮屏）。摄像头正常的机器请勿开启。'),
          diag ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
            [
              ['判定', diag.state === 'present' ? '在场' : diag.state === 'absent' ? '离开' : '待机'],
              ['人脸', diag.bioSignals && diag.bioSignals.face ? '就绪' : '不可用'],
              diag.client ? ['摄像头',
                diag.client.cam === 'ok' ? '正常'
                  : diag.client.cam === 'novideo' ? '无画面'
                  : diag.client.cam === 'error' ? '不可用'
                  : '未启动'] : null,
              diag.client && diag.client.ms != null ? ['耗时', `${diag.client.ms}ms`] : null,
              diag.heartbeatAgeSeconds != null ? ['心跳', `${diag.heartbeatAgeSeconds}s`] : null,
              diag.identity && diag.identity.enabled
                ? ['本人', diag.identity.score == null ? '—'
                    : `${diag.identity.score.toFixed(2)}${diag.identity.matched ? ' ✓' : ' ✗'}`]
                : null,
              // Which descriptor family is ACTUALLY deciding identity right
              // now (activeDim), not merely what is stored.
              diag.identity && diag.identity.enabled
                ? ['识别', diag.identity.activeDim === 128
                    ? `CNN ${diag.identity.refsV2}组`
                    : diag.identity.activeDim === 400 ? `旧版 ${diag.identity.refsV1}组`
                    : `待机 ${diag.identity.refsV2 || 0}组`]
                : null,
              diag.client && diag.client.emb
                ? ['模型', diag.client.emb === 'ok'
                    ? `已启用${diag.client.backend ? ' · ' + diag.client.backend : ''}`
                    : diag.client.emb === 'slow' ? '设备算力不足，已跳过'
                    : '加载失败']
                : null,
              diag.client && diag.client.embMs != null ? ['识别耗时', `${diag.client.embMs}ms`] : null,
              diag.fallbackActive ? ['模式', '无摄像头·键鼠节能'] : diag.noCam ? ['摄像头', '未检测到设备'] : null,
              ['键鼠空闲', diag.inputIdleSeconds == null ? '—' : `${diag.inputIdleSeconds}s`],
              diag.screen && diag.screen.isBlack ? ['黑屏', `${Math.round((diag.blackForMs || 0) / 100) / 10}s`] : null,
              diag.lastReason ? ['原因', diag.lastReason] : null,
            ].filter(Boolean).map(([k, v], i) => h('span', {
              key: i,
              style: {
                padding: '3px 9px', borderRadius: 999, fontSize: 11,
                color: T.text2, background: T.bgLayer2, border: `1px solid ${T.borderL1}`,
              }
            }, `${k} · ${v}`))
          ) : null
        ),

        // ── Timeouts ──
        h('div', { style: s.section },
          h('div', { style: s.sectionTitle },
            h('span', null, '⏱️'), h('span', null, '时间参数')
          ),
          h('div', { style: s.row },
            h('span', { style: s.label }, '人脸丢失'),
            h('input', {
              type: 'number', value: config.faceGraceMs || 550,
              onChange: e => upd('faceGraceMs', Math.min(Math.max(parseInt(e.target.value) || 550, 400), 3000)),
              min: 400, max: 3000, step: 50, style: s.inputSmall,
            }),
            h('span', { style: { fontSize: 12, color: T.text2 } }, '毫秒看不到人脸就视为中断')
          ),
          h('div', { style: s.row },
            h('span', { style: s.label }, '离场确认'),
            h('input', {
              type: 'number', value: config.awayDelayMs || 400,
              onChange: e => upd('awayDelayMs', Math.min(Math.max(parseInt(e.target.value) || 400, 300), 5000)),
              min: 300, max: 5000, step: 50, style: s.inputSmall,
            }),
            h('span', { style: { fontSize: 12, color: T.text2 } }, '毫秒持续无人即熄屏（调大可防抖动）')
          ),
          h('div', { style: { ...s.row, marginBottom: 0 } },
            h('span', { style: s.label }, '亮屏确认'),
            h('input', {
              type: 'number', value: config.wakeHoldMs || 250,
              onChange: e => upd('wakeHoldMs', Math.min(Math.max(parseInt(e.target.value) || 250, 100), 3000)),
              min: 100, max: 3000, step: 50, style: s.inputSmall,
            }),
            h('span', { style: { fontSize: 12, color: T.text2 } }, '毫秒持续识别到本人才亮屏')
          ),
          h('div', { style: { ...s.row, marginBottom: 0 } },
            h('span', { style: s.label }, '无摄像头熄屏'),
            h('input', {
              type: 'number',
              value: Math.max(1, Math.round((config.noCamIdleSec || 300) / 60)),
              onChange: e => upd('noCamIdleSec', Math.min(Math.max((parseInt(e.target.value) || 5) * 60, 10), 3600)),
              min: 1, max: 60, step: 1, style: s.inputSmall,
            }),
            h('span', { style: { fontSize: 12, color: T.text2 } }, '分钟键鼠空闲后熄屏（仅键鼠节能模式生效）')
          )
        ),

        // ── User management ──
        h('div', { style: s.section },
          h('div', { style: { ...s.sectionTitle, justifyContent: 'space-between' } },
            h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', null, '👥'), h('span', null, `用户管理 (${users.length})`)),
            h('button', { onClick: () => setShowAddUser(!showAddUser), style: s.btnPrimary },
              showAddUser ? '取消' : '+ 添加用户')
          ),

          showAddUser ? h('div', { style: { ...s.card, borderColor: T.accent } },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('input', { placeholder: '用户 ID，如 zhangsan', value: newUserId, onChange: e => setNewUserId(e.target.value), style: s.input }),
              h('input', { placeholder: '姓名，如 张三', value: newUserName, onChange: e => setNewUserName(e.target.value), style: s.input }),
              h('button', { onClick: addNewUser, style: { ...s.btnPrimary, width: '100%' } }, '确认添加')
            )
          ) : null,

          users.length === 0
            ? h('div', { style: { textAlign: 'center', padding: 24, color: T.text3, fontSize: 13 } },
                '暂无用户，点击上方"添加用户"开始')
            : users.map(user => {
                const regBadge = (has, label) => has
                  ? h('span', {
                      style: { ...s.badge, ...s.badgeOk, fontSize: 10 },
                    }, `✓ ${label}`)
                  : h('span', {
                      style: { ...s.badge, background: T.bgLayer2, color: T.text3, fontSize: 10 },
                    }, `未录入 ${label}`);

                return h('div', { key: user.user_id, style: s.card },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } },
                    h('div', {
                      style: {
                        width: 32, height: 32, borderRadius: 16,
                        background: T.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 14, fontWeight: 600, color: T.accent, flex: '0 0 32px',
                      },
                    }, (user.name || user.user_id).slice(0, 1).toUpperCase()),
                    h('div', { style: { flex: 1 } },
                      h('div', { style: { fontSize: 14, fontWeight: 600, color: T.text } }, user.name || user.user_id),
                      h('div', { style: { fontSize: 11, color: T.text3, fontFamily: 'monospace' } }, user.user_id)),
                    regBadge(user.has_face, '人脸')
                  ),

                  // Face: camera capture (primary) + file path (fallback)
                  h('div', { style: { ...s.row, marginBottom: 0 } },
                    h('span', { style: { width: 60, flex: '0 0 60px', fontSize: 12, color: T.text2, display: 'flex', alignItems: 'center', gap: 4 } },
                      h('span', null, '👤'), '人脸'),
                    h('button', {
                      onClick: () => online ? setCapture({ user, type: 'face' }) : showMsg('error', '后端离线，请先启动服务'),
                      style: { ...s.btnSmall, opacity: online ? 1 : 0.4, cursor: online ? 'pointer' : 'not-allowed', flex: '0 0 112px', width: 112, textAlign: 'center' },
                    }, user.has_face ? '📷 重新采集' : '📷 摄像头采集'),
                    h('input', { id: `bio-face-${user.user_id}`, placeholder: '或输入图片路径', style: { ...s.input, fontSize: 12 } }),
                    h('button', {
                      onClick: () => registerFromPath(user.user_id, 'face', document.getElementById(`bio-face-${user.user_id}`)?.value || ''),
                      style: { ...s.btnSecondary, flex: '0 0 72px', width: 72, textAlign: 'center' },
                    }, '路径录入')
                  ),

                  // Inline capture panel for this user
                  capture && capture.user.user_id === user.user_id
                    ? h(CapturePanel, {
                        key: `cap-${capture.type}`,
                        type: capture.type,
                        user,
                        onDone: onCaptureDone,
                      })
                    : null
                );
              })
          ),

        // ── Message ──
        msg ? h('div', { style: { ...s.msg, ...(msg.type === 'success' ? s.msgOk : s.msgErr) } },
          msg.type === 'success' ? '✓ ' : '✕ ', msg.text) : null,

        // ── Save ──
        h('button', {
          onClick: saveConfig,
          disabled: saving || !online,
          style: {
            ...s.btnPrimary, width: '100%', padding: '12px 20px', fontSize: 15,
            opacity: (saving || !online) ? 0.45 : 1,
            cursor: (saving || !online) ? 'not-allowed' : 'pointer',
          },
        }, saving ? '保存中…' : online ? '💾 保存配置' : '后端离线，无法保存')
      );
    }

    // ─── Status Panel (composer dock) with backoff polling ───────────────
    function StatusPanel() {
      const [status, setStatus] = React.useState({ online: null, enabled: false, state: 'unknown', isBlack: false });
      const pollRef = React.useRef(0);

      React.useEffect(() => {
        let disposed = false;
        let backoff = 500;
        const tick = async () => {
          try {
            const d = await fetchJson(`${BACKEND_URL}/presence`, {}, 3000);
            const online = d.status === 'active' || d.status === 'inactive';
            setStatus({
              online,
              enabled: online && d.status === 'active',
              state: d.state || 'unknown',
              isBlack: d.screen?.isBlack,
              hbAge: d.heartbeatAgeSeconds,
              armed: d.armed,
              bioOnly: d.bioOnly !== false,
              client: d.client || null,
            });
            // 500ms refresh: this is a loopback JSON call measured in
            // microseconds, and it is the only thing that makes the pill react
            // at the same speed the engine does.
            if (online) backoff = 500;
          } catch {
            // Cap the retry at 3s: this is a loopback call, and after a
            // backend restart the pill (and the camera) must come back
            // quickly instead of waiting out a 15s backoff.
            backoff = Math.min(backoff * 2, 3000);
            setStatus(p => ({ ...p, online: false }));
          }
          if (!disposed) pollRef.current = window.setTimeout(tick, backoff);
        };
        tick();
        return () => { disposed = true; clearTimeout(pollRef.current); };
      }, []);

      React.useEffect(() => {
        // 300ms cadence: the camera MUST sample faster than the backend's
        // face-loss tolerance, otherwise "user left" is detected late and
        // feels slower than "user came back".
        const shouldRun = !!(status.online && status.enabled);
        if (!shouldRun) return undefined;
        const token = HeartbeatMgr.acquire(300);
        return () => HeartbeatMgr.release(token);
      }, [status.online, status.enabled]);

      // 状态栏已按要求彻底隐藏：输入框下方不再出现「用户在场 / 用户离开 /
      // 心跳中断 / 摄像头不可用」等任何提示。
      //
      // 注意：这个组件同时是 300ms 心跳的持有者（上面的 effect 里
      // HeartbeatMgr.acquire）。所以不能直接取消槽位注册，否则人脸采样会
      // 整个停掉 —— 只把渲染结果置空即可，检测与熄屏逻辑完全不受影响。
      // 需要看状态时，设置页里的诊断胶囊仍然完整。
      return null;
    }

    // ─── Slot Registration ──────────────────────────────────────────────────
    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        realCtx = ctx;
        const renderConfig = () => h(BioRecognizeConfig, null);

        // New protocol: ctx.slots.inject(name, cb) -> ctx.slots.register(...)
        if (ctx.slots && ctx.slots.inject) {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'bio-recognize',
            order: 50,
            label: '智能熄屏',
          }, renderConfig));

          ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config',
            key: '@local/bio-recognize',
          }, renderConfig));

          ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'bio-recognize-status',
            order: 10,
          }, StatusPanel));
          return;
        }

        // Old DSH V0.2.x fallback: register slots directly (no .inject indirection).
        // Guard every call so a missing host API degrades gracefully instead of
        // throwing and blanking the settings page.
        const safe = (fn, label) => {
          try { fn(); } catch (e) {
            console.warn('[bio-recognize] slot registration skipped (' + label + '):', e);
          }
        };
        const slots = ctx.slots;
        if (slots && slots.register) {
          safe(() => slots.register({
            name: 'settings.section',
            id: 'bio-recognize',
            order: 50,
            label: '智能熄屏',
          }, renderConfig), 'settings.section');

          safe(() => slots.register({
            name: 'plugins.bundle.config',
            key: '@local/bio-recognize',
          }, renderConfig), 'plugins.bundle.config');

          safe(() => slots.register({
            name: 'conversation.composer.dock',
            id: 'bio-recognize-status',
            order: 10,
          }, StatusPanel), 'conversation.composer.dock');
        }
      }
    };
  };

  // ── New DSH: __ModuleLoader__ (async factory with require) ──
  if (typeof window !== 'undefined' && window.__ModuleLoader__ && window.__ModuleLoader__.load) {
    window.__ModuleLoader__.load({
      id: '@local/bio-recognize',
      factory: (require) => mod(require),
    });
  } else if (typeof module !== 'undefined' && module.exports) {
    // ── Old DSH V0.2.x: CommonJS module export ──
    // require('react') is provided by the host's module system at load time.
    module.exports = {
      inject: ['slots', 'connection'],
      apply(ctx) {
        // Old host resolves 'react' through its own registry; bind lazily.
        const r = (typeof require === 'function') ? require('react') : (window.React || null);
        if (!r) {
          console.error('[bio-recognize] React unavailable in old-DSH client context; skipping UI registration.');
          return;
        }
        // Re-run the module factory with a require that returns the host React.
        const boundRequire = (name) => (name === 'react' ? r : ((typeof require === 'function') ? require(name) : null));
        const modOut = mod(boundRequire);
        modOut.apply(ctx);
      },
    };
  } else {
    console.warn('[bio-recognize] No known client module protocol detected (__ModuleLoader__ or module.exports both absent).');
  }
})();
