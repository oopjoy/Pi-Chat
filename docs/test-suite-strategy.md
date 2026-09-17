# Test Suite Strategy

## 目标

在不降低 Queue、Prompt、Steer、Runtime、Session、SSE、Release 和 Windows
安全边界覆盖的前提下，降低完整测试的单进程内存压力，并逐步拆分
“一个测试文件覆盖太多领域”的维护负担。

## 当前基线

当前冻结候选基线：

- 177 个 `tests/**/*.test.ts` 文件；
- 由测试名称解析器识别出 1,316 个静态展开测试；
- 核心 source lane 162 个文件、1,241 个静态展开测试；完整执行为
  1,249 个 Node tests（1,247 passed、2 个环境 skip）；
- benchmark lane 6 个文件、33 个测试声明与执行；
- artifact lane 9 个文件、42 个测试声明；隔离 Windows staging 执行为
  41 passed、1 个环境 skip；
- 核心 source lane 现在通过独立 Node batch 进程执行；
- 测试 harness 固定 `--test-concurrency=1`、V8 old-space 2,048 MiB，Windows
  Job memory 3,072 MiB。

`test-concurrency=1` 只限制同时运行的测试，不会清理同一个 Node 进程中已经
加载的模块、jsdom、React root、HTTP fixture 和测试缓存。因此它不能防止完整
source suite 的进程级内存累积。

## 第一阶段审计结果

### 规模较大的测试文件

以下文件优先需要关注，但“规模大”不等于可以删除：

| 文件 | 测试数 | 行数 | 主要问题 |
| --- | ---: | ---: | --- |
| `tests/conversation-process.test.ts` | 43 | 763 | 单一投影域，但案例密集 |
| `tests/web/composer-capabilities.test.ts`（已拆分） | 35 | 2,627 | 已按模型/Runtime、图片能力、delivery、Steer、Gate/layout 拆成 5 个职责文件 |
| `tests/session-index.test.ts` | 35 | 945 | Index、缓存、分支、Session metadata 混合 |
| `tests/rpc-client.test.ts` | 30 | 789 | RPC framing、timeout、process ownership、late response 混合 |
| `tests/web/pane-authority.test.ts`（已拆分） | 24 | 2,609 | 已按 Subagent、navigation、Prompt、Runtime control、recovery 拆成 5 个职责文件 |
| `tests/web/app-replacement-recovery.test.ts`（已拆分） | 23 | 2,300 | 已按 workspace、generation、maintenance、bootstrap retry、history recovery 拆成 5 个职责文件 |
| `tests/web/session-inventory-mutations.test.ts` | 23 | 2,110 | Session inventory、mutation、rename/delete、navigation 混合 |
| `tests/web/session-navigation-gate.test.ts` | 22 | 2,086 | navigation、Gate、cold/hot Session、composer 混合 |
| `tests/web/queue-steer-extension.test.ts`（已拆分） | 20 | 1,735 | 已按 cancel、cancel races、dispatch reconciliation、view settlement 拆成 4 个职责文件 |
| `tests/server/prompt-queue-steering.test.ts` | 20 | 1,332 | server Queue、native Steer、settlement 交错 |

### 目前不应直接删除的重叠层

以下名称相近的测试暂时视为分层覆盖，而不是重复测试：

- `stream-observability`：底层聚合、Server wiring、Browser integration；
- `state-diagnostics`：共享 schema、Server recorder、Browser projection；
- `session-index`、`session-projection`、`session-view-cache`：文件分支、增量
  读取、浏览器 transient merge 分属不同 authority；
- `primary-readiness`、`fast-mode-status`、`web/composer-model-runtime`：分别
  覆盖 server readiness、Fast projection、可见 Composer 行为。

只有完成 assertion-level 对照后，才允许合并或删除其中的测试。

## 分阶段计划

### Phase 1：审计与分类（已完成）

- 建立上述规模和职责基线；
- 找出混合域测试文件；
- 明确 release 必须保留的 gate；
- 不删除测试，不改变生产代码。

### Phase 2：测试执行减负（已完成）

优先改造执行层，不减少覆盖：

1. 将 source suite 分成由代码生成的 batch；
2. 每个 batch 使用一个全新的 Node 进程；
3. batch 之间顺序执行，避免额外消耗机器并发；
4. 自动验证所有 source 文件恰好覆盖一次；
5. 保留现有 `test:source` 作为完整 source gate，或让它转发到上述
   sharded runner，但不能静默排除测试；
6. 对大型 Browser App、RPC 和 Session 集成文件使用单文件 process
   isolation，不能只按测试数量平均切分。

初步试验表明，5 个或 10 个普通大小 batch 仍可能把多个大型 App 测试
放在同一个进程中并触发 3 GB 限制。因此当前实现默认使用 20 个 batch，
其中大型集成文件单独运行，其余测试再做加权分配。

建议的职责分组仍用于后续维护，但执行分片先以内存安全为优先：

- shared/pure web utilities；
- Session index/projection/cache；
- RPC/server/HTTP；
- Runtime lifecycle/readiness/recovery；
- Browser App integration；
- benchmark contracts。

### Phase 3：日常测试与 Release 测试分层（已完成）

- `test:source` 执行 162 个核心 source 文件；
- `test:benchmark` 单独执行 6 个 benchmark 文件；
- `test:source-and-benchmark` 是 unit/release 的完整非 artifact 测试入口；
- benchmark 实现及其 contract 仍被保留，未从仓库删除；
- `npm test`、nightly 和 release 仍执行 source、benchmark 和 artifact；
- 不改变 `test:artifact` 的 9 个文件边界，继续保留 build、runtime、launcher
  和 live-dist 安全检查；
- `test:source:single-process`、分批 source runner、benchmark runner 与 artifact
  runner 共同使用 `scripts/test-batches.mjs` 的 lane manifest；不再在
  `package.json` 维护第二套 `--exclude-file` / `--file` 清单；
- 回归测试验证 source、benchmark、artifact 三组两两互斥，且 union 精确覆盖
  每个 discovered test file；`bounded-tail-benchmark.test.ts` 只属于 benchmark；
- `first-token-latency`、`streaming-cadence-config`、`react-render` 的安全配置
  contract 不因 benchmark lane 分流而消失；

### Phase 4：拆分杂糅测试文件（首批已完成）

从最混合且最重的文件开始拆分，当前进度：

1. `tests/web/composer-capabilities.test.ts`：已拆成 5 个职责文件；
2. `tests/web/pane-authority.test.ts`：已拆成 5 个职责文件；
3. `tests/web/app-replacement-recovery.test.ts`：已拆成 5 个职责文件；
4. `tests/web/queue-steer-extension.test.ts`：已拆成 4 个职责文件。

Composer 第一批拆分后的职责边界：

- `composer-model-runtime.test.ts`：模型 inventory、commands、Fast 与 readiness；
- `composer-image-capability.test.ts`：图片 draft 与 Runtime capability；
- `chat-input-delivery.test.ts`：串行发送、submission scope、IME 与 lifecycle；
- `composer-steer.test.ts`：native Steer 的 pending、consume、withdraw 与 drop；
- `composer-gate-layout.test.ts`：Gate authority 与 Composer/Settings layout。

Pane authority 第二批拆分后的职责边界：

- `pane-subagent-navigation.test.ts`：Subagent status、只读 child 地址和 rehydrate；
- `pane-navigation-authority.test.ts`：cold/warm/replacement navigation fencing；
- `pane-prompt-authority.test.ts`：Prompt、Extension、Gate、model/thinking stale response；
- `pane-runtime-control.test.ts`：Abort、Stop、Queue 与历史 Queue authority；
- `pane-recovery-authority.test.ts`：token/SSE recovery、terminal refresh 与 child controls。

App replacement 第三批拆分后的职责边界：

- `app-workspace-replacement.test.ts`：New workspace、workspace SSE 与 Primary terminal fence；
- `app-replacement-generation.test.ts`：process epoch、Primary generation 与 resource reload；
- `app-replacement-maintenance.test.ts`：maintenance bootstrap、Session Index 与 Pane authority；
- `app-replacement-bootstrap-retry.test.ts`：retry budget、pending bootstrap 与 ready recovery；
- `app-replacement-history-recovery.test.ts`：early handshake、sidebar inventory 与 cold history。

Queue 第四批拆分后的职责边界：

- `queue-cancellation.test.ts`：Queue admission、cancel restore、图片与 idle cleanup；
- `queue-cancellation-races.test.ts`：draft/picker/new admission 与响应乱序；
- `queue-dispatch-reconciliation.test.ts`：dispatch、missed SSE、duplicate 与 cancellation fence；
- `queue-view-settlement.test.ts`：Session view invalidation 与 compaction settlement。

拆分只移动测试和共享 fixture，不改变断言语义；每次拆分后必须保持原
测试集合与新测试集合的名称/数量映射。

### Phase 5：验证与衡量

- 记录每个 batch 的耗时、峰值 RSS 和退出原因；
- 对比完整单进程执行与分片执行；
- 检查 batch union 与完整 discovered source set 一致；
- 分别运行 typecheck、source、artifact、E2E；
- 只有证据表明某项测试是真重复时，才考虑合并或删除。

## Release gate（保持不变）

以下不能因为日常减负而移出完整 release verification：

- `npm run typecheck`；
- 完整核心 source suite；
- 完整 benchmark lane（通过 `test:source-and-benchmark`）；
- 9 个 artifact test files；
- Playwright 三个项目及其 tag 覆盖；
- build identity、Windows launcher、startup、runtime bundle、live-dist guard；
- Gate/readiness/admission/recovery、Queue/Prompt/Steer/SSE authority 测试；
- Release packaging、checksum、manifest 和 committed-text 检查。

## 决策

当前最安全、收益最大的方向是“新进程分片 + 测试职责拆分”，而不是先删掉
测试。这样既能解决 3 GB Job memory 的单进程累积问题，也能保留现有回归证据。
