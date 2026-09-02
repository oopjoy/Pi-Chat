# Test Suite Strategy

## 目标

在不降低 Queue、Prompt、Steer、Runtime、Session、SSE、Release 和 Windows
安全边界覆盖的前提下，降低完整测试的单进程内存压力，并逐步拆分
“一个测试文件覆盖太多领域”的维护负担。

## 当前基线

本次审计基于当前 `main` 工作树：

- 138 个 `tests/**/*.test.ts` 文件；
- 由测试名称解析器识别出约 1,099 个测试声明；
- source lane 约 1,057 个测试声明；
- artifact lane 42 个测试声明；
- `test:source` 当前把 129 个 source 测试文件交给同一个 Node 进程；
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
| `tests/web/composer-capabilities.test.ts` | 35 | 2,627 | Composer、Runtime readiness、模型能力、Fast、Extension 混合 |
| `tests/session-index.test.ts` | 35 | 945 | Index、缓存、分支、Session metadata 混合 |
| `tests/rpc-client.test.ts` | 30 | 789 | RPC framing、timeout、process ownership、late response 混合 |
| `tests/web/pane-authority.test.ts` | 24 | 2,604 | Pane authority、navigation、stale response、lifecycle 混合 |
| `tests/web/app-replacement-recovery.test.ts` | 23 | 2,300 | replacement、bootstrap、navigation、recovery 混合 |
| `tests/web/session-inventory-mutations.test.ts` | 23 | 2,110 | Session inventory、mutation、rename/delete、navigation 混合 |
| `tests/web/session-navigation-gate.test.ts` | 22 | 2,086 | navigation、Gate、cold/hot Session、composer 混合 |
| `tests/web/queue-steer-extension.test.ts` | 20 | 1,735 | Queue、Steer、Extension、settlement 交错 |
| `tests/server/prompt-queue-steering.test.ts` | 20 | 1,332 | server Queue、native Steer、settlement 交错 |

### 目前不应直接删除的重叠层

以下名称相近的测试暂时视为分层覆盖，而不是重复测试：

- `stream-observability`：底层聚合、Server wiring、Browser integration；
- `state-diagnostics`：共享 schema、Server recorder、Browser projection；
- `session-index`、`session-projection`、`session-view-cache`：文件分支、增量
  读取、浏览器 transient merge 分属不同 authority；
- `primary-readiness`、`fast-mode-status`、`web/composer-capabilities`：分别
  覆盖 server readiness、Fast projection、可见 Composer 行为。

只有完成 assertion-level 对照后，才允许合并或删除其中的测试。

## 分阶段计划

### Phase 1：审计与分类（当前阶段）

- 建立上述规模和职责基线；
- 找出混合域测试文件；
- 明确 release 必须保留的 gate；
- 不删除测试，不改变生产代码。

### Phase 2：测试执行减负（下一阶段）

优先改造执行层，不减少覆盖：

1. 将 source suite 分成若干由代码生成的 batch；
2. 每个 batch 使用一个全新的 Node 进程；
3. batch 之间顺序执行，避免额外消耗机器并发；
4. 自动验证所有 source 文件恰好覆盖一次；
5. 保留现有 `test:source` 作为完整 source gate，或让它转发到上述
   sharded runner，但不能静默排除测试。

建议初始分组：

- shared/pure web utilities；
- Session index/projection/cache；
- RPC/server/HTTP；
- Runtime lifecycle/readiness/recovery；
- Browser App integration；
- benchmark contracts。

### Phase 3：日常测试与 Release 测试分层

- 日常开发默认执行非 benchmark 的快速 lane；
- benchmark contract 单独执行；
- nightly 和 release 仍执行完整 source、artifact、E2E 和 benchmark；
- 不改变 `test:artifact` 的 9 个文件边界，继续保留 build、runtime、launcher
  和 live-dist 安全检查。

### Phase 4：拆分杂糅测试文件

从最混合且最重的文件开始拆分，优先顺序：

1. `tests/web/composer-capabilities.test.ts`；
2. `tests/web/pane-authority.test.ts`；
3. `tests/web/app-replacement-recovery.test.ts`；
4. `tests/web/queue-steer-extension.test.ts`。

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
- 完整 source suite；
- 9 个 artifact test files；
- Playwright 三个项目及其 tag 覆盖；
- build identity、Windows launcher、startup、runtime bundle、live-dist guard；
- Gate/readiness/admission/recovery、Queue/Prompt/Steer/SSE authority 测试；
- Release packaging、checksum、manifest 和 committed-text 检查。

## 决策

当前最安全、收益最大的方向是“新进程分片 + 测试职责拆分”，而不是先删掉
测试。这样既能解决 3 GB Job memory 的单进程累积问题，也能保留现有回归证据。
