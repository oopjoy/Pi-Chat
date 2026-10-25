# 维护收尾验收 — 2026-10-25

## 结论与边界

**本地自动化验收通过；尚未发布或部署，不等于真实冷启动问题已关闭。**

验收对象是 `50822ca` 基础上的当前工作区，包含开始评审前已有的
草稿恢复撤回、附件 owner 分离和启动探测修改。未重置这些修改，未提交、
推送、移动 tag、覆盖 live dist 或重启现有服务。

## 收尾内容

| 范围 | 处理 | 证据 |
|---|---|---|
| 模型探测凭据 | 拒绝全部 HTTP 重定向，不向跳转目标转发认证头；取消响应体并提示填写最终地址 | 两个临时 loopback origin、虚构密钥覆盖四种 API；修复前回归失败，修复后通过 |
| 模型探测时序 | 复用 Provider 编辑器现有请求序号；取消、切换、修改连接或新请求使旧结果失效；旧错误与 finally 不能修改新请求 | 取消后重开、旧 Provider 失败与新请求交错的 DOM 行为回归，修复前失败 |
| 404 fallback | 修正 fixture，使第一个端点真实返回 404，第二个才成功；断言请求顺序 | `tests/provider-model-probe.test.ts` |
| 类型门禁 | 新增 callback 使用已有 Session 类型和具体路径参数 | explicitAny 714 降至 709，原上限 710 不变 |
| 草稿撤回 | 移除已无 UI 的附件存储管理路由与浏览器 wrapper；不读取或删除旧备份 | 路由返回 404；首次挂载前放入旧备份的测试验证无 IndexedDB 访问，重挂载不假装恢复草稿 |
| 附件生命周期 | 页面引用定期续租，网络恢复/编辑可重试失败的 claim/release；不形成失败自旋 | 确定性 heartbeat、失败恢复、空草稿 release 和 timer 清理测试 |
| 草稿丢失提示 | 未发送内容和待完成附件读取请求原生 beforeunload 确认 | DOM 回归；明确这是 best effort，不是持久备份 |
| 启动兼容性 | 保留工作区不再探测完整 get_messages 的改动，同步 compiled smoke 与文档 | RPC 回归、启动冒烟和完整 artifact gate |
| 日常 CI | main push / PR 自动跑 source-only preflight 与收尾回归；完整 Windows CI 仍手动，tag 保留完整发布门禁 | 工作流静态契约测试、本地执行对应命令；未推送，未声称 GitHub 已执行 |

## 实际执行的验收

| 命令 / 范围 | 结果 |
|---|---|
| `npm run preflight` | 通过：typecheck、lint、writer/type-debt、committed-text、88 项核心回归 |
| `npm run verify` — source | 1713 项：1708 通过、5 跳过、0 失败 |
| `npm run verify` — benchmark contracts | 34 项全部通过 |
| `npm run verify` — Playwright | 43 项全部通过，包含 desktop、保留的 mobile 回归和 forced-colors |
| `npm run verify` — artifact | 48 项：47 通过、1 跳过、0 失败；使用隔离构建目录 |
| `npm run verify` — diff | 通过 |
| `npm run test:setup` | 使用私有 Node 24.22.0，真实原生安装、已有 Pi 复用、离线后备展开、运行中拒绝覆盖/卸载、升级、启动和卸载保留用户数据均通过 |
| 最终加强后的收尾定向测试 | 40 项全部通过；加强了首次挂载前旧备份检查和四种 API 的重定向覆盖 |

非 Playwright 测试合计 1795 项：1789 通过、6 跳过、0 失败。
静态 inventory 是 282 个文件，三个 lane 精确覆盖；静态声明数与运行时
展开后的测试数不同，不用静态计数替代执行结果。

Lint 为 0 error / 1303 warning（评审初始为 1308 warning），未为了清零
warning 扩大重构。构建仍有大 chunk 提示，不作为本次性能已改善的证据。

### 6 项跳过的具体原因

- 2 项旧 Sidebar 手动刷新测试：该入口已被 Restart 替代，原测试已标记跳过。
- 3 项文件 symlink 测试：当前 Windows 用户缺少创建文件 symlink 的权限，返回 EPERM。
- 1 项 POSIX ownership/mode 测试：当前平台不是 POSIX。

这些不计为通过。本次没有放宽安全断言，也没有修改系统权限来消除跳过。

## 启动测量，不作改善率承诺

现有 `benchmark:pi-runtime-startup` 使用项目固定 Pi 1.3.0、系统 Node
24.16.0、872-byte 合成离线 Session、core profile、5 个全新子进程。
没有真实用户 Session、凭据、模型请求或用户扩展。

| 指标 | 最小 | 中位 | 样本 p95 / 最大 |
|---|---:|---:|---:|
| transport-ready | 1416 ms | 1462 ms | 1707 ms |
| capability-ready | 1418 ms | 1463 ms | 1708 ms |

transport 样本依次为 1707、1416、1583、1423、1462 ms。只有 5 个样本，
p95 等于最大值，不是稳定的尾延迟估计。测量发生在测试和安装验证之后，
不能视为 OS/Defender 冷缓存。现有 benchmark 的 capability 阶段会再查询
get_state，而生产启动复用初始 state；此处不宣称端到端生产耗时。

完整测试中 fake RPC 注入 100 ms 延迟的首帧回归，本次记录 warm idle
额外开销 11.7 ms、queued follow-up 额外开销 7.4 ms。它们不是实际模型
首 token 或浏览器物理显示时间。

**历史约 65 秒的 installed-profile 慢启动事件仍未关闭。** 下一步应在
用户批准的更新/空闲窗口观察真实启动阶段与首次发送；不能通过重发消息、
关闭安全软件或强制预热所有会话来制造漂亮结果。

## 证据位置与未执行项

本机完整日志及源文件哈希清单位于：

`C:/Users/opjoy/AppData/Local/Temp/pi-chat-closeout-vp5VPz/`

- `preflight.log`、`verify.log`、`setup.log`、`closeout-regressions.log`
- `startup-fixture.jsonl`、`startup-baseline.json`、`startup-baseline.stderr.log`
- `validation-source-manifest.json`：包含开始前用户改动及未跟踪的新源码/测试/CI 文件
- `live-health-after.json`：原监听服务仍返回原构建时间与 fingerprint

生产、测试、构建配置与工作流清单摘要（不包含本文等说明文档）：
`731b3907f7c696f507916aec342f4b01a8829a5c055df4332215249bdf6f9c3d`。
完整 verify 后只加强了上述两个测试文件，最终定向验证覆盖这些修改。
临时日志不是 Release 附件，清理系统临时目录前应按需保留。

仍需发布前人工验收：

- 干净 Windows 用户下可见安装向导、实际快捷方式体验、SmartScreen/杀毒提示；
  静默隔离安装器验证不等于这些人工检查。
- 在有 symlink 权限的环境补跑跳过的文件 symlink 安全回归；POSIX 项由相应平台验证。
- 用户批准后对真实 Provider/扩展组合进行启动、发送、停止、重连与长会话验收。
- GitHub 上的 Source Checks / 完整 Windows CI 结果，以及选定新版本号后的
  干净 checkout、tag、不可变发布包和分发身份检查。

不需要为本次收尾重新拆分 App、增加 Runtime 层或恢复实验性草稿持久化。
