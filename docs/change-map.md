# Pi Chat 修改导航地图

本文用于把常见修改目标快速映射到唯一状态所有者、时序边界、关键不变量和验证入口。它是维护索引，不重新定义产品或架构政策。

规范来源：

- 产品身份、开发和安全说明：[`README.md`](../README.md)
- 当前功能面：[`feature-surface.md`](feature-surface.md)
- 进程与服务端所有权：[`architecture.md`](architecture.md)
- 前端可见状态所有权：[`frontend-state-ownership.md`](frontend-state-ownership.md)
- revision、generation 与异步写入时序：[`timing-contracts.md`](timing-contracts.md)
- 本轮维护导航测量与停止结论：[`maintenance-navigation-measurement.md`](maintenance-navigation-measurement.md)
- 发布步骤：[`release-checklist.md`](release-checklist.md)

若本地图与规范文档或当前代码不一致，应修正过时内容，不得用本地图建立第二套政策。

## 修改入口

| 修改目标 | 首要生产入口 | 唯一策略所有者 | 首要测试 |
|---|---|---|---|
| Slash 指令联想与 Composer 能力 | `ChatInput.tsx`、`App.tsx` command projection | App coordinator 提交的 Pane commands；组件只渲染 | `web/composer-capabilities.test.ts`、`session-view-cache.test.ts` |
| Queue 排队、撤销与恢复 Composer | `App.tsx`、`local-user-turn.ts`、`prompt-scheduler.ts` | 浏览器 local-turn overlay；服务端 `PromptScheduler` | `web/queue-steer-extension.test.ts`、`local-user-turn.test.ts`、`prompt-scheduler.test.ts` |
| Prompt acknowledgement / delivery uncertain | `App.tsx`、`prompt-scheduler.ts`、`rpc-client.ts` | 服务端调度与 RPC outcome；浏览器 local-turn reconciliation | `web/prompt-consistency.test.ts`、`server/prompt-queue-steering.test.ts`、`prompt-scheduler.test.ts` |
| Native Steer | `app.ts`、`App.tsx` | `PiChatApp` 的 generation-scoped admission/snapshot；Pi queue 是消费证据 | `server/prompt-queue-steering.test.ts`、`web/composer-capabilities.test.ts` |
| 冷历史浏览与分页 | `session-index.ts`、`app.ts` Session view、`session-view-cache.ts` | `SessionIndex` 的 JSONL snapshot；App coordinator 决定可见提交 | `session-index.test.ts`、`session-navigation.test.ts`、`web/session-navigation-gate.test.ts` |
| Session 切换与旧响应隔离 | `App.tsx` authority helpers | App coordinator | `web/pane-authority.test.ts`、`web/session-navigation-gate.test.ts`、`refresh-navigation-guards.test.ts` |
| Runtime 启动、容量和回收 | `runtime-pool.ts`、`app.ts` integration | `RuntimePool` 持有 Secondary worker/capacity；`PiChatApp` 持有跨域 finalization | `runtime-pool-admission.test.ts`、`server/runtime-recovery-capacity.test.ts` |
| Primary readiness / recovery | `primary-runtime-readiness.ts`、`app.ts` adoption | `PrimaryRuntimeReadinessController` 与 `PiChatApp` binding | `primary-readiness.test.ts`、`server/runtime-recovery-capacity.test.ts`、`rpc-client.test.ts` |
| 多窗口观察与控制权 | `session-control.ts`、`app.ts` SSE projection | `SessionControl` | `session-control.test.ts`、`server/window-control-lifecycle.test.ts`、`server/shutdown-control.test.ts` |
| Gate / Extension UI / 模型澄清问卷 | `runtime-event-transition.ts`、`app.ts` pending request/response、`ExtensionDialog.tsx`、`AskQuestionnaireDialog.tsx`、`lib/ask-questionnaire.ts` | Pi Extension 工具与 RPC request ID 保持执行权；服务端持有 Session/control/first-response 路由；Ask 组件只投影已进入工具调用的 bounded questions，并在最终提交后将完整草稿映射回 Package 现有的有序标量请求 | `ask-questionnaire.test.ts`、`ask-questionnaire-dialog.test.ts`、`extension-dialog.test.ts`、`server/session-read-sse-extension.test.ts`、`web/queue-steer-extension.test.ts`、`web/pane-authority.test.ts` |
| SSE 节流、顺序和背压 | `sse-hub.ts` | `SseHub` 只持有 transport client/pending frame | `sse-hub.test.ts`、`sse-transport-recovery.test.ts` |
| Workspace 默认值与 draft picker | `App.tsx`、`workspace-state.ts`、`app.ts` | 服务端 workspace snapshot；浏览器各 picker token | `draft-workspace.test.ts`、`workspace-state.test.ts`、`web/app-replacement-recovery.test.ts`、`server/workspace-resource-lifecycle.test.ts` |
| Rename / Delete | `App.tsx` optimistic projection、`app.ts` orchestration | App coordinator mutation token/tombstone；服务端 Session mutation | `web/session-inventory-mutations.test.ts`、`session-management.test.ts` |
| Restart / shutdown | `application-lifecycle.ts`、`application-restart.ts`、`app.ts` | lifecycle barrier 与对应资源所有者 | `application-lifecycle.test.ts`、`application-restart.test.ts`、`server/application-restart-admission.test.ts`、`server/shutdown-control.test.ts` |
| Host / Origin / request token admission | `request-guard.ts` | request guard | `request-guard.test.ts`、`api-recovery-token.test.ts` |
| 状态诊断黑匣子与 JSON 导出 | `server/state-diagnostics.ts`、`server/sse-hub.ts`、`web/lib/state-diagnostics.ts`、`App.tsx`、`ManagementPanel.tsx` | 服务端与当前浏览器页面各自始终开启的有界 closed-schema 内存 lane；SseHub 只报告无 payload 的结构投递结果；App 只观察既有 authority 决策；导出使用一次性 Session alias，不拥有启停或窗口控制状态 | `state-diagnostics.test.ts`、`server/state-diagnostics-route.test.ts`、`sse-hub.test.ts`、`web/state-diagnostics.test.ts`、`web/diagnostic-settings.test.ts`、`web/app-replacement-recovery.test.ts`、`web/composer-capabilities.test.ts` |
| System Gate 安装与完整性 | `system-gate-installer.ts` | system Gate installer | `system-gate-installer.test.ts` |

## 可写状态所有权

“唯一所有者”指唯一 mutation-policy authority。部分 Map 仍因测试或集成兼容按引用暴露，这不授权调用者建立第二套写入政策。

| Authority | 唯一所有者 | 集成边界 | 明确不是所有者 |
|---|---|---|---|
| Application lifecycle 与 admitted mutation count | `ApplicationLifecycleCoordinator` | `PiChatApp` route/restart/resource operations | route adapter |
| Primary readiness generation 与 compatibility | `PrimaryRuntimeReadinessController` | `PiChatApp` adoption | 浏览器 readiness UI |
| Primary Session/child binding | `PiChatApp` | bound Session、RPC generation、recovery finalization | `runtime-event-transition.ts` |
| Secondary Runtime map、capacity、reclaim | `RuntimePool` | 显式 host callback | HTTP/SSE layer |
| Runtime operation admission | 每个 Runtime 对应的 `OperationAdmission` | mutation/reclaim/delete path | lifecycle 文档或 UI |
| Presence 与 exclusive control | `SessionControl` | `PiChatApp` per-client projection | `SseHub` |
| Prompt/follow-up queue 与 dispatch | `PromptScheduler` | Runtime leases 和 host callbacks | `RuntimePool` capacity policy |
| SSE sockets、throttle、pending frames | `SseHub` | disconnect callback | `SessionControl` / lifecycle |
| Cold JSONL path、index、snapshot | `SessionIndex` | read route 与 Runtime lookup | Runtime creation |
| 当前可见 Conversation projection | `conversationPaneReducer` | App coordinator normalized action | API、cache、EventSource |
| 异步结果能否写当前 Pane | App coordinator authority helpers | reducer dispatch | `ConversationPane` component |
| Session view LRU 与 transient overlay | `SessionViewCache` | App coordinator | reducer/component |

## Epoch、generation 与 request token

完整语义见 [`timing-contracts.md`](timing-contracts.md)。这些值保护不同领域，不得因为名称相似而合并。

| 领域 | 证明字段或 token | 保护的边界 | 所有者 |
|---|---|---|---|
| Pane authority | desired Session、navigation epoch、pane commit revision、committed identity、draft generation、浏览器 `runEpochGeneration` | 旧 Session、同 Session 重访、旧 draft 或旧服务进程的异步结果不得重绘当前 Pane | App coordinator |
| Session data revision | Session event version、cache revision、request-start revision | 较老 HTTP/JSONL response 不得覆盖较新的 SSE/cache fact | App coordinator 与 `SessionViewCache` |
| Request-local authority | pagination token、picker token、refresh epoch、`AbortController` | 一个旧 request 不得提交或清理新 request 的状态 | 对应 request owner |
| Server process provenance | server `runEpoch` 与浏览器 accepted epoch/generation | replacement 前的 server event/continuation 不得影响新服务 | server entry / `PiChatApp` / App coordinator |
| Session run provenance | per-Session run generation、settled generation | 较早或已 settle turn 的延迟 lifecycle/tool frame 不得恢复活动状态 | `PiChatApp` 与浏览器 event admission |
| RPC child provenance | `PiRpcClient.sourceGeneration`、Primary binding generation、Secondary `rpcGeneration` | 旧 child event/response 不得影响 recovered Runtime | `PiRpcClient`、`PiChatApp`、`RuntimePool` |
| Runtime operation lifecycle | `OperationAdmission.generation`、abort/dispatch generation | reclaim/restart/delete/abort 不得越过 admitted work 或继续旧 dispatch | Runtime lifecycle owner |
| Workspace snapshot | process epoch 与 workspace revision | 旧 picker/bootstrap 不得覆盖新默认值 | `PiChatApp` 与 App coordinator |

浏览器 `runEpochGeneration` 是本地 service-replacement invalidator，和 server `runEpoch`、per-Session run generation、RPC child generation 均不是同一概念。

## 异步写入规则

| 异步结果目标 | 必须经过 | 允许的后台副作用 | 禁止的捷径 |
|---|---|---|---|
| 完整 selected Session Pane | `applySessionView(view, authority)` | 通过 freshness checks 后更新目标 Session cache/inventory | 只比较 Session ID 后 dispatch |
| selected Session 增量 Pane | `commitPaneIfCurrent(authority, action)` | Session-scoped cache patch | `await` 后 raw reducer dispatch |
| 当前 draft Pane | `commitDraftIfCurrent(authority, action)` | 仅显式 coordinator-owned state | 只检查 `identity.kind` |
| SSE 可见 projection | transport/run/session admission 后的 domain action | off-screen Session cache 与 activity 更新 | 将 raw SSE 直接交给组件 |
| Off-screen Session | `SessionViewCache` 与 inventory owner | cache/activity update | 修改当前 reducer |
| Server Runtime mutation | lifecycle lease、Session control、Runtime operation lease（按操作需要） | Session activity publication | 在 admission barrier 外写 RPC |
| Restart/resource/workspace operation | application lifecycle barrier 与最终 busy recheck | staging/rollback-owned filesystem work | 只检查一次 busy 后直接启动 |

同步用户意图和已准入 SSE frame 可以发送带 identity 的 reducer domain action；普通 API、timer、picker、warm、pagination continuation 不可以。

## 必须保持的不变量

| 不变量 | 规范 | 首要回归层 |
|---|---|---|
| 服务只监听 loopback，并执行精确 Host、Origin、token 校验 | README 安全说明、Architecture security posture | `request-guard`、`api-recovery-token` |
| 冷历史 browsing/search/pagination 不激活 Runtime | Architecture runtime/session policy | `server/runtime-bootstrap-drafts.test.ts`、`session-navigation`、`web/session-navigation-gate.test.ts` |
| 一个 live writer，多窗口可观察 | Architecture Session control | `session-control`、`server/window-control-lifecycle.test.ts` |
| Primary 加最多四个 Secondary | Architecture runtime/session policy | `runtime-pool-admission`、`server/runtime-recovery-capacity.test.ts` |
| Runtime identity 与 cwd 在其生命周期内不可重绑 | Architecture workspace/runtime policy | `runtime-pool-admission`、`workspace-state`、`server/workspace-resource-lifecycle.test.ts` |
| Lifecycle barrier 必须 drain 已准入 mutation | Architecture、lifecycle module | `application-lifecycle`、`operation-admission`、`server/application-restart-admission.test.ts` |
| SSE 有内存/帧上限，且终态顺序不得被累积快照越过 | `SseHub` contract | `sse-hub`、`sse-transport-recovery` |
| Persisted history、optimistic turn、cache overlay、terminal SSE 不重复也不丢失 | Frontend/timing docs | `session-view-cache`、`local-user-turn`、`web/prompt-consistency.test.ts` |
| `ConversationPane` 稳定挂载，Session 切换不丢 Composer draft | Frontend ownership plan | `web/session-navigation-gate.test.ts`、Playwright |
| 等待中的本地 turn 只在 Queue，dispatch 后才进入 transcript | Prompt/local-turn contract | `web/queue-steer-extension.test.ts`、`local-user-turn`、`prompt-scheduler` |
| Prompt write timeout 是 outcome unknown，不能自动重试或越过排序 | Prompt/RPC contract | `prompt-scheduler`、`rpc-client`、`server/prompt-queue-steering.test.ts` |
| Native Steer 只有 Pi queue 的已验证消费才能显现为用户 turn | Steer contract | `server/prompt-queue-steering.test.ts`、`web/composer-capabilities.test.ts` |
| 已移除能力不得留下隐藏 route、browser wrapper、shared type 或专用测试 | Feature surface | source search 与对应 route tests |

## 验证入口

所有单测必须通过官方 `scripts/run-tests.mjs` harness。快速聚焦验证使用 `npm run test:focus -- ...` 别名直接转发到该脚本，避免 `npm test` 的 `pretest` 全量构建；阶段门禁使用 `verify:unit` / `verify:e2e` 的独立系统临时 staging。构建和 E2E 必须串行使用各自 staging，不得写 live `dist`。

| 修改类型 | 先跑的聚焦验证 | 阶段门禁 |
|---|---|---|
| 文档、纯类型或 owner 名称 | `npm run typecheck` | `git diff HEAD --check` |
| 单一 unit 行为 | `npm run test:focus -- --file tests/<domain>/<name>.test.ts --test-name-pattern="<behavior>"` | `npm run verify:unit` |
| Frontend authority/cache/reducer | 对应 Web、pane 或 cache 文件的直接 harness pattern | 全量单测，再完整 Playwright |
| Server Runtime/control/queue/SSE | 对应 owner-module 文件的直接 harness pattern | 全量单测 |
| Packaging / generated artifact / integration | 对应 focused tests | 隔离 build，再适用的 E2E |
| Release / launcher | launcher/restart focused tests | build、unit、E2E、release checklist |
| 测试文件物理拆分 | `npm run test:focus -- --file tests/<domain>/<name>.test.ts` | 拆分前后具体测试名称多重集合一致，且全量结果不减少 |

Harness 递归发现 `tests/**/*.test.ts`，正式按文件入口是可重复的 repository-relative `--file`；`test:focus` 会原样转发这些参数，并可与 `--test-name-pattern` 组合。名称 pattern 必须匹配所选文件中至少一个可静态解析的具体测试名，否则在启动 Node test runner 前以状态码 `2` 失败。Harness 会展开 `for...of` 字面量数组生成的模板名称；其他无法静态解析的动态名称应改写为明确测试声明。

## 修改审查模板

```md
## Change: <short name>

| Item | Selection |
|---|---|
| Product surface | existing / changed — link feature-surface row |
| Canonical owner | module/class |
| Epoch domains touched | pane / data / Runtime / request-local / none |
| Async writes | gateway or lease used |
| Invariants | linked rows above |
| Focused tests | commands |
| Full checks | commands and results |
| Normative docs changed | links or none |
| Residual risk | concise statement |
```

## 本地图不包含

- README 中已有的产品介绍；
- `frontend-state-ownership.md` 的阶段历史；
- `timing-contracts.md` 已记录的精确递增算法；
- 会持续漂移的源文件行数、测试声明数和 bundle 大小；
- 新的生产代码拆分 backlog；
- `feature-surface.md` 已拥有的完整 route/feature 清单；
- 没有具体缺陷依据的 coordinator、hook 或 service 提取计划。
