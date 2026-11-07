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

    // ─── Theme (real DSW alias tokens; light & dark safe) ─────────────────
    const T = {
      bgLayer1: 'var(--dsw-alias-bg-layer-1)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2)',
      borderL1: 'var(--dsw-alias-border-l1)',
      borderL2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      text3: 'var(--dsw-alias-label-tertiary)',
      accent: 'var(--dsw-alias-brand-primary)',
      accentSoft: 'var(--dsw-alias-brand-primary-soft)',
      input: 'var(--dsw-specific-input-major)',
      success: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    };
    const FONT = 'var(--dsw-font-family, system-ui, sans-serif)';

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
      badgeOk: { background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 15%, transparent)', color: T.success },
      badgeErr: { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent)', color: T.error },
      msgOk: { background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)', color: T.success, border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent)' },
      msgErr: { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)', color: T.error, border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)' },
      warnNote: { fontSize: 12, color: T.text2, margin: '8px 0 0 0', lineHeight: 1.5 },
      video: { width: '100%', maxWidth: 360, borderRadius: 8, background: '#000', display: 'block' },
    };

    // ─── Utilities ────────────────────────────────────────────────────────
    function arrayBufferToBase64(buf) {
      const bytes = new Uint8Array(buf);
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    }
    function encodeWav(int16, sampleRate) {
      const buf = new ArrayBuffer(44 + int16.length * 2);
      const dv = new DataView(buf);
      const ws = (o, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
      ws(0, 'RIFF'); dv.setUint32(4, 36 + int16.length * 2, true); ws(8, 'WAVE');
      ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
      dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      ws(36, 'data'); dv.setUint32(40, int16.length * 2, true);
      for (let i = 0; i < int16.length; i++) dv.setInt16(44 + i * 2, int16[i], true);
      return buf;
    }
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

    // ─── Capture Panel (inline; camera preview / voice recording) ───────
    // Rendered inside the user card (no fixed overlay → not clipped by the
    // DSH settings host container's stacking context).
    function CapturePanel({ type, user, onDone }) {
      const videoRef = React.useRef(null);
      const streamRef = React.useRef(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [ready, setReady] = React.useState(false);
      const [recState, setRecState] = React.useState(null);
      const [recCount, setRecCount] = React.useState(0);

      const isImage = type === 'face' || type === 'pupil';
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
        if (isImage && mediaOk) {
          navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
            .then(stream => {
              if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
              streamRef.current = stream;
              if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.play().catch(() => {});
                setReady(true);
              }
            })
            .catch(e => { if (!cancelled) setError(mediaErrorText(e)); });
        }
        return () => {
          cancelled = true;
          if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
        };
      }, [isImage]);

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
          const ep = type === 'face' ? '/register/face' : '/register/pupil';
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

      const startRecording = async () => {
        setBusy(true);
        try {
          setRecCount(3);
          setRecState({ label: '准备中…' });
          const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          let actx, sampleRate;
          try {
            actx = new AudioContext({ sampleRate: 16000 });
            sampleRate = actx.sampleRate;
          } catch {
            actx = new AudioContext();
            sampleRate = actx.sampleRate;
          }
          await actx.resume();
          const src = actx.createMediaStreamSource(stream);
          const proc = actx.createScriptProcessor(2048, 1, 1);
          const silence = actx.createGain();
          silence.gain.value = 0;
          src.connect(proc); proc.connect(silence); silence.connect(actx.destination);
          const frames = [];
          proc.onaudioprocess = e => {
            const data = e.inputBuffer.getChannelData(0);
            const tmp = new Int16Array(data.length);
            for (let i = 0; i < data.length; i++) {
              const v = Math.max(-1, Math.min(1, data[i]));
              tmp[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
            }
            frames.push(tmp);
          };
          for (let n = 3; n >= 1; n--) {
            setRecCount(n);
            setRecState({ label: `正在录音 ${n}…` });
            await new Promise(r => setTimeout(r, 1000));
          }
          const total = frames.reduce((a, f) => a + f.length, 0);
          const all = new Int16Array(total);
          let off = 0;
          for (const f of frames) { all.set(f, off); off += f.length; }
          proc.disconnect(); src.disconnect(); silence.disconnect();
          stream.getTracks().forEach(t => t.stop());
          await actx.close();
          if (total < sampleRate) throw new Error('录音数据不足，请靠近话筒重试');
          const wavBuf = encodeWav(all, sampleRate);
          const audio_b64 = arrayBufferToBase64(wavBuf);
          setRecState({ label: '上传中…' });
          const data = await fetchJson(`${BACKEND_URL}/register/voice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: user.user_id, audio_b64 }),
          }, 20000);
          onDone(data);
        } catch (e) {
          setRecState(null);
          const name = e?.name || '';
          let text;
          if (name === 'NotFoundError' || name === 'OverconstrainedError') {
            text = '未找到麦克风设备。请连接麦克风后重试，或改用"路径录入"。';
          } else if (name === 'NotAllowedError' || name === 'SecurityError') {
            text = '浏览器拒绝访问麦克风。请允许本页面的麦克风权限后重试。';
          } else if (name === 'NotReadableError') {
            text = '麦克风被其他程序占用。请关闭占用麦克风的程序后重试。';
          } else {
            text = `录音失败：${e?.message || name}`;
          }
          setError(text);
        } finally {
          setBusy(false);
        }
      };

      const title = type === 'face' ? '📷 摄像头采集人脸' : type === 'pupil' ? '📷 摄像头采集瞳孔' : '🎤 话筒录音声音';

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
              '✕ 当前浏览器不支持摄像头/话筒 API（navigator.mediaDevices 不可用）。请使用"路径录入"方式。'),
        isImage && mediaOk
          ? h('div', null,
              h('video', { ref: videoRef, autoPlay: true, muted: true, playsInline: true, style: s.video }),
              h('p', { style: { fontSize: 12, color: T.text2, margin: '8px 0 0 0', lineHeight: 1.5 } },
                type === 'face' ? '请正对摄像头，保证面部清晰、光线均匀。' : '请将眼睛靠近摄像头，尽量拍到双眼和瞳孔区域。'),
              ready
                ? h('button', {
                    onClick: captureAndRegister, disabled: busy,
                    style: { ...s.btnPrimary, width: '100%', marginTop: 10, padding: '10px 16px', opacity: busy ? 0.5 : 1 },
                  }, busy ? '处理中…' : '✓ 采集并录入')
                : h('div', { style: { marginTop: 10, textAlign: 'center', color: T.text3, fontSize: 13 } }, '摄像头启动中…'),
            )
          : null,
        (!isImage) && mediaOk
          ? h('div', null,
              h('div', {
                style: {
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                  padding: '20px 16px', background: T.bgLayer2, borderRadius: 8,
                  border: `1px solid ${T.borderL1}`, fontSize: 14, color: T.text2,
                },
              },
                recState
                  ? h('span', { style: { color: T.accent, fontWeight: 600 } }, `🎙 ${recState.label}`)
                  : h('span', null, '点击下方按钮开始录音（共 3 秒）'),
              ),
              recState && recCount > 0
                ? h('div', { style: { textAlign: 'center', fontSize: 24, fontWeight: 700, color: T.accent, margin: '8px 0' } }, String(recCount))
                : null,
              !recState
                ? h('button', {
                    onClick: startRecording, disabled: busy,
                    style: { ...s.btnPrimary, width: '100%', marginTop: 10, padding: '10px 16px', opacity: busy ? 0.5 : 1 },
                  }, '● 开始录音（3 秒）')
                : null,
            )
          : null,
        error ? h('div', { style: { ...s.msg, ...s.msgErr, marginTop: 10, marginBottom: 0 } }, `✕ ${error}`) : null
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

      const upd = (k, v) => setConfig(p => ({ ...p, [k]: v }));
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
        if (res?.ok === false) {
          const diag = res.result?._diag ? ` [Host 诊断: 收到 method=${res.result._diag.receivedMethod ?? '无'}]` : '';
          showMsg('error', `停止失败：${res.error?.message || '未知原因'}${diag}`);
        } else if (res?.ok) {
          showMsg('success', '停止信号已发送');
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
          const labels = { face: '人脸', voice: '声音', pupil: '瞳孔' };
          showMsg('error', `请输入${labels[type]}文件路径`); return;
        }
        const ep = type === 'face' ? '/register/face' : type === 'voice' ? '/register/voice' : '/register/pupil';
        const body = type === 'voice' ? { user_id: userId, audio_path: path } : { user_id: userId, image_path: path };
        try {
          const data = await fetchJson(`${BACKEND_URL}${ep}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }, 15000);
          const labels = { face: '人脸', voice: '声音', pupil: '瞳孔' };
          if (data.status === 'success') showMsg('success', `${labels[type]}录入成功`);
          else showMsg('error', data.message || '录入失败');
        } catch { showMsg('error', '网络错误，请确认后端已启动'); }
      };

      const onCaptureDone = (data) => {
        const labels = { face: '人脸', voice: '声音', pupil: '瞳孔' };
        const cap = capture;
        setCapture(null);
        if (data && data.status === 'success') {
          showMsg('success', `${labels[cap?.type] || '生物特征'}录入成功`);
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

      if (!dataReady) {
        return h('div', { style: { padding: 48, textAlign: 'center', color: T.text2, fontFamily: FONT } }, '加载中…');
      }

      const online = service.running === true;

      return h('div', { style: s.page },
        // ── Header ──
        h('div', { style: s.header },
          h('span', { style: { fontSize: 32 } }, '🔐'),
          h('div', null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h('h1', { style: s.h1 }, '生物识别'),
              h('span', { style: { ...s.badge, ...(online ? s.badgeOk : s.badgeErr) } },
                online ? '● 在线' : '● 离线'),
            ),
            h('p', { style: s.subtitle }, '智能锁屏 · 多模态生物特征管理')
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
              online
                ? h('button', { onClick: stopService, disabled: service.busy, style: { ...s.btnSecondary, borderColor: T.error, color: T.error } },
                    service.busy ? '停止中…' : '⏹ 停止服务')
                : h('button', { onClick: startService, disabled: service.busy, style: s.btnPrimary },
                    service.busy ? '启动中…' : '▶ 启动服务'),
              h(Toggle, { checked: !!online, onChange: v => v ? startService() : stopService() })
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
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 } },
            [
              { key: 'faceEnabled', icon: '👤', title: '人脸', desc: '摄像头实时识别' },
              { key: 'voiceEnabled', icon: '🎤', title: '声音', desc: '声纹匹配' },
              { key: 'pupilEnabled', icon: '👁', title: '瞳孔', desc: '眼部特征分析' },
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
          h('div', { style: s.groupLabel }, '用户离开后动作'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
            [
              { val: 'black', icon: '🌑', title: '黑屏模式', desc: '仅关闭显示器，用户回来后自动亮起' },
              { val: 'lock', icon: '🔒', title: '锁屏模式', desc: 'Windows 锁屏，配置密码后可自动解锁' },
            ].map(opt => {
              const active = (config.lockMode || 'black') === opt.val;
              return h('label', {
                key: opt.val,
                style: { ...s.modalityCard, cursor: 'pointer', borderColor: active ? T.accent : T.borderL1 },
              },
                h('input', {
                  type: 'radio', name: 'lock-mode', checked: active,
                  onChange: () => upd('lockMode', opt.val),
                  style: { position: 'absolute', opacity: 0, pointerEvents: 'none' },
                }),
                h('span', { style: { fontSize: 16 } }, opt.icon),
                h('div', { style: { flex: 1 } },
                  h('div', { style: { fontSize: 13, fontWeight: active ? 600 : 500, color: T.text } }, opt.title),
                  h('div', { style: { fontSize: 11, color: T.text2, marginTop: 2, lineHeight: 1.4 } }, opt.desc)
                ),
                active ? h('span', { style: { fontSize: 14, color: T.accent, fontWeight: 700 } }, '✓') : null
              );
            })
          )
        ),

        // ── Lock password (lock mode only) ──
        (config.lockMode === 'lock') ? h('div', { style: s.section },
          h('div', { style: s.sectionTitle },
            h('span', null, '🔑'), h('span', null, '自动解锁密码')
          ),
          h('div', { style: s.row },
            h('span', { style: s.label }, '锁屏密码'),
            h('input', {
              type: 'password',
              value: config.lockPassword || '',
              onChange: e => upd('lockPassword', e.target.value),
              placeholder: '输入 Windows 登录密码…',
              style: { ...s.input, fontFamily: 'monospace', fontSize: 14, letterSpacing: 2 },
            }),
            h('button', { onClick: () => upd('lockPassword', ''), style: s.btnSecondary }, '清空')
          ),
          h('p', { style: s.warnNote },
            '⚠️ 用户返回时插件会自动模拟键盘输入此密码解锁锁屏。密码明文存储于配置文件，请注意权限安全。')
        ) : null,

        // ── Timeouts ──
        h('div', { style: s.section },
          h('div', { style: s.sectionTitle },
            h('span', null, '⏱️'), h('span', null, '时间参数')
          ),
          h('div', { style: s.row },
            h('span', { style: s.label }, '离开等待'),
            h('input', {
              type: 'number', value: config.absentThreshold || 30,
              onChange: e => upd('absentThreshold', parseInt(e.target.value) || 30),
              min: 10, max: 300, style: s.inputSmall,
            }),
            h('span', { style: { fontSize: 12, color: T.text2 } }, '秒后执行离开动作')
          ),
          h('div', { style: { ...s.row, marginBottom: 0 } },
            h('span', { style: s.label }, '检测间隔'),
            h('input', {
              type: 'number', value: config.detectionInterval || 5000,
              onChange: e => upd('detectionInterval', parseInt(e.target.value) || 5000),
              min: 1000, max: 30000, step: 1000, style: s.inputSmall,
            }),
            h('span', { style: { fontSize: 12, color: T.text2 } }, '毫秒检测一次')
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
                      width: 32, height: 32, borderRadius: 16,
                      background: T.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14, fontWeight: 600, color: T.accent, flex: '0 0 32px',
                    }, (user.name || user.user_id).slice(0, 1).toUpperCase()),
                    h('div', { style: { flex: 1 } },
                      h('div', { style: { fontSize: 14, fontWeight: 600, color: T.text } }, user.name || user.user_id),
                      h('div', { style: { fontSize: 11, color: T.text3, fontFamily: 'monospace' } }, user.user_id)),
                    regBadge(user.has_face, '人脸'),
                    regBadge(user.has_voice, '声音'),
                    regBadge(user.has_pupil, '瞳孔')
                  ),

                  // Face: camera capture (primary) + file path (fallback)
                  h('div', { style: s.row },
                    h('span', { style: { width: 60, flex: '0 0 60px', fontSize: 12, color: T.text2, display: 'flex', alignItems: 'center', gap: 4 } },
                      h('span', null, '👤'), '人脸'),
                    h('button', {
                      onClick: () => online ? setCapture({ user, type: 'face' }) : showMsg('error', '后端离线，请先启动服务'),
                      style: { ...s.btnSmall, opacity: online ? 1 : 0.4, cursor: online ? 'pointer' : 'not-allowed' },
                    }, user.has_face ? '📷 重新采集' : '📷 摄像头采集'),
                    h('input', { id: `bio-face-${user.user_id}`, placeholder: '或输入图片路径', style: { ...s.input, fontSize: 12 } }),
                    h('button', {
                      onClick: () => registerFromPath(user.user_id, 'face', document.getElementById(`bio-face-${user.user_id}`)?.value || ''),
                      style: s.btnSecondary,
                    }, '路径录入')
                  ),

                  // Voice: microphone recording (primary) + file path (fallback)
                  h('div', { style: s.row },
                    h('span', { style: { width: 60, flex: '0 0 60px', fontSize: 12, color: T.text2, display: 'flex', alignItems: 'center', gap: 4 } },
                      h('span', null, '🎤'), '声音'),
                    h('button', {
                      onClick: () => online ? setCapture({ user, type: 'voice' }) : showMsg('error', '后端离线，请先启动服务'),
                      style: { ...s.btnSmall, opacity: online ? 1 : 0.4, cursor: online ? 'pointer' : 'not-allowed' },
                    }, user.has_voice ? '🎙 重新录音' : '🎙 话筒录音'),
                    h('input', { id: `bio-voice-${user.user_id}`, placeholder: '或输入 WAV 路径', style: { ...s.input, fontSize: 12 } }),
                    h('button', {
                      onClick: () => registerFromPath(user.user_id, 'voice', document.getElementById(`bio-voice-${user.user_id}`)?.value || ''),
                      style: s.btnSecondary,
                    }, '路径录入')
                  ),

                  // Pupil: camera capture (primary) + file path (fallback)
                  h('div', { style: { ...s.row, marginBottom: 0 } },
                    h('span', { style: { width: 60, flex: '0 0 60px', fontSize: 12, color: T.text2, display: 'flex', alignItems: 'center', gap: 4 } },
                      h('span', null, '👁'), '瞳孔'),
                    h('button', {
                      onClick: () => online ? setCapture({ user, type: 'pupil' }) : showMsg('error', '后端离线，请先启动服务'),
                      style: { ...s.btnSmall, opacity: online ? 1 : 0.4, cursor: online ? 'pointer' : 'not-allowed' },
                    }, user.has_pupil ? '📷 重新采集' : '📷 摄像头采集'),
                    h('input', { id: `bio-pupil-${user.user_id}`, placeholder: '或输入眼部图片路径', style: { ...s.input, fontSize: 12 } }),
                    h('button', {
                      onClick: () => registerFromPath(user.user_id, 'pupil', document.getElementById(`bio-pupil-${user.user_id}`)?.value || ''),
                      style: s.btnSecondary,
                    }, '路径录入')
                  ),

                  // Inline capture panel (camera/mic) for this user
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
      const [status, setStatus] = React.useState({ online: null, enabled: false, state: 'unknown', isLocked: false, isBlack: false });
      const pollRef = React.useRef(0);

      React.useEffect(() => {
        let disposed = false;
        let backoff = 8000;
        const tick = async () => {
          try {
            const d = await fetchJson(`${BACKEND_URL}/presence`, {}, 3000);
            const online = d.status === 'active' || d.status === 'inactive';
            setStatus({
              online,
              enabled: online && d.status === 'active',
              state: d.state || 'unknown',
              isLocked: d.screen?.isLocked,
              isBlack: d.screen?.isBlack,
            });
            if (online) backoff = 8000;
          } catch {
            backoff = Math.min(backoff * 1.5, 60000);
            setStatus(p => ({ ...p, online: false }));
          }
          if (!disposed) pollRef.current = window.setTimeout(tick, backoff);
        };
        tick();
        return () => { disposed = true; clearTimeout(pollRef.current); };
      }, []);

      const icon = status.isLocked ? '🔒' : status.isBlack ? '🌑' : status.online ? '👁' : '⚪';
      const text = status.online === null ? '…'
        : !status.online ? '后端离线'
        : !status.enabled ? '检测未启用'
        : status.state === 'present' ? '用户在场'
        : status.state === 'absent' ? '用户离开' : '检测中';

      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 12px',
          background: T.bgLayer1,
          borderRadius: 8,
          border: `1px solid ${status.online ? T.borderL2 : T.borderL1}`,
          fontSize: 12, fontFamily: FONT,
          color: T.text,
          opacity: status.online ? 1 : 0.55,
          minWidth: 120,
        }
      },
        h('span', { style: { fontSize: 14 } }, icon),
        h('span', { style: { fontWeight: 500 } }, text),
        status.online && (status.isLocked || status.isBlack)
          ? h('span', {
              fontSize: 10,
              color: status.isLocked ? T.warn : T.text3,
              background: status.isLocked
                ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 15%, transparent)'
                : T.bgLayer2,
              padding: '1px 6px',
              borderRadius: 8,
            }, status.isLocked ? '已锁屏' : '黑屏')
          : null
      );
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
            label: '生物识别',
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
            label: '生物识别',
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
