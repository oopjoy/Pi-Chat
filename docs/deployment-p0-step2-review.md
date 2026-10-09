# Deployment P0 — 第二批：Pi 连接设置与免构建重启

状态：独立分支 `feat/deployment-p0` 的第二批候选改动，基于第一批 `7942e0d`。未合并 main、未推送、未替换 `D:\Pi-Chat` 的运行服务。第一批背景见 [deployment-p0-review.md](deployment-p0-review.md)。

## 用户可见变化

- Runtime 不可用提示旁新增 **连接设置 / 重试**。
- **设置 → 关于 → Pi 连接设置 / 重试** 可在 Runtime 正常时检查入口。
- 重新检测仅检查磁盘安装元数据，不发 RPC、不启动 Pi。
- Windows 原生文件窗口选择可信 Pi 安装的 `dist/rpc-entry.js`，选择和取消本身不保存设置。
- 可明确选择恢复自动发现。
- 用户确认后保存入口并重启整个 Pi Chat 服务，不执行 npm、不构建、不下载，也不重启电脑。
- 界面解释环境变量优先级、运行本地代码的信任风险、模型认证独立性及重启前保存未发送内容。

## 所有权与安全边界

| 范围 | 所有者 / 规则 |
|---|---|
| 下一次启动的入口偏好 | `RuntimeSetupStore`；只存 schema/entry，按 canonical checkout hash 隔离，位于 agent 目录 `pi-chat/runtime/` |
| 自动发现 | 复用第一批 `resolvePiEntry`，不执行命令或导入 Pi |
| 生效优先级 | 显式环境变量 → 已保存入口 → 自动发现；显式/已保存无效均不静默回退 |
| Live launch plan | 仍在 `index.ts` 启动时冻结；本批从不重绑已运行的 PiRpcClient |
| 重启执行权 | 既有 lifecycle barrier、两次 quiescence 检查、confirmed-writer-exit handoff |
| HTTP | Host/Origin/token 全保留；选择和重启额外要求当前 EventSource 页面；重启体限 8192 字节，读取前后复核页面身份 |
| 并发配置 | 配置 revision 校验，准备阶段不落盘，提交前再次验证安装；原子保存失败保留旧配置 |
| 前端 | App 持有 dialog 请求序列/服务 epoch，组件只渲染，不获得 Primary readiness/Session/lifecycle 写权限 |

新增接口为 `GET /api/runtime/setup`、`POST /api/runtime/pick`、`POST /api/runtime/restart`；均有产品入口，不是隐藏管理接口。

配置保存和进程重启不是一个跨进程原子事务：保存成功后若停止或 handoff 失败，用户选择保留供下次手动启动；旧进程未确认退出前禁止启动第二个 writer。替代服务仍执行协议探测，检测到文件不等于 Runtime ready。

原来的“完整重启并应用更新”仍会构建；新连接设置里的重启复用当前构建。两个路径共用确认旧 writer 退出的 handoff，不创建另一套 Runtime 启动所有者。源码 watch/dev 模式不暴露免构建重启能力。

## 验证

| 检查 | 结果 |
|---|---|
| TypeScript | 通过 |
| Lint | 0 errors，1328 warnings，与第一批数量相同；本批新增 warning 已修复 |
| Type-debt guard | 通过，四项计数不增加 |
| 新增 Store / route / App / API 专项 | 22/22 通过 |
| 既有 Primary readiness 和 restart admission 聚焦回归 | 通过 |
| 最终 `verify:artifact` | 41 通过，1 跳过（Windows 文件 symlink 权限），0 失败 |
| Portable missing-Pi recovery | 无源码/无 node_modules 的隔离编译产物中：未发现 Pi → 保存选择 → 旧服务退出 → handoff 当前构建 → 替代服务读到 saved 入口并完成协议探测，全部通过 |
| `verify:unit` | source batch 18 的既有 Runtime 回收测试失败；不得标为全绿 |
| 补跑 source batch 19/20 | 108 / 112 通过 |
| 完整 benchmark lane | 34/34 通过 |
| 最终完整 Playwright | 13 通过、17 失败；16 项涉及 EBUSY 清理，另 1 项侧栏拖拽断言失败 |
| 新连接设置 Playwright | 桌面通过；移动端完成所有功能断言后发生 EBUSY 清理失败，整条测试仍按失败记录 |
| Diff / committed-text | 提交前后检查 |

Portable recovery 测试将 detached handoff 替换为载荷捕获器，再由测试拥有的 child 执行其原样 command/args，避免后台替代服务逃逸测试清理；生产通用 handoff 的退出 barrier 沿用既有测试。没有向真实模型发送请求，也没有打开用户桌面的原生选文件窗口做手工操作测试。

### 本轮发现并修正

- 新浏览器测试的设置按钮精确名称应为“打开设置”，不是“设置”。
- 移动视口的侧栏遮罩需要先按真实 UI 收起后再打开设置；没有使用强制点击跳过遮罩。
- 新重启 API 在 POST 前捕获旧连接 token，防止 SSE 先观察到替代服务后，handoff 等待错误地等待第三个 token。
- 读取重启请求体后再次检查 EventSource 页面身份，防止过期页面在异步边界后取得重启权限。

### 未解决的全量阻塞

- `runtime-recovery-capacity.test.ts` 的并发 worker/Session 对应断言，与第一批同一失败；第一批已在 detached 基线复现。
- Windows 测试临时目录 `EBUSY` 清理错误，第一批已在未修改基线复现。产物测试初跑也遇到该错误；最终重跑通过，不能据此忽略其不稳定性。
- Files/Changes 侧栏拖拽高度断言，预期 >363.75、实际 323.75，与第一批未决项相同，尚未证明根因。

本批不删除或放宽这些断言，不将全量测试报告为通过；合并/发布前应单独修复验证基础设施与上述失败。

## 本机证据

日志目录：`%LOCALAPPDATA%\Temp`

- `pi-chat-step2-unit-3FH2hK.log`
- `pi-chat-step2-remaining-p1sHlj.log`
- `pi-chat-step2-lint-final.log`
- `pi-chat-p0-step2-artifact.log`（初跑含 EBUSY）
- `pi-chat-step2-artifact-final.log`（最终通过）
- `pi-chat-step2-e2e-X9V2M9.log`（测试定位修正前）
- `pi-chat-step2-e2e-final-BfS1x9.log`（最终完整浏览器结果）

完整 Playwright 的失败证据保留在本工作区 `test-results/`；聚焦定位输出在 `dist-local/step2-setup-e2e-fix/`。失败 staging 由官方 runner 保留，不写原运行目录的 dist。

## 审核入口

```powershell
cd D:\Pi-Chat-deployment-p0
git diff 7942e0d..HEAD --stat
git diff 7942e0d..HEAD
npm run test:focus -- --file tests/runtime-setup.test.ts --file tests/server/runtime-setup-route.test.ts --file tests/web/runtime-setup.test.ts --file tests/api-runtime-setup.test.ts
npm run verify:artifact
```

本批补齐 P0 的连接修复界面，不包含 P1 首次运行向导、doctor、代理自动识别或 P2 安装器。建议开始下一阶段前先单独处理全量验证阻塞，避免每批功能都依赖受干扰的浏览器证据。

## PR 发布时的 Windows CI 路径复核

PR #14 的首轮 CI 在 `runtime-setup.test.ts` 的 automatic detection 用例失败：Windows runner 的 TEMP 使用 `RUNNER~1` 短路径，fixture 的异步 realpath 得到长路径。二者指向同一个文件，测试却比较了路径拼写。这是本批测试可移植性问题，不归入旧基线失败。

在本机创建具有 8.3 别名的私有临时目录，仅为官方 harness 的子进程设置 TEMP/TMP，已稳定复现同一断言失败；没有改变文件系统或系统级设置。修正为先断言自动检测结果存在，再以 realpath 核对目标文件；保留配置 revision、安装变更必须拒绝以及失败不得覆盖旧配置的断言，生产代码未修改。

短路径 TEMP 下完整 Store 测试与正常路径下 52 项部署专项复核通过，typecheck 通过。此补充不表示新的完整 Source/E2E/Artifact 已全绿；更新后的 GitHub CI 结果以 PR 检查为准。
