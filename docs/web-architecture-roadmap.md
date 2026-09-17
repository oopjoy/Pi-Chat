# Pi Chat Web 架构长期演进计划

> 目标：让 Pi Chat 成为一个可以长期维护、持续扩展的个人 Agent 平台，而不是继续把功能堆进 `App.tsx`。
>
> 原则：保持现有产品语义和 UI 行为；吸收 DSH 的状态纪律，但不引入 DSH 的平台复杂度。

## 一、长期目标

最终的 Web 层应满足：

```text
React 负责渲染
Application coordinators 负责异步生命周期
Selectors 负责纯视图投影
Pi Runtime 负责 Agent 执行事实
Server/SSE 负责跨进程事实投影
```

目标结构：

```text
src/web/
├─ application/
│  ├─ app-state.ts
│  ├─ app-selectors.ts
│  ├─ session-coordinator.ts
│  ├─ session-view-reader.ts
│  ├─ stream-coordinator.ts
│  ├─ prompt-coordinator.ts
│  ├─ sidebar-coordinator.ts
│  └─ runtime-coordinator.ts
├─ components/
├─ hooks/
├─ lib/
└─ state/
```

`App.tsx` 最终只应承担：

```text
创建 coordinator
连接 coordinator 生命周期
组合 view model
渲染 AppShell
```

它不应继续拥有所有异步请求、所有 Session ref、所有 SSE 业务分支和所有恢复策略。

## 二、不可破坏的架构不变量

### 1. Pi Runtime 仍是 Agent 执行 authority

Pi Chat 不复制：

```text
Prompt scheduler
Retry executor
Steer authority
Session/JSONL authority
Runtime lifecycle authority
```

Pi Chat 只负责：

```text
admission
UI projection
SSE transport
authority fencing
local optimistic projection
bounded recovery
```

### 2. 一个领域只能有一个 authority

```text
Session navigation    → SessionCoordinator
Session view cache    → SessionCoordinator
SSE transport         → StreamCoordinator
Prompt admission      → PromptCoordinator
Runtime lifecycle     → RuntimeCoordinator
Sidebar projection    → SidebarCoordinator
Pane rendering        → React/AppShell
```

兼容别名只能是同一对象的临时迁移工具，不能创建第二份事实状态。

### 3. 事实状态与视图状态分离

事实状态包括：

```text
Session transcript
Pi Runtime state
queue authority
tool result
agent lifecycle
Runtime generation
```

视图状态包括：

```text
active pane
popover open
scroll position
sidebar width
process disclosure
focus
```

视图状态不得反向成为 Agent 或 Session 事实。

### 4. 持久状态与临时状态分离

持久/服务器事实：

```text
JSONL transcript
Session inventory
Runtime activity
queue accepted by server
```

浏览器临时状态：

```text
local draft
optimistic user turn
unseen marker
pending focus
loading indicator
```

临时状态必须有明确的 reconciliation 和失效条件。

### 5. 所有异步 continuation 必须带 authority

异步请求完成后，必须验证相关的：

```text
Session identity
navigation epoch
Runtime generation
pane commit revision
request sequence
```

不能因为当前 ID 恰好相同，就让旧的 `A → B → A` 请求覆盖新状态。

## 三、实施阶段

### Phase 0：基线和保护（已完成）

内容：

```text
保留现有行为
增加关键路径 characterization tests
记录 state ownership
```

验收：

```text
typecheck 通过
focused tests 通过
没有 UI/协议行为变化
```

### Phase 1：应用状态合同（已完成）

已完成文件：

```text
src/web/application/app-state.ts
src/web/application/app-selectors.ts
```

内容：

```text
定义 session/sidebar/composer/runtime/conversation/view domains
定义 coordinator ownership map
提取稳定 Session、Composer、Runtime selectors
```

暂不引入第二个 Store。

### Phase 2：SessionCoordinator 第一阶段（已完成）

已完成：

```text
navigation epoch
AbortController
viewedSessionId intent
desiredSessionId intent
SessionViewCache
view cache write facade
SessionViewReader
```

仍留在 App 的内容：

```text
pane commit policy
SSE overlay
queue reconciliation
React state
```

这样先移动 ownership，再移动复杂业务逻辑。

### Phase 3：StreamCoordinator transport boundary（已完成）

已完成：

```text
EventSource creation
listener lifecycle
connection replacement
old callback fencing
frame diagnostics
oversized frame classification
```

`usePiEventSource` 现在只是 React transport adapter。

### Phase 4：Stream event admission（已完成）

目标：从 `App.handlePiEvent` 的最外层提取纯事件入口。

新增目标模块：

```text
src/web/application/stream-events.ts
```

先只处理：

```text
JSON parse
event type normalization
Session ID extraction
Runtime generation extraction
malformed event rejection
unknown event classification
```

不在这一阶段迁移：

```text
queue projection
pane reducer
prompt settlement
Session cache mutation
Runtime recovery
```

目标链路：

```text
StreamCoordinator
  ↓
ParsedApplicationEvent
  ↓
App/Projection handlers
```

验收标准：

```text
旧事件不会跨 Session 提交
malformed event 行为不变
unknown event diagnostics 不丢失
现有 SSE integration tests 全部通过
```

当前实现：

```text
src/web/application/stream-events.ts
parseStreamEvent() 返回结构化成功/失败结果
invalid type/generation 不再伪装成缺失字段
```

### Phase 5：PromptCoordinator（operation model 与 admission facade 已完成）

这是最重要、风险最高的业务 coordinator，必须在 Stream event admission 稳定后进行。

第一步已抽取纯 operation model 和 authority contract；现有 Session 的 Prompt admission 已接入 facade。Browser operation identity 目前只作为 admission 期间的本地 tracking token，不冒充 Server prompt identity。

目标中的 admission facade：

```text
submit
queue
steer
abort
cancel queued
resume queue
```

保留在 App 的内容：

```text
React optimistic rendering
最终 pane commit
错误显示
```

PromptCoordinator 不能：

```text
自己实现 retry
自己决定 Pi 是否执行
自己写 Session JSONL
自己替代 server queue authority
```

跨层必须区分两类 identity：

```text
Server/SSE-owned：piChatSessionId、piChatRunEpoch、piChatRunGeneration、未来的 piChatPromptId
Browser-local fence：navigationEpoch、connection generation、PaneAuthority
```

Browser operation ID 不是当前 Server identity 的替代品；在 HTTP admission 与 SSE settlement 对齐后，它可以作为本地 tracking token 绑定 `serverPromptId`，但不能取代 Server/Pane authority。

当前实现：

```text
src/web/application/prompt-operation.ts
Prompt operation phase transition
Session/navigation/Runtime fencing
unknown outcome 与 rejected 的分离

src/web/application/prompt-coordinator.ts
operation registry
admission facade
result/error phase classification
terminal operation cleanup
```

验收标准：

```text
A → B → A stale ack 测试通过
steer/queue/abort 测试通过
lost acknowledgement reconciliation 不退化
failure card 行为不变
```

现有 Session 的普通/queue/Steer Prompt admission 已接入 facade；draft 首次创建的组合事务仍由 App 保持原子控制。模型 route identity 已贯穿普通 Prompt 的 settings snapshot，并已补齐 New draft 的 `InitialPromptRequest.model.api` 传递与 Runtime route 校验。本阶段已继续完成：

```text
1. direct/queued admission response 暴露 Server promptId；兼容保留旧 id
2. queued 路径明确 queueItemId 与 promptId 当前 alias 的 contract
3. Server 根据 activePromptDiagnostics 向 agent_start/agent_settled/process_error 注入 piChatPromptId
4. Stream parser 校验并暴露 piChatPromptId
```

当前已验证 Primary direct/queued HTTP response 与 lifecycle SSE/settlement 的 identity 关联；queued 路径继续保持 `id === queueItemId === promptId`。普通 Session 的 Browser operation 现在会在 HTTP response 后绑定 Server promptId，并在显式 lifecycle SSE 上完成 settle/fail；旧 RPC generation 的 Server fencing 也已有覆盖。Retry 已完成 Server producer 与基础 Browser metadata projection，但最终失败/取消语义和更完整的 integrated smoke 仍保持为下一阶段：

```text
1. 已根据 bundled Pi RPC 文档固化 auto_retry_start/auto_retry_end envelope normalization；不暴露 provider error body，也不把无 finalError 的 success=false 猜成 exhausted
2. 已将 Primary/Secondary native retry fact 投影为 Server-owned retry lifecycle，复用 active serverPromptId，并接入 Browser retry metadata projection
3. 已保持 Retry metadata 单调 fencing；继续验证 retry/Steer 是否应复用或保持独立的 prompt identity
4. 检查未知浏览器 operation 与其他窗口 Prompt 的有界清理
5. 已将 active Prompt abort 与 still-queued Prompt cancel 接入 operation terminal cleanup；Prompt operation 现按 runEpoch/runtimeGeneration 做 lifecycle fencing，并保留 bounded retired Server identity
6. 最后迁移 optimistic projection、abort/cancel 和 draft rebind
```

### Phase 6：SidebarCoordinator

Sidebar 只消费 Session 和 Stream 的投影，不再直接知道 App 的全部 ref。

输入：

```text
Session summaries
Session activity
unseen markers
local navigation preferences
loading state
```

输出：

```ts
SidebarViewModel {
  groups;
  rows;
  activeSessionId;
  loading;
  canNavigate;
  statusBySession;
}
```

优先提取纯 selectors，再提取异步 inventory loading。

必须保留：

```text
directory coverage fencing
stale delete protection
pinned inventory recovery
background activity projection
```

### Phase 7：RuntimeCoordinator

Runtime 是独立生命周期，不与 Prompt 或 Session navigation 混合。

职责：

```text
starting
ready
failed
maintenance
restart
shutdown
handoff
build identity
Runtime generation
```

RuntimeCoordinator 只发布 capability/lifecycle projection，不拥有 Agent transcript。

验收标准：

```text
replacement process 不接受旧请求提交
build identity mismatch fencing 不变
restart/handoff recovery 测试通过
```

### Phase 8：Pane/Application projection

在前述 coordinator 稳定后，才整理：

```text
ConversationPane projection
App state reducer
application event routing
```

此时才考虑是否需要一个轻量的 application event bus。

不提前引入：

```text
全局 Redux 风格 Store
复杂 event sourcing
所有 UI 都变成 projection
```

### Phase 9：AppShell 收缩

最后再将 `App.tsx` 收缩为：

```text
useApplicationRuntime()
useSessionView()
useSidebarView()
useConversationView()
render AppShell
```

只要拆出的模块仍然通过大量 ref 访问 App 内部，就不算完成；必须形成清晰的输入、输出和 owner。

### Phase 10：长期维护和平台接入

架构稳定后再逐步接入 DSH 能力：

```text
权限
沙箱
工具注册
子 Agent
持久化扩展
```

接入原则：

```text
一个能力一个边界
一个持久事实一个 owner
先 server/runtime authority，再 browser projection
```

不为了可替换性预先抽象所有接口。

## 四、每个重构提交的纪律

每次只做一个边界迁移：

```text
一个 coordinator 或一个纯 selector 层
```

每个提交必须满足：

```text
可单独编译
可单独测试
可单独回退
不覆盖其他 writer 的 dirty diff
不改变 live deployment
```

每个 coordinator 提取都必须有：

```text
职责说明
输入/输出类型
authority 说明
失败模型说明
focused tests
```

如果发现一个 coordinator 开始拥有另一个领域的事实，应停止并重新拆边界。

## 五、当前实施状态（v0.4.7 调整基线）

当前 `main` 已完成并通过独立验证：

```text
Application state contract
Session navigation/view authority baseline
Session view cache ownership through `SessionViewCacheWriter`
Primary readiness/capability/application lifecycle writes through `RuntimeProjectionWriter`
Session view reader
Stream transport lifecycle
Stream event admission boundary
Prompt operation model / authority contract
PromptCoordinator admission facade
Server-owned Prompt identity propagation
Retry lifecycle projection and terminal fencing
Browser duplicate Prompt / reload / reconnect smoke
```

当前发布 checkpoint：

```text
v0.4.6   bdcf5d3；GitHub Release、Windows ZIP 与远端 checksum 已核验且旧 tag 不移动
v0.4.7   当前 main 发布候选；仍是半成品稳定性版本，不是 1.0 或 adoption release
```

v0.4.7 只接受能减少竞态、错误恢复成本或 Windows 使用摩擦的变更；不以文件大小或抽象数量为目标继续拆分 `App.tsx`。真实 Pi Runtime retry、Windows 工具链收口、更多多窗口/恢复矩阵和发布卫生仍需后续调整。

`e14ba25` 将以下逻辑从 `App.tsx` 提取为纯 admission boundary：

```text
SSE JSON parsing result
Session identity extraction
Runtime epoch/generation extraction
canonical terminal validation
stale Runtime epoch rejection
missing Session rejection
global/scoped event classification
Session-view invalidation classification
```

该 boundary 不拥有：

```text
Session cache
Prompt operation
Runtime lifecycle
queue/retry executor
React reducer
SSE transport connection
```

`e56ddcc` 完成当前 writer checkpoint：

```text
Session-view cache 只有一个 mutation façade
Primary readiness / confirmed capability / application lifecycle 只有一个 browser writer
process replacement 与 same-process Runtime projection 使用独立 generation
Bootstrap coalescing 不能让旧 request 借用新 authority
malformed lifecycle 不制造 idle 或任何 ready-frame side effect
App.tsx 只保留 wiring / migration glue，不新增 domain authority
```

架构、验证与 `80aeac2 -> e56ddcc` 描述性性能 checkpoint 见
[`runtime-projection-writer-checkpoint.md`](runtime-projection-writer-checkpoint.md)。

`9b8cccf` 完成后续有界 authority phase：

```text
ActiveSessionProjectionWriter 独占 browser hot Session-set mutation/freshness policy
cached view 只能消费当前 membership，不能复活 writable authority
Primary/Secondary hot Session read 持有 OperationAdmission 到所有 await 与 Fork-origin 完成
stale hot read 普通路径降级为 JSONL-only，fast path 返回 HOT_VIEW_UNAVAILABLE
ModelCatalogueRevisionGate 单调接纳 HTTP/SSE，并允许同 revision 的 ordered refinement
process replacement 重置 server catalogue revision floor，但拒绝 old-process authority
```

详细契约与验证见
[`active-session-projection-checkpoint.md`](active-session-projection-checkpoint.md)。
这些事实仍不属于 `RuntimeProjectionWriter`；`App.tsx` 只保留 owner wiring。
source-test exclusion list 已统一到共享 lane manifest，并有三组互斥、完整覆盖的
回归证明。

## 主动架构演进冻结

上述 authority phase 与 test-harness 收尾完成后，主动架构演进正式冻结。
不得以文件长度、命名整齐或抽象偏好为理由继续拆 `App.tsx`、增加 coordinator
或迁移 owner。新的结构变更必须至少满足一项：

- 可复现的正确性或 stale-continuation 缺陷；
- 发布、安全或平台兼容性要求；
- 可重复的测量证据表明现有边界造成实际问题。

常规工作转入缺陷修复、发布工程、安全维护和测量驱动优化，并继续一次只提交
一个 authority / lifecycle 边界。

P0/P1 执行矩阵见 [`docs/v0.4.7-stability-matrix.md`](v0.4.7-stability-matrix.md)。

v0.4.7 优先级：

```text
1. 保护并复用 v0.4.6 发布 checkpoint，不移动旧 tag；v0.4.7 发布包必须独立生成并绑定同一 source revision
2. 启动 bootstrap 未提交 Session identity 时禁用 Composer
3. 用 shared-write FIFO 统一 README / architecture 的多窗口契约
4. Windows-first 启动、诊断、安装路径和发布说明
   - agent-side browser launcher 已完成 Windows-compatible 路径、profile、detached process/port readiness 和无 shell 启动；见 [`docs/windows-first-tooling.md`](windows-first-tooling.md)
5. README 首页补充真实截图/GIF，并保持能力边界诚实
6. 补齐 SECURITY.md、CI branch/tag 触发边界和发布卫生
```

任何后续协调迁移都必须从当前 `main` 创建干净 checkpoint，并保持：

```text
Session ID + navigation epoch + committed pane revision
A → B → A fencing
SessionViewCache / JSONL authority 不变
```

继续暂缓：

```text
全局 Store
DSH plugin tree
Runtime event effects 的整体搬迁
App.tsx 一次性拆分
dirty comparison worktree 的整体合并
复杂 provisional-draft migration protocol
真实 provider retry（先建隔离 mock provider）
live deployment / live Runtime smoke（需单独授权）
```
