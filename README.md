# BioRecognize - 人脸识别智能熄屏（DSH 插件）

为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 编写的插件：通过 **人脸 CNN 身份识别**（face-api.js 128 维嵌入）判断座位上是否是本人——离开自动熄屏，本人回来自动亮屏，其他人坐在座位上屏幕保持熄灭。

## 特性

- **人脸识别**：tinyFaceDetector 检测 + FaceRecognitionNet 128 维嵌入，1:N 与已登记本人比对（阈值 0.93，三段判定 self / unknown / other）
- **身份安全**：黑屏状态下「认不出是谁」不亮屏——陌生人坐下不会点亮屏幕；键鼠完全无权唤醒
- **防照片攻击**：单帧强证据 + CNN 嵌入比对，照片无法通过身份验证
- **无摄像头降级（可选，默认关）**：本机没有摄像头时，键鼠空闲 N 分钟熄屏、动键鼠亮屏（仅节能、无身份安全）
- **熄屏实现**：黑屏覆盖窗口 + 降亮度，不碰 Windows 会话锁，不影响远程桌面 / ToDesk / 向日葵
- **稳定性**：心跳 Web Worker 时钟（页面后台化不节流）、摄像头看门狗、黑窗崩溃看门狗、心跳断流保护
- **服务自管理**：DSH 激活插件时自动拉起后端；设置页可启停
- **设置页**：DSH 用户菜单 → 设置 → 智能熄屏

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

1. 打开 DSH **设置 → 智能熄屏**
2. 点「▶ 启动服务」（插件激活时通常已自动启动）
3. 添加用户 → 用「📷 摄像头采集」录入人脸（无摄像头时用路径录入）
4. 配置熄屏时间等参数（离开后动作固定为黑屏，不支持锁屏）
5. 「💾 保存配置」并启用检测

Agent 侧工具（聊天中直接让 AI 调用）：

| 工具 | 说明 |
|------|------|
| `biometric_service_control` | 启动 / 停止 / 查询后端服务 |
| `biometric_register_face(_photo)` | 路径或 base64 录入人脸 |
| `biometric_face_detect` | 单模态人脸检测 |
| `biometric_screen_control` | 亮屏 / 黑屏 / 查询状态 |
| `biometric_set_config` / `biometric_get_config` | 读写配置 |
| `biometric_presence_status` | 在场状态 |
| `biometric_manage_users` | 用户增删查 |
| `biometric_combine` | 人脸身份识别 |

## 架构

```
bio-recognize-plugin/
├── index.js          # Host 插件：Agent 工具 + /api/bio-recognize RPC + 服务进程管理
├── client.js         # 浏览器 UI：设置页（settings.section）、采集面板、composer 状态条
├── server.js         # Node 后端（127.0.0.1:8765）：HTTP API + 在场检测 + 屏幕控制
├── vendor/faceapi/   # 本地托管 face-api.js + 3 个模型（8.2MB）+ tfjs WASM 后端
├── models/_black_win.ps1  # 黑屏覆盖窗口 + 崩溃看门狗
├── cordis.patch.yml  # DSH 插件清单补丁
├── locale/{en,zh}.json
├── icon/biometric.svg
└── models/           # 运行时数据（已 gitignore）：users.json / config.json / captures/
```

- **Client ↔ Host**：浏览器 UI 通过 DSH `/api` RPC 载体调用 Host 方法（`start`/`stop`/`status`），Host 用 `child_process` 管理 `server.js` 进程（detached + PID 文件，跨 DSH 重启可管理）。
- **识别链路**：摄像头帧 → pico 级联快速筛脸 → face-api.js CNN 128 维嵌入 → 服务端 1:N 余弦比对（同用户 top-2 参考均值防撞线）→ 三段判定。识别计算全部在浏览器端（WASM 后端，~140ms/帧），后端只做比对。
- **心跳**：300ms 节拍由 Web Worker 驱动（后台标签页不被节流），每拍携带摄像头/检测/耗时诊断。

## 安全注意

- 熄屏仅是黑屏覆盖 + 降亮度，**不涉及 Windows 会话锁**，也不存储任何密码
- 无摄像头降级模式**没有身份安全**（任何人动键鼠都能亮屏），仅作节能用途
- 建议仅在内网/本机部署

## 许可证

MIT，详见 [LICENSE](./LICENSE)。
