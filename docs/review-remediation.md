# 审核意见整改与分批合并台账

基准：main `ece2ed4`。整改工作区：`D:\Pi-Chat-reliability`，分支 `fix/review-stability`。

## 第一批：稳定性与可信门禁

| 审核项 | 处理 | 证据 |
|---|---|---|
| 后台 Runtime 清理异常 | 空草稿 unlink 失败保留文件并记录警告；已确认退出的 detach/通知继续完成；定时器捕获拒绝；同一 pool 的 sweep 单飞；未确认退出的 writer 仍保持隔离 | `runtime-maintenance.test.ts`：EBUSY、EPERM、非空草稿、未确认孤立进程、重复 tick、失败后继续运行 |
| 共享 SessionProjection 并发 | 在共享对象内串行 open/read/commit；排队调用重新读取最新 stat，不直接共享旧结果；验证全部成功后原子发布；copy-on-append 防止旧结果数组被后续 push 改写 | `session-projection-concurrency.test.ts`：原代码三个测试失败；控制文件 read 的确定性屏障复现同对象并发、列表/正文交叉读取和失败后半更新 |
| SSE 异常收尾 | shutdown、超限、write-error 共用关闭逻辑；错误监听保留到 response close，finish 不能提前撤销；弱引用登记不额外保留断开的 response | `sse-hub.test.ts`：原代码新增两项失败，修复后晚到 error、重复断连、其他客户端继续工作及监听器释放通过 |
| Windows E2E 清理阻塞 | 仅在原有进程树退出确认通过后，使用 Node rm 的有上限重试；永久错误继续抛出，不删除未确认退出的根目录 | `e2e-fixtures.test.ts`；完整 Playwright 通过 |
| Runtime capacity 不稳定测试 | 从实际 `--session` 参数记录 fake worker 与 Session 的绑定，不再假定并发 HTTP 完成顺序等于调用数组顺序；保留容量、停止次数、冷历史等原断言，并增加绑定唯一性断言 | `server/runtime-recovery-capacity.test.ts`；完整 source lane 通过 |

### 提交拆分

- `7598910`：测试清理与并发测试绑定修正，不改业务策略。
- `da2b5bd`：Runtime 后台维护异常边界。
- `8235895`：共享投影的读取/提交顺序与失败原子性。
- `22ee134`：SSE 关闭收尾。

### 第一批验证

在独立临时 Pi 配置与 staging 中执行官方 `npm run verify`，退出码 **0**：

- Source：1463 通过，2 跳过，0 失败。
- Benchmark：34 通过，0 失败。
- Playwright：28 通过，0 失败。
- Artifact：39 通过，1 跳过，0 失败。
- TypeScript 与 diff check 通过。

跳过项保留测试自身的平台/环境条件，不修改跳过策略。此前侧栏拖拽断言本轮未出现失败，但没有把它记为已经修复；后续仍需观察复现证据。

验证日志在 `D:\Pi-Chat-review-artifacts\stability-full-verify.log`。专项复现与修复日志在同目录。

main 上原有两个未提交的本机启动修复已备份为 `main-local-20261008-190427.patch`（SHA-256 `672f26e657aeb297103b831b2aaa597005ee0af185715cd52c2af3e04913585c`），并原样保留；第一批不修改这两个文件。不自动推送、构建 live dist 或重启服务。

## 第二批：渲染隔离与边界验证

分支 `fix/review-render-boundaries`，基于已合并的第一批 `47d7811`。

- `5113958`：稳定 Fork 回调，保留对当前 Session 的正确闭包依赖；六次诊断 filter 改为一次统计，并按 sessions 引用缓存。React Hooks 和固定工厂不再由 App 注入展示 hook。
- `5ed435d`：writer 检查扩大到全部 137 个 Web 源文件，使用 AST/符号识别已知直接调用、计算属性、赋值/解构/bind 别名绕写；保留三个 writer 的行为测试。增加真正纳入 tsc 的 compile-only authority 负例，并接入 preflight/CI。
- `7ff6dec`：六个已收敛模块启用类型感知的 no-floating-promises / no-misused-promises，以及 any/unused 错误规则。规则实际查出 Runtime draft probe 的 detached finally 链，改成两分支观察收尾，保留原 Promise 向调用者传播错误。

### 可重复的渲染证据

同一个 JSDOM 流式场景，40 条历史消息、8 次更新：

| 指标 | 原前端实现 | 修复后 |
|---|---:|---:|
| 历史 ChatMessage 函数额外执行次数 | 320 | 0 |
| 既有 React Profiler 边界回调数 | 320 | 320 |
| 该次历史子树 actualDuration 合计 | 约 126.95 ms | 约 1.01 ms |

这是受控 JSDOM/React 诊断样本，不是浏览器 FPS 或所有设备性能保证；未改 MarkdownBody 缓存。日志为 `render-before.log`、`render-after.log`。Fork 行为回归仍通过。

第二批完整 `npm run verify` 退出码 **0**：Source 1475 通过 / 2 跳过，Benchmark 34 通过，Playwright 28 通过，Artifact 39 通过 / 1 跳过，零失败。最终日志为 `render-boundary-final-verify.log`（加入规模测量合同后的完整重跑）。Lint 从 1328 降为 1318 warnings，0 errors；显式 `: any` 从 732 降为 724，并下调其总量上限。

结构守卫不是完整的跨模块数据流证明，也不是安全沙箱；宽泛 host/Proxy 仍需继续收紧。类型负例防止 authority 种类混用，同类 token 是否过期仍由 writer 的运行时校验负责。六个严格模块不等于全仓库已启用严格 Promise 检查。

### outline 缓存规模测量（`5796597`）

新增 `npm run benchmark:index-scale -- <sessions> <toolPairs>`，在私有临时目录生成数据，显式 GC、校验索引结果、记录源码哈希，不读取用户会话、不启动服务。每组独立 Node 进程；结果仅用于诊断。

| 会话数 × 每会话工具对 | 总记录数 | 源文件总量 | 首次列表 | 三次未变化刷新 | 保留堆增量 |
|---|---:|---:|---:|---|---:|
| 200 × 50 | 20,400 | 4.45 MiB | 107.8 ms | 33.2 / 31.8 / 31.6 ms | 3.38 MiB |
| 1000 × 50 | 102,000 | 22.25 MiB | 427.5 ms | 148.8 / 140.4 / 135.9 ms | 15.78 MiB |
| 200 × 500 | 200,400 | 44.65 MiB | 578.2 ms | 136.3 / 128.9 / 128.6 ms | 25.24 MiB |

数据位于整改 artifacts 目录 `index-scale-*.json`。这量化了“全部历史规模会增加成本”，不是内存泄漏证据；包含 outline 与 summary 缓存，不是进程总内存。仍需大文本/图片和长期增长样本，不能直接据此选一个 LRU 阈值：盲目逐出 outline 可能把下次列表刷新变成重复全读。本批只测量，不改变预算策略。

## 后续批次（不能标为已完成）

| 审核项 | 下一步与验收 |
|---|---|
| outlineProjections 缓存预算 | 已完成三组多会话/工具密集测量；后续补大文本/图片与长期增长样本，再单独设计容量政策 |
| 万能 host、整对象 Proxy | 一次选择一个真实事务边界，连同调用点改为编译器可检查的具体 ports，真正减少访问权限，不加新的代理层 |
| Callback / Ref<any> 空契约 | 参数、返回值、authority 类型与 ref 内容均收紧；禁止调用方用强制转换掩盖接线错误 |
| lint / 类型债增量门禁的剩余部分 | 六个模块已严格；仍需覆盖其他模块、建立更细的新增警告/模块预算，防止跨位置的计数抵消，不做全库格式化 |

此前部署、LaTeX、轮次投影分支仍需基于恢复的门禁分别验收后再合并，不夹带到第一批稳定性提交。
