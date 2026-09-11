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

第一步已抽取纯 operation model 和 authority contract；尚未移动网络发送逻辑。

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

每个 operation 都必须有：

```text
prompt ID
Session ID
navigation epoch
Runtime generation
settlement state
```

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

网络发送逻辑仍暂时保留在 App；下一步是把普通/队列/Steer 的调用接入 facade，之后再迁移 optimistic projection。

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

## 五、当前实施状态

当前 worktree 已完成：

```text
Application state contract
Session navigation authority
Session view cache ownership
Session view reader
Stream transport coordinator
```

下一项实施：

```text
Stream boundary hardening
Prompt operation model / authority contract
```

暂不开始：

```text
PromptCoordinator 全量迁移
全局 Store
DSH plugin tree
App.tsx 大规模一次性拆分
```
