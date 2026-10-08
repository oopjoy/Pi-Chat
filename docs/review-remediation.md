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

## 后续批次（不能标为已完成）

| 审核项 | 下一步与验收 |
|---|---|
| 不稳定 Fork 回调、重复诊断统计 | 保持闭包语义，稳定 callback、缓存统计；补渲染次数/Profiler 对照，而非只改 memo 声明 |
| outlineProjections 缓存预算 | 使用大量会话和工具密集 JSONL 测量内存/刷新开销；先留可重复数据，再决定容量政策 |
| 万能 host、整对象 Proxy | 一次选择一个真实事务边界，连同调用点改为编译器可检查的具体 ports，真正减少访问权限，不加新的代理层 |
| Callback / Ref<any> 空契约 | 参数、返回值、authority 类型与 ref 内容均收紧；禁止调用方用强制转换掩盖接线错误 |
| writer 边界测试范围 | 覆盖实际 application 目录，加入违规负例；类型负例必须纳入 tsc，行为测试保持过期结果拒绝等原有保障 |
| lint / 类型债增量门禁 | 新增或整理模块先严格；新增警告不可被旧警告减少抵消；Promise 处理与模块级预算逐步收紧，不做全库格式化 |

此前部署、LaTeX、轮次投影分支仍需基于恢复的门禁分别验收后再合并，不夹带到第一批稳定性提交。
