# BioRecognize - 人脸识别智能黑屏（DSH 插件）

为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 编写的插件：通过摄像头人脸识别判断机主是否在场，离开时自动黑屏（背光调 0 + 全屏遮罩窗口），机主返回时自动亮屏。支持 1:N 人脸身份核验——只有已录入的用户才能唤醒屏幕。

## 特性

- **人脸录入**（每人 1 份照片，后录覆盖前录）
  - 摄像头实时采集（`getUserMedia`）或本地图片路径
  - 录入后浏览器用 face-api.js 计算 128 维 CNN 特征，自动迁移无需重新录入
- **身份核验（1:N）**：检测到人脸还不够，必须匹配已录入用户才计为在场；陌生人坐在屏幕前无法保持/唤醒屏幕
- **自动学习**：高置信度匹配会自动扩充参考集（新姿势/光照/眼镜），去重、限速、有上限
- **智能黑屏**：离开阈值内无人 → 背光调 0 + 全屏黑色遮罩窗口；返回 → 自动恢复
- **不碰 Windows 会话**：刻意不使用 SC_MONITORPOWER/锁屏——显示器断电事件会连带触发系统锁定；插件只调背光，亮屏后直接回到桌面，无密码
- **逃生口**：黑屏时按住 Shift 或 Esc 约 8 秒可强制亮屏（5 秒内无人脸核验则再次黑屏）；普通键鼠输入永远无法唤醒
- **无摄像头模式**（`noCamMode`）：本机无摄像头时退化为键鼠空闲省电（`noCamIdleSec`，默认 300s）
- **服务端人脸兜底**：页面被冻结/隐藏时，后端用 `ffmpeg`（DirectShow）接管摄像头跑同一个 pico 检测器，仅判在场
- **服务自管理**：DSH 激活插件时自动拉起后端；设置页可启停；僵尸进程/孤儿遮罩窗口自动清扫
- **设置页**：DSH 设置 → 智能息屏

## 安装

```bash
# 前置：Node.js >= 18；服务端人脸兜底需要 ffmpeg 在 PATH 中（可选）
git clone https://github.com/Capricorn-DMC/bio-recognize-plugin.git
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

1. 打开 DSH **设置 → 智能息屏**
2. 点「▶ 启动服务」（插件激活时通常已自动启动）
3. 「+ 添加用户」→ 用「📷 摄像头采集」录入人脸（无摄像头时用「路径录入」选本地图片）
4. 「启用检测」并「💾 保存配置」
5. 走开 → 无人脸约 1~3 秒后自动黑屏；回来坐好 → 约 1 秒内自动亮屏

Agent 侧工具（聊天中直接让 AI 调用）：

| 工具 | 说明 |
|------|------|
| `biometric_service_control` | 启动 / 停止 / 查询后端服务（127.0.0.1:8765） |
| `biometric_register_face` | 本地图片路径录入人脸 |
| `biometric_register_face_photo` | base64 图片录入人脸（相机采集上传） |
| `biometric_face_detect` | 图片人脸检测与识别 |
| `biometric_screen_control` | 亮屏 (`on`) / 黑屏 (`off`) / 查询状态 (`state`) |
| `biometric_set_config` / `biometric_get_config` | 读写配置 |
| `biometric_presence_status` | 在场状态 + 诊断（心跳/摄像头/身份核验详情） |
| `biometric_manage_users` | 用户增删查 |
| `biometric_combine` | 单图人脸核验 |

## 主要配置项（设置页可调）

| 配置 | 默认 | 说明 |
|------|------|------|
| `enabled` / `faceEnabled` | false | 启用检测 / 启用人脸信号 |
| `absentThreshold` | 1 | 键鼠空闲判定在场的秒数（bioOnly 下仅作"无在场"证据） |
| `awayDelayMs` | 350 | 持续无人多少毫秒后黑屏 |
| `blindAwaySec` | 10 | 页面失联（冻结/关闭）时按键鼠空闲黑屏的秒数 |
| `serverFace` / `serverFaceAwaySec` | true / 3 | 服务端 ffmpeg 兜底及其无人阈值 |
| `noCamMode` / `noCamIdleSec` | false / 300 | 无摄像头降级模式及空闲阈值 |
| `matchThresholdV2` | 0.93 | CNN 128 维余弦相似度阈值（机主≈0.975+，陌生人<0.92） |
| `matchThreshold` | 0.65 | 旧版 400 维 HOG 阈值（浏览器无法跑 CNN 时的兜底） |
| `learnFaces` | true | 高置信度自动扩充参考集 |
| `keyEscapeMs` / `escapeVerifyMs` | 8000 / 5000 | 按住 Shift/Esc 强制亮屏的时长及复核窗口 |
| `bioOnly` / `identityCheck` | true（强制） | 仅生物信号可唤醒屏幕 / 仅已录入用户算在场（已固化为默认行为） |

## 架构

```
bio-recognize-plugin/
├── index.js          # Host 插件：Agent 工具 + /api/bio-recognize RPC + 服务进程管理
├── client.js         # 浏览器 UI：设置页（settings.section）、摄像头采集面板、状态条
├── server.js         # Node 后端（127.0.0.1:8765）：HTTP API + 在场检测循环 + 屏幕控制
├── cordis.patch.yml  # DSH 插件清单补丁
├── locale/{en,zh}.json
├── icon/biometric.svg
├── vendor/           # pico.js + facefinder（人脸检测）、facedesc.js（旧版特征）、
│                     # faceapi/（face-api.js + tiny_face_detector / landmark_68 /
│                     # face_recognition 模型，浏览器端 128 维 CNN 特征）
└── models/           # 运行时数据（已 gitignore）：users.json / config.json / captures/
```

- **Client ↔ Host**：浏览器 UI 通过 DSH `/api` RPC 载体调用 Host 方法（`start`/`stop`/`status`），Host 用 `child_process` 管理 `server.js` 进程（detached + PID 文件，跨 DSH 重启可管理）。
- **检测管线**：页面摄像头帧 → pico 级联人脸检测 → face-api.js 128 维特征（心拍 `/heartbeat` 上报）；后端与已录入参考集做 1:N 余弦匹配，EMA + 迟滞防抖，仅机主可算在场。
- **屏幕控制**：WMI 背光 0 + 常驻 PowerShell worker（首次切换 ~25ms）+ 全屏黑色遮罩窗口（`models/_black_win.ps1`）；刻意避开 SC_MONITORPOWER，因为它会连带触发系统锁定。
- **服务端人脸兜底（handoff 协议）**：页面切后台时主动交出摄像头（停轨道 → `srcObject=null` → `removeAttribute('src')` + `load()`，否则 Windows 上 DirectShow 句柄不会真正释放），心跳带 `vis:hidden + handoff`；后端即用 ffmpeg（DirectShow，`fps=4, 320x240, rgb24`）抓帧，在 Node 里通过 `vm` 沙箱跑同一个 pico 检测器。仅判"有没有人"，身份核验仍由页面负责。
- **兜底接管不了时**：设备仍被冻结页面占住 → ffmpeg 打开失败，退回键鼠空闲兜底（`blindAwaySec`）。ffmpeg 自带 `-t 180` 生命周期上限，`_killProc()` 用 `taskkill /T /F` 硬杀，确保设备不被泄漏进程永久锁死。
- **卸载 / 停用自净**：后端每 15s 自检两条——自身文件消失，或出现在 `.dsh-market/state.json` 的 disabled 列表（`@local/bio-recognize` / `bio-recognize`），连续两次确认即恢复亮度并退出，遮罩窗口由看门狗收尾。另提供手动一条命令 `node server.js --uninstall`：杀后端进程树（含遮罩窗口与 ffmpeg）、按 `_black_level.txt` 恢复亮度、清理 pidfile——不依赖 DSH 提供任何卸载入口。

## 安全注意

- 后端仅监听 `127.0.0.1`，不出网；但 `/screen`、`/config` 等接口对本机所有进程开放，请勿在不可信环境运行
- 黑屏仅调背光 + 遮罩窗口，不锁屏、不涉及密码；普通键鼠输入无法唤醒，逃生口为按住 Shift/Esc（可在 `keyEscapeMs` 设 0 禁用）
- 身份核验基于单张录入照片的 CNN 特征，双胞胎/高度相似人脸可能误匹配，可调高 `matchThresholdV2`
- 建议仅在本机/内网可信环境部署

## 许可证

MIT
