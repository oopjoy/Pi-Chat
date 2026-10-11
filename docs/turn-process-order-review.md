# 排队消息导致过程卡片跨轮次错位 — 审核说明

- 工作区：`D:\Pi-Chat-turn-fix`
- 分支：`fix/turn-process-order`
- 基线：main `ece2ed4`
- 与部署分支、LaTeX 分支独立；未合并、推送或部署，未重启正在使用的服务。

## 核查与复现

只读核对了对应 JSONL 的 message/parentId 顺序，以及 loopback Session view 返回顺序。两者均为：

```text
上一轮 User → 上一轮思考/工具 → 上一轮最终回复
→ 数学问题 User → 数学问题对应的思考/工具
```

JSONL 中 User 的 Runtime receipt 时间晚于上一轮最终回复；截图气泡显示的提交时间则更早，因为它是在上一轮尚未结束时提交到队列的。原记录不需要修复。

`protectTranscriptWithLocalTurns` 为补齐尚未在视图中确认的 User，会按本地 `turn.message.timestamp` 找第一个更晚的消息并插入。排队场景中提交时间早于上一轮的后半段工作，因此会得到：

```text
上一轮前半段过程 → 新 User → 上一轮后半段过程/最终回复 → 新一轮过程
```

`groupConversation` 忠实地在这个错误 User 边界处分组，表现为上一轮过程被拆开、旧答案落在新 User 之后，旧过程还可能被标成当前正在运行。

在内存中对只读历史窗口模拟 User echo 尚未进入视图、但下一轮 SSE 已到达的间隙，可以复现同类错位。这里只用截图中的早提交时段构造临时气泡，并不声称取到了截图当时浏览器的内存快照。测试夹具使用人工标记，不保存真实会话、图片或 reasoning signatures。

用户报告“重启后恢复”与此一致：临时 overlay/缓存被清除，新页面直接按正确 JSONL 重建。这是绕开错误投影，不代表旧代码不会再次触发。

## 修复范围

唯一生产代码改动在 `src/web/lib/local-user-turn.ts`：

- 为未确认的本地 User 计算回插下界：最后一个带 `piChatPersistedMessageId` 的历史条目之后。
- 本地提交时间不能再覆盖已持久化顺序，不能把 User 插进上一轮确定的过程/答案。
- 时间提示只保留在剩余的非持久化尾部，用于既有的 assistant terminal 先于 User echo 到达等兼容场景。
- 等待中的队列消息仍只显示在 Queue；确认落盘后继续通过既有 identity/payload 规则释放本地 overlay。

没有新增状态所有者、没有改 `groupConversation`、没有调整真实消息时间戳、没有改变 PromptScheduler、SSE 协议或 Session 写入规则。这不是对所有 legacy 无身份数据的排序算法重写。

一个既有测试原先期待“第二次提交因为时间更早而出现在第一次落盘记录前面”，等于固化了同一问题。已将它严格改为 first persisted → second pending；仍保留两个 Prompt identity 不互相确认及最终不重复的断言，并未删除测试。

## 验证结果

- 修复前，新最小回归 6 项中 5 项失败；修复后通过。
- local-turn / process grouping / cache / Queue dispatch / Queue settlement / App DOM 聚焦回归：**139/139 通过**（包括新增的工具调用/结果跨提交时间、仍必须归属于同一旧过程的回归）。
- App DOM 回归验证：旧过程包含完整旧工具且不带 streaming 状态；旧答案在新 User 之前；新过程只含新任务、位于其后且保持 streaming；落盘确认后没有重复 User。
- 新 Chromium 用例覆盖：排队期间气泡隐藏 → 忙碌刷新/缺失 dispatch 补偿 → 两个过程正确归属 → 确认落盘后 reload 顺序不变。功能断言完成，但整条用例因 EBUSY 清理失败而仍报告失败。
- TypeScript、type-debt guard、diff 检查通过；Lint 0 errors / 1328 warnings，与基线数量相同。
- 完成隔离生产构建。

### 全量门禁保留失败

- `verify:unit` 在 source batch 18 遇到既有 Runtime capacity 同一断言失败，之前已在未修改基线复现，本批未改相关逻辑。
- 后续 source batch 19/20 已补跑，105 / 110 通过；完整 benchmark lane 34/34 通过。
- 完整 Playwright：14 通过、15 失败；失败均涉及 Windows 临时目录 EBUSY 清理。不能将完整 E2E 记录为通过。

## 本机证据

日志位于 `%LOCALAPPDATA%\Temp`：

- `pi-chat-turn-order-before.log`
- `pi-chat-turn-order-focused-final.log`
- `pi-chat-turn-order-lint.log`
- `pi-chat-turn-order-unit-veEUmr.log`
- `pi-chat-turn-order-remaining-Fg550T.log`
- `pi-chat-turn-order-e2e-fkAMlX.log`

浏览器 trace 位于本工作区 `test-results/`。没有把原始聊天记录提交到仓库。

## 审核

```powershell
cd D:\Pi-Chat-turn-fix
git diff main...fix/turn-process-order
npm run test:focus -- --file tests/turn-process-order.test.ts --file tests/web/turn-process-order.test.ts --file tests/local-user-turn.test.ts --file tests/conversation-process.test.ts --file tests/session-view-cache.test.ts --file tests/web/queue-dispatch-reconciliation.test.ts --file tests/web/queue-view-settlement.test.ts
```

现有网页仍是旧构建。待审核与部署后生效；当前重启恢复的记录无需改写或重新生成。
