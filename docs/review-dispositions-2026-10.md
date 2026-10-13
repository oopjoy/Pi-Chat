# 2026-10 外部评审意见的处置记录

本文档记录一轮外部 code review 中产品建议的裁定结论。原则与
[`architecture.md`](architecture.md) 的 hard product boundaries 和
reliability convergence freeze 一致：**不为“可配置”而可配置，不为增加模式而增加模式；
每一项保留项必须指明 owner、触发条件与验证方式。**

## 第 3 组：Hot Runtime 容量

| 建议 | 裁定 | 状态 |
|---|---|---|
| 409 时给用户明确提示 | ✅ 保留。服务端错误改为携带具体占用（n/N、忙碌数）并明确“历史仍可只读浏览”；错误码 `RUNTIME_CAPACITY_EXHAUSTED` 保持不变 | 已实现（`runtime-pool.ts` capacityError） |
| 手动“冻结” Secondary | 🟡 更名为“释放 Runtime”，仅在 idle、无 pending、无确认时允许；不解决容量主问题（LRU 已自动回收可安全回收者） | 候选，待真实需求 |
| “只读热会话” | ❌ 删除。现有 cold/view-only projection 已承担该职责，不引入第三种生命周期状态 | 拒绝 |
| About 显示 hot n/7 | ✅ 合理 | 候选；连同池占用（busy/reclaimable）进 Diagnostics 比 About 更合适 |
| 记录 409 次数 | ✅ 适合 Diagnostics 导出计数器 | 候选 |

## 第 4 组：生命周期

| 建议 | 裁定 | 状态 |
|---|---|---|
| 把 `lastWindowAutoShutdownEnabled` 做成 Settings 开关 | ❌ 拒绝。它是 legacy/test opt-in；浏览器 unload 信号不可靠，暴露即产品承诺 | 拒绝 |
| 自动退出 | 🟡 如未来确有后台驻留 UX 问题，重新设计为 server-side idle-shutdown（presence 空 + 全局 quiescent + 连续空闲 N 分钟），不是包装 legacy flag | 重新设计后才立项 |
| 系统托盘 | 🟡 Setup 稳定、确认真实需求后再评估；引入第四层常驻进程（tray）需先回答启动/监控/升级 ownership | 候选，依赖 Setup 稳定 |
| PID/uptime/memory | 🟡 uptime 可进 About；PID/内存树统计进 Diagnostics → Runtime resources | 候选 |

## 第 5 组：Files / Gate

| 建议 | 裁定 | 状态 |
|---|---|---|
| Explorer“打开所在文件夹” | ✅ 保留。实现沿用 `workspace-open` 的服务端 canonical path 重验证模型（Session ID + recent path → server revalidate → `explorer.exe /select,...`），浏览器不得直传绝对路径 | 候选，实现时补 route test |
| 冷历史加载条数可配置 | ❌ 拒绝。10/20 轮可作为纯 UI pagination preference；后端 8 MiB tail 预算、bounded scan/page、20 万条目上限是安全 invariant，永不暴露为设置 | 拒绝 |
| Gate 状态更明显 | ✅ 已满足：顶栏 GateControl（盾牌图标 + 严格/放行 + “不是完整 sandbox”说明）已按此原则实现 | 已完成 |
| 会话批准路径缓存 | 🟡 可行但 key 必须是 Session + Runtime generation + canonical exact file + tool class（write/edit），禁止目录级白名单；Bash 不适用；Runtime 重启/路径变化/symlink 复验失败即失效 | 候选，实现时须声明不成为新的 security authority |

## 关联

- App.tsx 拆分意见的处置（ownership 口径）见 [`web-architecture-roadmap.md`](web-architecture-roadmap.md) 五.1 节。
