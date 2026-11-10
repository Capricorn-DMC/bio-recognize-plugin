# BioRecognize - 人脸识别智能熄屏（DSH 插件）

为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 编写的插件：通过 **人脸 CNN 身份识别**（face-api.js 128 维嵌入）判断座位上是否是本人——离开自动熄屏，本人回来自动亮屏，其他人坐在座位上屏幕保持熄灭。

## 特性

- **人脸识别**：tinyFaceDetector 检测 + FaceRecognitionNet 128 维嵌入，1:N 与已登记本人比对（阈值 0.93，三段判定 self / unknown / other）
- **身份安全**：黑屏状态下「认不出是谁」不亮屏——陌生人坐下不会点亮屏幕；**键鼠（含移动鼠标）完全无权唤醒**
- **应急逃生口**：人脸持续识别失败时，黑屏中**长按 Shift 或 Esc 8 秒**可强制亮屏；若 5 秒内仍认不出本人，自动重新熄灭（不是永久后门）
- **防照片攻击**：单帧强证据 + CNN 嵌入比对，照片无法通过身份验证
- **无摄像头降级（可选，默认关）**：本机没有摄像头时，键鼠空闲 N 分钟熄屏、动键鼠亮屏（仅节能、无身份安全）
- **熄屏实现**：黑屏覆盖窗口 + 降亮度，不碰 Windows 会话锁，不影响远程桌面 / ToDesk / 向日葵
- **稳定性**：心跳 Web Worker 时钟（页面后台化不节流）、串行判定循环（不会因屏幕操作变慢而并发重入）、翻转熔断（1 分钟内超过 12 次亮灭即冻结熄屏 30 秒）、摄像头看门狗、黑窗崩溃看门狗、心跳断流保护
- **服务自管理**：DSH 激活插件时自动拉起后端；设置页可启停
- **设置页**：DSH 用户菜单 → 设置 → 智能熄屏

## 安装

前置：Node.js >= 18（本项目无第三方依赖，无需 `npm install`）。

在 DSH 中安装（二选一）：

```bash
# 方式 1：CLI 源码安装（推荐，复制即可用）
dsh plugin --profile web add github:Capricorn-DMC/bio-recognize-plugin

# 方式 2：DSH 中插件管理 → 安装 → 选择本目录（本地开发）
```

## 使用

1. 打开 DSH **设置 → 智能熄屏**
2. 点「▶ 启动服务」（插件激活时通常已自动启动）
3. 添加用户 → 用「📷 摄像头采集」录入人脸（无摄像头时用路径录入）
4. 配置熄屏时间等参数（离开后动作固定为黑屏，不支持锁屏）
5. 「💾 保存配置」并启用检测

黑屏之后：

- **本人回到画面里** → 连续识别到本人后自动亮屏（约 0.6~1s）
- **移动鼠标 / 敲键盘** → 不会亮屏（这是插件的核心规则）
- **应急** → 长按 **Shift** 或 **Esc** 8 秒强制亮屏；5 秒内认不出本人会自动重新熄灭
- **摄像头/检测器故障** → 后端看门狗自动恢复亮屏，不会把人锁在黑屏后面

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

## 安全说明

- 熄屏仅是黑屏覆盖 + 降亮度，**不涉及 Windows 会话锁**，也不存储任何密码
- 无摄像头降级模式**没有身份安全**（任何人动键鼠都能亮屏），仅作节能用途
- 人脸模式下键鼠不是在场证据：动鼠标、敲键盘都不会唤醒屏幕；唯一的人工通路是长按 Shift/Esc，且必须通过身份复核才会保持亮屏
- 建议仅在内网/本机部署

### 亮/熄屏判定规则（bioOnly）

| 条件 | 结果 |
|------|------|
| 检测到人脸且匹配已登记本人，连续 ≥3 帧 | 亮屏 / 保持亮屏 |
| 刚亮屏的 3 秒内（摄像头曝光重新收敛） | 短暂丢帧不熄屏 |
| 连续丢帧 1.8 秒以内（CNN 推理占用管线） | 不熄屏 |
| 客户端上报「这一帧看不到」（画面全黑 / 推理进行中） | 视为**盲区**，暂停判定（上限 4 秒），绝不当作离场 |
| 心跳仍在但摄像头画面消失 ≥ 10 秒（视频流死亡 / 页面被暂停） | 熄屏（无本人证据 = 熄；摄像头恢复后人脸约 1 秒重新点亮） |
| 黑屏下摄像头画面消失 ≥ 30 秒 | 交还屏幕一次（避免永久黑屏），之后仍按上述规则判定 |
| 检测到人脸但识别为陌生人 / 不确定 | 保持熄灭（亮屏状态下按正常离场逻辑熄灭） |
| 没有任何人脸 | 丢帧容忍 + `awayDelayMs` 之后熄灭 |
| 熄屏期间移动鼠标 / 敲键盘 | **无动作** |
| 熄屏期间长按 Shift 或 Esc ≥ 8 秒 | 亮屏，但 5 秒内认不出本人则重新熄灭 |
| 摄像头/检测器不可用、心跳断流超过看门狗 | 恢复亮屏（保证不会锁死黑屏） |

### 静态扫描告警逐项说明

| 告警 | 说明 |
|------|------|
| `child_process`（spawn / execFileSync） | 核心功能所需：启动/停止后端进程、`taskkill` 进程树清理、调用 PowerShell 实现黑屏与亮度控制。所有命令参数均为插件硬编码的常量，**不接受任何用户/远程输入拼接** |
| 硬编码 / 请求 `127.0.0.1:8765` | 后端仅绑定本机回环地址（`hostname: '127.0.0.1'`），不监听外网接口；跨网络攻击面为零 |
| 动态执行代码 | **已移除**。pico.js / facedesc.js 两个插件自带脚本改为：客户端 `<script>` 标签加载、服务端 Node `vm` 隔离上下文求值。文件全部随插件本地分发，运行时不从网络下载任何代码 |
| `fs.writeFileSync`（PID 文件） | 仅写入后端进程号到插件目录内的 `.server.pid`，用于跨重启进程管理 |

## 许可证

MIT，详见 [LICENSE](./LICENSE)。
