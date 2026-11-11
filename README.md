# BioRecognize - 多模态生物识别智能锁屏（DSH 插件）

为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 编写的插件：通过人脸、声音、瞳孔多模态生物识别判断用户是否在场，离开时自动黑屏或 Windows 锁屏，返回时自动解锁。

## 特性

- **三模态录入**（每个模态每人 1 份，后录覆盖前录）
  - 人脸 / 瞳孔：摄像头实时采集（`getUserMedia`）或本地图片路径
  - 声音：话筒 3 秒录音（16kHz WAV）或本地 WAV 路径
- **智能锁屏**：离开阈值内无人 → 黑屏 或 Windows 锁屏（可配置）
- **自动解锁**：锁屏模式下用户返回时自动输入密码解锁
- **服务自管理**：DSH 激活插件时自动拉起后端；设置页可启停
- **设置页**：DSH 用户菜单 → 设置 → 生物识别（与 IM 机器人同级）

## 安装

```bash
# 前置：Node.js >= 18
cd bio-recognize-plugin
npm install           # 无外部依赖，仅校验 manifest
```

在 DSH 中安装（二选一）：

```powershell
# 方式 1：本地目录安装（推荐开发时用）
# 在 DSH 中：插件管理 → 安装 → 选择本目录

# 方式 2：npm 安装（发布后）
# 在 DSH 中：插件管理 → 安装 → @local/bio-recognize
```

## 使用

1. 打开 DSH **设置 → 生物识别**
2. 点「▶ 启动服务」（插件激活时通常已自动启动）
3. 添加用户 → 用「📷 摄像头采集」/「🎙 话筒录音」录入生物特征（无摄像头时用路径录入）
4. 配置「离开后动作」（黑屏 / 锁屏）与时间参数
5. 「💾 保存配置」并启用检测

Agent 侧工具（聊天中直接让 AI 调用）：

| 工具 | 说明 |
|------|------|
| `biometric_service_control` | 启动 / 停止 / 查询后端服务 |
| `biometric_register_face(_photo)` / `biometric_register_pupil(_photo)` | 路径或 base64 录入人脸/瞳孔 |
| `biometric_register_voice(_audio)` | 路径或 base64 录入声音 |
| `biometric_face_detect` / `biometric_voice_recognize` / `biometric_pupil_detect` | 单模态检测 |
| `biometric_screen_control` | 亮屏 / 黑屏 / 锁屏 / 解锁 |
| `biometric_set_config` / `biometric_get_config` | 读写配置 |
| `biometric_presence_status` | 在场状态 |
| `biometric_manage_users` | 用户增删查 |
| `biometric_combine` | 多模态融合识别 |

## 架构

```
bio-recognize-plugin/
├── index.js          # Host 插件：Agent 工具 + /api/bio-recognize RPC + 服务进程管理
├── client.js         # 浏览器 UI：设置页（settings.section）、采集面板、composer 状态条
├── server.js         # Node 后端（127.0.0.1:8765）：HTTP API + 在场检测循环 + 屏幕控制
├── cordis.patch.yml  # DSH 插件清单补丁
├── locale/{en,zh}.json
├── icon/biometric.svg
└── models/           # 运行时数据（已 gitignore）：users.json / config.json / captures/
```

- **Client ↔ Host**：浏览器 UI 通过 DSH `/api` RPC 载体调用 Host 方法（`start`/`stop`/`status`），Host 用 `child_process` 管理 `server.js` 进程（detached + PID 文件，跨 DSH 重启可管理）。
- **设备采集**：摄像头帧 → JPEG base64；话筒 PCM → 手动编码 16-bit WAV → base64；后端解码存 `models/captures/` 后走统一的特征提取管线（光谱 / 暗圆分析）。

## 稳定性约定

两条不变量，坏掉时用户看到的现象都是「人脸移开没反应」：

1. **浏览器心跳必须活着。** 心跳跑在 Web Worker 时钟上（隐藏页不被节流），Worker 另外每 2s 发一个看门狗消息：若 3s 内没有成功上报，就重建时钟并立刻补一拍；若某次上报卡在 in-flight 超过 6s，直接释放（最坏是多一拍，服务端本来就去重）。`_send()` 整体包在 try/finally 里 —— 之前摄像头检查在 try 之外，那里抛一次异常就会让 `inFlight` 永久为真，之后每一拍都在入口 return，页面看着正常、服务端却以为客户端死了。
2. **后端必须跑当前代码。** `ensureServer` 除了比对 PID 文件与端口占用者，还会比较进程启动时间与 `server.js` 的 mtime：进程比代码旧就替换。之前 PID 文件与端口对得上就「已在运行」直接收养，于是重启 DSH 后后端仍是改动前的进程。

排查入口：`GET /presence` 的 `client` 字段有 `clock`（worker/timer）、`tok`（持有者数量）、`vis`、`rj`（页面未捕获 Promise 异常计数）。`clock` 在而心跳断 → 页面被别的东西拖住；`tok=0` → 没人持有检测。

## 安全注意

- `models/config.json` 中的锁屏密码**明文存储**，请保护好该目录权限
- 自动解锁通过 PowerShell 模拟键盘输入密码，仅适用于本机可信环境
- 建议仅在内网/本机部署

## 许可证

MIT
