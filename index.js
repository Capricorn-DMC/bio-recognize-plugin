/**
 * BioRecognize DSH Plugin - Multi-modal Biometric Recognition & Smart Lock Screen
 * 
 * Features:
 * - Face/Voice/Pupil registration (1 per modality, overwrite allowed)
 * - Real voice recognition (WAV spectral features)
 * - Real pupil detection (dark circle analysis)
 * - Smart screen control with auto-unlock via password
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { spawn } from 'child_process';
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
    // If a health check succeeds, the server is up (possibly a previously
    // started instance or one the user started manually).
    const alive = await new Promise(resolve => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: SERVER_PORT,
            path: '/health',
            method: 'GET',
            timeout: 1500,
        }, res => {
            res.resume();
            res.on('end', () => resolve(true));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
    if (alive) return { running: true, pid: null, message: 'Server already running' };

    if (serverProcess || serverStarting) {
        return { running: true, pid: serverProcess?.pid || null, message: 'Server starting or already managed' };
    }

    serverStarting = true;
    try {
        // Detached so the backend outlives a DSH restart; pid file for later stop.
        const pidFile = join(__dirname, 'models', '.server.pid');
        serverProcess = spawn(process.execPath, [SERVER_SCRIPT], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });
        serverProcess.stdout?.on('data', () => {});
        serverProcess.stderr?.on('data', () => {});
        serverProcess.on('exit', () => { serverProcess = null; serverStarting = false; });
        serverProcess.unref();
        serverStarting = false;
        // Give the server a moment to bind the port
        await new Promise(r => setTimeout(r, 1500));
        const up = await new Promise(resolve => {
            const req = http.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: '/health', method: 'GET', timeout: 2500 },
                res => { res.resume(); res.on('end', () => resolve(true)); });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
        if (serverProcess?.pid) {
            try {
                import('fs').then(fs => fs.writeFileSync(pidFile, String(serverProcess.pid)));
            } catch {}
        }
        return { running: up, pid: serverProcess?.pid || null, message: up ? 'Server started' : 'Server process launched but health check failed' };
    } finally {
        if (serverStarting) serverStarting = false;
    }
}

async function stopServer() {
    const pidFile = join(__dirname, 'models', '.server.pid');
    // Prefer the managed process; fall back to pid file (survives DSH restarts).
    let target = serverProcess;
    let pid = target?.pid;
    if (!target) {
        try {
            const fs = await import('fs');
            if (fs.existsSync(pidFile)) {
                pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
            }
        } catch {}
    }
    if (!pid) {
        return { running: await probeHealth(), message: 'No managed server process or pid file found; backend may be externally started' };
    }
    try {
        process.kill(pid, 'SIGTERM');
    } catch {}
    if (target) serverProcess = null;
    try {
        const fs = await import('fs');
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    } catch {}
    await new Promise(r => setTimeout(r, 500));
    return { running: await probeHealth(), message: 'Stop signal sent' };
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

        // Echo diagnostics so a client-side capture of this response shows
        // exactly what the Host received (endpoint + raw method field).
        const reply = (result) => Response.json({
          type: 'server-response',
          rpcId,
          result: {
            ...result,
            _diag: { receivedMethod: message?.method ?? null, endpoint: message?.endpoint ?? null, handled: method },
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
              return reply({ ok: r.running, result: r });
            }
            case 'stop': {
              const r = await stopServer();
              return reply({ ok: !r.running || r.message.includes('stopped'), result: r });
            }
            case 'status': {
              const alive = await probeHealth();
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
    ctx.effect?.(() => { /* registration handled by host */ });

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

  ctx.tools.register({
    name: 'biometric_register_voice',
    description: 'Register voice for a user. Max 1 voice sample per user - new registration overwrites previous. Requires WAV audio file (16kHz mono recommended).',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'User identifier' },
        audio_path: { type: 'string', description: 'Path to WAV audio file for voice registration' }
      },
      required: ['user_id', 'audio_path']
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, user_id: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      return await callBackend('/register/voice', { user_id: args.user_id, audio_path: args.audio_path }, pluginConfig);
    }
  });

  ctx.tools.register({
    name: 'biometric_register_pupil',
    description: 'Register pupil/eye data for a user. Max 1 pupil template per user - new registration overwrites previous. Captures eye position and gaze pattern.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'User identifier' },
        image_path: { type: 'string', description: 'Path to eye/face image for pupil registration' }
      },
      required: ['user_id', 'image_path']
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, user_id: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      return await callBackend('/register/pupil', { user_id: args.user_id, image_path: args.image_path }, pluginConfig);
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

  ctx.tools.register({
    name: 'biometric_voice_recognize',
    description: 'Recognize speaker from WAV audio file using spectral feature matching.',
    parameters: {
      type: 'object',
      properties: {
        audio_path: { type: 'string', description: 'Path to WAV audio file' },
        microphone: { type: 'boolean', description: 'Use microphone (not yet supported)', default: false },
        duration: { type: 'integer', description: 'Capture duration in seconds', default: 3 }
      }
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, transcription: { type: 'string' }, speaker_info: { type: 'object' } } }, render: renderJson },
    async execute(args) {
      return await callBackend('/voice/recognize', { audio_path: args.audio_path }, pluginConfig);
    }
  });

  ctx.tools.register({
    name: 'biometric_pupil_detect',
    description: 'Detect pupil position and estimate gaze direction from eye images.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Path to eye/face image' },
        camera_index: { type: 'integer', description: 'Camera index', default: 0 }
      }
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, eyes_detected: { type: 'integer' }, gaze_direction: { type: 'object' }, pupil_positions: { type: 'array' } } }, render: renderJson },
    async execute(args) {
      return await callBackend('/pupil/detect', { image_path: args.image_path }, pluginConfig);
    }
  });

  // ============================================================
  // Screen Control Tools
  // ============================================================

  ctx.tools.register({
    name: 'biometric_screen_control',
    description: 'Control screen state: on, off (black), lock, or unlock. When locked, can auto-unlock with configured password via keyboard simulation.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['on', 'off', 'lock', 'unlock', 'state'],
          description: 'Screen action: on=唤醒, off=黑屏, lock=锁屏, unlock=解锁, state=查询状态'
        },
        password: {
          type: 'string',
          description: 'Password for unlock (optional if configured in plugin settings)'
        }
      },
      required: ['action']
    },
    output: { schema: { type: 'object', properties: { success: { type: 'boolean' }, isLocked: { type: 'boolean' }, isBlack: { type: 'boolean' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      return await callBackend('/screen', { action: args.action, password: args.password }, pluginConfig);
    }
  });

  // ============================================================
  // Configuration Tools
  // ============================================================

  ctx.tools.register({
    name: 'biometric_set_config',
    description: 'Configure plugin settings: enable/disable detection, set lock mode, configure password for auto-unlock.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Enable presence detection' },
        faceEnabled: { type: 'boolean', description: 'Enable face detection' },
        voiceEnabled: { type: 'boolean', description: 'Enable voice detection' },
        pupilEnabled: { type: 'boolean', description: 'Enable pupil detection' },
        lockMode: { type: 'string', enum: ['black', 'lock'], description: 'Action when absent: black screen or lock screen' },
        lockPassword: { type: 'string', description: 'Windows password for auto-unlock when user returns' },
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
        audio_path: { type: 'string', description: 'Path to audio sample' },
        mode: { type: 'string', enum: ['verify', 'identify'], default: 'verify' },
        target_user: { type: 'string', description: 'Target user ID for verification' }
      }
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, mode: { type: 'string' }, combined_confidence: { type: 'number' }, identified_user: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      let faceResult = null;
      if (args.image_path) faceResult = await callBackend('/face/detect', { image_path: args.image_path }, pluginConfig);
      
      let voiceResult = null;
      if (args.audio_path) voiceResult = await callBackend('/voice/recognize', { audio_path: args.audio_path }, pluginConfig);
      
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
  // Base64 Capture Registration Tools (camera/microphone uploads)
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

  ctx.tools.register({
    name: 'biometric_register_pupil_photo',
    description: 'Register pupil/eye features from a base64 image (close-up of eyes). Overwrites any existing pupil registration for the user.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'User identifier' },
        image_b64: { type: 'string', description: 'Base64-encoded eye image' },
        mime: { type: 'string', description: 'MIME type hint' }
      },
      required: ['user_id', 'image_b64']
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, user_id: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      let b64 = String(args.image_b64 || '');
      const m = b64.match(/^data:[^;]+;base64,(.*)$/s);
      if (m) b64 = m[1];
      return await callBackend('/register/pupil', { user_id: args.user_id, image_b64: b64, mime: args.mime }, pluginConfig);
    }
  });

  ctx.tools.register({
    name: 'biometric_register_voice_audio',
    description: 'Register voice from a base64-encoded WAV audio capture (microphone). 16kHz mono is ideal. Overwrites any existing voice registration for the user.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'User identifier' },
        audio_b64: { type: 'string', description: 'Base64-encoded WAV audio data' }
      },
      required: ['user_id', 'audio_b64']
    },
    output: { schema: { type: 'object', properties: { status: { type: 'string' }, user_id: { type: 'string' }, message: { type: 'string' } } }, render: renderJson },
    async execute(args) {
      let b64 = String(args.audio_b64 || '');
      const m = b64.match(/^data:[^;]+;base64,(.*)$/s);
      if (m) b64 = m[1];
      return await callBackend('/register/voice', { user_id: args.user_id, audio_b64: b64 }, pluginConfig);
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
