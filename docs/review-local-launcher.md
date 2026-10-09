# 本机 Windows launcher 临时补丁归档

本分支仅把原工作区一直保留的两处未提交修改导出为可审阅提交：

- `pi-chat-launch.cmd`：当未显式设置 `PI_CHAT_PI_ENTRY` 时，读取 managed Pi 的 `current-version` 并寻找对应 `rpc-entry.js`。
- `tests/windows-launcher.test.ts`：验证发现、显式入口优先、安装缺失，以及含空格/撇号/括号/`&` 的用户目录。

原工作区中的修改没有被撤销、重写或提交；此分支从远端基线 `ece2ed4` 单独建立。机器特定路径、认证配置、预览构建和用户记录不属于此提交。

## 与部署 P0 的关系

这是早期仅针对 CMD 的临时方案，不是最终推荐实现。`feat/deployment-p0` 已把 managed Pi 发现收敛到服务端，并增加版本指针验证，使 CMD、PowerShell 和直接 Node 启动共享同一策略。

**此分支用于保留原补丁、备选审阅。优先审阅部署 P0；不要将两者机械地重复合并。** 若采用部署方案，应关闭这个归档 PR，并在用户确认后处理原工作区遗留的相应修改。归档不表示安全检查、全量验证或功能范围与部署方案等价。

## 验证

- `npm run typecheck` 通过。
- 官方 harness 的 `tests/windows-launcher.test.ts`：7/7 通过，无跳过。
- 隔离 Artifact lane 的结果另记录在 PR；未覆盖原服务的 dist，也未重启原服务。
- 不宣称已经对本分支重新执行完整 Source / Benchmark / Playwright。
