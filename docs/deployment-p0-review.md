# Deployment P0 — 第一批审核说明

状态：独立功能分支上的候选改动，**未合并、未部署、未发布**。本批不是完整 P0，更不是完整安装器；全量验证尚未全绿。

## 工作区与边界

- 开发工作区：`D:\Pi-Chat-deployment-p0`
- 功能分支：`feat/deployment-p0`
- 起点：`ece2ed4`（main）
- 原运行工作区：`D:\Pi-Chat`，保留原有两个未提交的本机修复，不回滚、不覆盖。
- 对照工作区：`D:\Pi-Chat-deployment-baseline`，detached `ece2ed4`，仅用于复现基线问题。
- 本批不停止或替换原服务，不修改全局 Git/npm 配置，不读取或重写模型认证文件。

## 已实现

### 1. 发布包关键运行文件门禁

`runtime-required-files.json` 是发布打包与 Windows 启动共用的清单；`check-runtime-files.mjs` 检查关键文件非空、基础包/构建标识一致性、HTML 引用的 JS/CSS 入口存在。

`release-package.mjs` 校验实际待压缩目录，文件缺失时不生成 ZIP，并清理本次目标的旧 ZIP/checksum/manifest。它不是完整文件签名或依赖图验证器；完整运行能力仍需构建、启动和浏览器测试证明。

### 2. 统一 Pi 安装发现

仅修改服务端 `rpc-client.ts` 的发现逻辑，CMD、PowerShell、直接 Node 启动均受益：

- 显式 `PI_CHAT_PI_ENTRY` 仍优先且 fail closed。
- 支持官方 managed install 的 `current-version`、可选 `PI_MANAGED_INSTALL_ROOT`。
- 支持 npm prefix、原有全局/AppData/PATH 布局，以及带引号的 PATH 和 Windows `Path` 键。
- managed 版本指针拒绝路径穿越、shell 字符与超长内容。
- 修复 `rpc-entry.js` 位于 `dist/` 时 Pi 版本总是显示 unknown 的父目录查找问题。
- 不执行 Pi/npm，不自动下载；既有 frozen launch plan 和 capability probe 所有权保持不变。

### 3. 启动错误不再静默闪退

- 检查 Node 缺失/版本过旧，给出明确安装或升级建议。
- 源码未构建：提示 `npm ci --include=dev` / `npm run build`，不偷偷安装或构建。
- 发布包残缺：提示重新下载并完整解压 Windows ZIP，不要求用户构建。
- 服务立即退出：读取退出状态并打印日志尾部，不再盲等全部轮询次数。
- 双击 `start-pi-chat.cmd` 失败保留窗口；`PI_CHAT_NONINTERACTIVE=1` 可禁止暂停，退出码保持不变。
- 保留不同 build 冲突拒绝接管的规则，不自动关闭其他实例。

### 4. 文档

README 区分普通用户发布包与开发者源码流程，删除“30 秒开始”的不可靠承诺，并解释“网页服务就绪”和“Pi Runtime 就绪”的区别。

## 验证结果

本机 Windows / Node 22.23.3；测试依赖在独立工作区安装。Playwright Chromium 下载到其标准用户缓存，仅用于测试。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run lint` | 0 errors；1328 warnings，不在本批清理范围 |
| `npm run check:type-debt` | 通过，四项计数未增加 |
| 安装发现、启动 preflight、Windows launcher、release guards 专项 | 30/30 通过 |
| `npm run verify:artifact` | 40 通过、1 跳过（本机无文件 symlink 权限）、0 失败 |
| 真实隔离构建目录的 `assertRuntimeFiles` | 通过 |
| 无源码、无 node_modules 的 portable server + managed fake Pi | HTTP 和 Runtime ready 通过；独立配置/Session/端口 |
| `npm run verify:unit` | 两次均在 source batch 18 的同一既有测试失败，不能标记为通过 |
| 补跑 source batch 19、20 | 分别 112、105 通过 |
| 单独运行完整 benchmark lane | 34/34 通过 |
| `npm run verify:e2e` | 15 通过、13 失败；不得据此发布 |
| `git diff --check` | 通过 |

### 已做基线对照的阻塞

1. **Runtime capacity 测试**：`tests/server/runtime-recovery-capacity.test.ts` 的 `four viewed idle Sessions still obey a configured cap of three idle Secondary Runtimes`，第 613 行 `true !== false`。在未修改的 detached 基线完整文件重跑时也出现相同失败；单条执行多次可通过。该测试依赖并发激活时 worker 与 Session 的顺序关系，本批未修改 RuntimePool 或放宽断言。
2. **Windows E2E 清理**：候选分支 12 个失败涉及临时根目录 `EBUSY`；未修改基线完整 E2E 为 14 通过、14 失败，失败均有相同清理问题。
3. **Files/Changes 拖拽**：候选分支另有一次侧栏分区高度断言失败（预期 >363.75，实际 323.75）。基线完整运行和重复该用例时未复现同一拖拽断言，但受到 EBUSY 清理失败干扰；仍作为未决项保留，不能宣称已排除回归。

本批不修改这些不相关的测试/业务逻辑来获得绿灯。建议合并前单独定位并恢复全量门禁。

### 本机验证证据

日志保留在 `%LOCALAPPDATA%\Temp`：

- `pi-chat-review-unit-tDd6rg.log` / `pi-chat-review-unit-rerun-P32fhc.log`
- `pi-chat-review-remaining-nRNtf0.log`
- `pi-chat-review-e2e-L2BBHQ.log`
- `pi-chat-baseline-capacity-repeat-VuMiP3.log`
- `pi-chat-baseline-e2e-6RIwOS.log`
- `pi-chat-baseline-drag-dMt0kz.log`

候选分支的 E2E 失败 trace 在工作区 `test-results/`；基线证据在基线工作区。失败 staging 按项目规范保留，未复制到正在运行的 `dist/`。

## 审核方法

```powershell
cd D:\Pi-Chat-deployment-p0
git diff main...feat/deployment-p0 --stat
git diff main...feat/deployment-p0
npm run test:focus -- --file tests/pi-installation.test.ts --file tests/runtime-package-preflight.test.ts --file tests/windows-launcher.test.ts --file tests/release-guards.test.ts
npm run verify:artifact
```

不要在原服务运行时向 live `dist/` 构建，也不要为了测试强杀 30170 上的服务。默认启动脚本仍固定 30170；两个版本不能通过双击同时占用该端口。审核构建使用官方 staging 验证入口。

## 后续按顺序推进，尚未实现

1. **P0 第二批**：Runtime 不可用时提供选择入口、重新检测、重试；需与现有 lifecycle barrier/frozen launch plan 对齐，不能在运行中悄悄替换 Pi。
2. **P1**：首次运行向导，Node/Pi/模型/代理分阶段诊断，doctor 与脱敏报告；配置仍复用 Pi，不建立另一份模型密钥存储。
3. **P2**：Windows 安装器与更新方案；是否携带 Node/Pi 必须先审核分发许可和更新所有权，不自动运行远程安装脚本。

本批没有实现自动代理识别、自动软件安装、模型首次配置向导或 Windows 安装器。
