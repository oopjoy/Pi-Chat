# 时序契约清单

本文是第 4 步 4A 的只读盘点，并记录 4B.1 已有 Pane authority 边界。
它不引入新的 revision、generation、Runtime 模式或产品行为。三个领域不能互相替代：

1. **Pane authority**：异步浏览器结果现在能否改写当前可见 pane。
2. **Session data revision**：一个 HTTP/JSONL/cache 结果是否仍适合更新某个 Session 的数据快照。
3. **Runtime provenance**：一个事件或响应是否来自当前绑定到该 Session 的 child process。

`Session ID` 可用于路由、缓存和后台数据归属；单独比较它永远不是可见 pane 的异步写授权。

## 第 3 步封板基线

记录于 4A 开始时：

| 指标 | 基线 |
|---|---:|
| `src/web/App.tsx` | 4321 行 |
| `src/web/state/conversation-pane.ts` | 465 行 |
| reducer cases | 31 |
| pane projection 异步提交 API | 3（`commitPaneIfCurrent`、`commitDraftIfCurrent`、`applySessionView`） |
| unit tests | 403 declarations |
| E2E | 9 declarations |
| production browser entry（4A 验证构建） | 398.11 kB；gzip 121.53 kB |

生产 bundle 大小取自干净 production build 的构建输出；本盘点不把带 hash 的产物文件名作为稳定架构指标。

封板不变量：

- `ConversationPane` 稳定 mounted，未按 Session 加 `key`，不会被 Session 切换卸载；
- pane 没有 tuple setter façade；
- 增量异步可见写入经 `commitPaneIfCurrent()` 或 draft counterpart；
- 完整 projection replacement 经带 authority 的 `applySessionView()`；
- `SessionInventory` 与 `AppShell` 不在此阶段继续拆分；
- 不新增 frontend hook。

## 领域一：Pane authority

### 现有证明字段

| 字段 | 创建/递增者 | 读取者 | 防止的竞态 | 领域 |
|---|---|---|---|---|
| `desiredSessionIdRef` | navigation、`commitPane`、取消导航 | `paneAuthorityCanCommit`、routing | 已失去用户导航意图的结果绘制 pane | Pane |
| `navigationEpochRef` | navigation、取消导航、New | pane/draft authority、导航 loading 控制 | 已 abort 或被后续导航取代的 continuation | Pane |
| `paneCommitRevisionRef` | 仅 `commitPane` | pane/draft authority | $A \to B \to A$ 中旧 A 覆盖新 A commit | Pane |
| `committedPaneIdentityRef` | 仅 `commitPane` | pane/draft authority | 旧 Session 或 draft continuation 写入不同已提交 pane | Pane |
| `draftGenerationRef` | `RESET_DRAFT`、`CLEAR_PANE` 的 `commitPane` | pane/draft authority | Draft 1 的 picker/first-prompt 结果覆盖 Draft 2 | Pane |

`PaneAuthoritySnapshot` 保留 Session ID、desired ID、navigation epoch、committed revision、committed identity 与 draft generation。它是完整的 Session pane 授权证明；`DraftPaneAuthority` 是对应的无 Session draft 证明。

### 唯一公开提交边界

- `capturePaneAuthority()` / `captureDraftPaneAuthority()`：在 await 前捕获证明；
- `paneAuthorityCanCommit()` / `draftAuthorityCanCommit()`：只验证 Pane authority；
- `commitPaneIfCurrent(authority, action)`：唯一 Session 增量可见写入口；
- `commitDraftIfCurrent(authority, action)`：唯一 draft 增量可见写入口；
- `applySessionView(view, authority)`：唯一完整 Session projection replacement。

同步用户意图和已 transport-admitted 的 SSE domain transition 可以直接 dispatch。API、timer、picker、warm、queue、extension、pagination 与其它异步 continuation 不得把 Session-ID comparison 当作 pane 授权。

可见状态分为两类：

- **Pane projection** 必须经过上述 authority-checked pane commit API。
- **Session-scoped feedback**（例如一个 Session 的 reconcile、Gate 自动放行反馈）不属于 reducer projection，但在 `setError` 或 `setNotice` 前必须验证同一 captured Pane authority。

连接、application lifecycle 与 build identity 等 application-global feedback 不需要 Session pane authority。

### 已审计的异步调用点

| 操作 | authority 捕获 | await 后 pane 入口 | 数据/cache 入口 | 错误可见性 | 回归覆盖 |
|---|---|---|---|---|---|
| bootstrap restore / early view | wanted Session 前 | `applySessionView` | `remember` | refresh guard | cold remembered history、A/B navigation |
| Session navigation / reconcile | destination 前、cache commit 后再捕获 | `applySessionView` | `mergeNavigation` / `refresh` | navigation epoch | cold/hot navigation、A/B/A |
| pagination | selected Session 前 | `applySessionView` | `mergeNavigation` | request token + authority | isolated history、old request revisit |
| prompt acknowledgement/rejection/reconcile | submit 前；draft 转 Session 后重捕获 | `commitPaneIfCurrent` / draft variant、`applySessionView` | local-turn/cache | same authority | stale acknowledgement/rejection、fast settlement |
| warm Runtime | selected Session 前 | `commitPaneIfCurrent` | cached capability data | authority | stale warm A revisit |
| model / thinking | `captureViewOperation` | `commitPaneIfCurrent` | staged prefs/cache | view operation | late model/thinking B isolation |
| extension response / Gate auto-allow feedback | submitted extension 的 Session 前 / pending request admission point | `commitPaneIfCurrent`；feedback 先验证 authority | authoritative reread | same authority | stale extension failure、A/B feedback isolation |
| takeover | selected Session 前 | `commitPaneIfCurrent` | Session summary | pane authority + event version | stale takeover / newer SSE |
| abort / queue cancel / resume | selected Session 前 | `commitPaneIfCurrent` / `applySessionView` | cache queue/turn overlay | view operation | late stop/queue B isolation |
| draft workspace picker | current draft 前 | `commitDraftIfCurrent` | none | draft picker Symbol + draft authority | Draft 1 to Draft 2 |
| scheduled live message | SSE admission point | scheduler through `paneAuthorityDispatchRef` | live cache | authority | session navigation / streaming |
| late view after deletion | request before delete | rejected before pane commit | deletion guard rejects cache writes | terminal deletion guard | deleted Session cannot return |

The table records the existing behavior. It is not a license for future direct dispatches.

## 4B.1 result

The New-session first-prompt path formerly combined a captured `navigationEpoch` with `draftAuthorityCanCommit()`. The latter already checks the same epoch, draft generation, committed revision, and draft identity. The redundant local epoch capture and comparison were removed. No authority fields were removed or merged.

4B.2 closes two feedback-only gaps without changing the three authority fields: `schedulePromptReconcile()` now requires its captured authority in both success and failure continuations, and `tryAutoAllowGate()` captures/receives pane authority so its asynchronous success or error toast cannot cross an A to B or A to B to A pane replacement.

The remaining combinations of `paneAuthorityCanCommit()` with `sessionEventVersionRef` are intentional cross-domain checks: Pane authority decides whether a result may paint; Session data revision decides whether an older HTTP view may overwrite newer SSE/cache facts.

## 领域二：Session data revision

这些值回答某一 Session 数据快照是否仍可接受，不决定当前 pane 是否可写。

| 字段或 token | 创建/递增者 | 读取者 | 防止的竞态 | 领域 | 覆盖 |
|---|---|---|---|---|---|
| `sessionEventVersionRef` | 已准入、会使 view 失效的 SSE frame 递增 | bootstrap/view/prompt/takeover reread | 旧 HTTP view 覆盖新 SSE control、queue、terminal 或 lifecycle overlay | Data | cache navigation、control SSE、prompt/takeover tests |
| `SessionViewCache` revision | authoritative store / transient patch | `revisionFor`、`mergeNavigation` | navigation 或 pagination 结果丢弃请求期间的新 overlay | Data | `session-view-cache.test.ts` navigation / overlay cases |
| `requestStartRevision` | navigation、pagination request 发起时 | `mergeNavigation` | 返回 view 抹去 request 后的 transient fields | Data request authority | navigation / pagination regressions |
| `requestVersion` | view/pagination/prompt reread 发起时读取 event version | response continuation | 旧 HTTP response 绘制或确认新 SSE 前状态 | Data request authority | stale view / terminal tail cases |
| `loadingEarlierRequestsRef` Symbol token | 每个 pagination request | catch/finally | 旧 pagination request 清掉新 request 的 loading state | Request-local | old history request revisit |
| `AbortController`（navigation） | 每次 navigation | fetch、finally | 已取消网络请求继续占用；不能单独授权 response | Request-local cancellation | navigation switching |
| `AbortController`（pagination） | 每个 pagination request | fast/JSONL request | 用户离开后的历史读取继续进行 | Request-local cancellation | isolated history |
| `refreshEpochRef` | refresh 开始、New 时递增 | bootstrap continuation | 较早 global refresh 安装 metadata | Global refresh request authority | bootstrap/reconnect tests |
| `draftWorkspacePickerTokenRef` Symbol | native picker 发起时 | picker result | 旧系统 picker 回调影响更新的 picker request | Request-local | stale draft workspace picker |

`SessionViewCache` 已集中 authoritative view、navigation merge、terminal tail、control overlay、queue overlay 与 commands omission 的数据优先级。4C 才能进一步收敛其调用形态；4A/4B.1 不改变这些 merge 规则。

## 领域三：Runtime provenance

这些值回答事件、stdout、exit 或 RPC response 是否来自当前绑定的 child；不授权浏览器 pane，也不定义缓存 merge 优先级。

| 字段 | 创建/递增者 | 读取者 | 防止的竞态 | 领域 | 覆盖 |
|---|---|---|---|---|---|
| `PiRpcClient.sourceGeneration` / `currentGeneration()` | 每次 child spawn | RPC data、exit handling、app/pool binding | 旧 child 解析 current request 或发布 lifecycle data | Runtime | RPC stale child tests |
| `SecondaryRuntime.rpcGeneration` | start/recover 后绑定当前 RPC generation | secondary event、settlement drain | reclaim/recovery 前 child 事件或 response 影响 replacement | Runtime | reclaimed Runtime late event tests |
| `primaryRpcGeneration` | `bindPrimaryIdentity` 后绑定当前 Primary child | Primary event、settlement drain | 未经 `get_state` 绑定或旧 Primary child 事件归属当前 Session | Runtime | Primary recovery / binding tests |
| `primaryBoundSessionId` | Primary identity bind | Primary event、settlement drain | Primary event 写到不再绑定的 Session | Runtime binding | Primary Session tests |
| server `runEpoch` | Pi Chat process construction | browser event admission、prompt busy release | 旧 server epoch 的 SSE frame 影响 replacement process | Runtime event provenance | event epoch handling |
| `runGenerationsBySession` | server `agent_start` | emitted event tagging、browser run tracking | 同 Session 较早 turn lifecycle 覆盖较新 turn | Runtime run provenance | concurrent/reclaimed runtime tests |
| browser `runEpochRef` | SSE ready frame | browser event admission / busy leases | old process event resolves new browser work | Runtime event provenance | reconnect/restart behavior |
| browser `sessionRunGenerationsRef` / `settledRunGenerationsRef` | admitted SSE lifecycle frames | browser event filter | settled generation 的 delayed tool/status frame repainting active state | Runtime run provenance | terminal lifecycle tests |
| `abortGeneration` / scheduler captured generation | abort and queued dispatch | prompt scheduler before/after RPC steps | abort/requeue races continue a cancelled turn | Runtime operation provenance | queue/abort tests |
| `OperationAdmission.generation` | close-and-drain | reopen operations | old close completion reopens newer admission state | Runtime lifecycle | admission/reclaim tests |

Runtime cwd is an immutable binding invariant rather than a revision: Primary uses `primaryRuntimeCwd`; every `SecondaryRuntime` stores its own `cwd`; `PiRpcClient.restart` rejects retargeting a live process. These protect provenance and must not be merged with the three browser authority fields.

`src/server/runtime-event-transition.ts` is not another provenance authority. It receives only an already provenance-validated event and derives common event-visible fields plus declarative effects. Primary/Secondary binding checks, RPC child generations, timers, snapshot warming, draft finalization, and FIFO settlement barriers remain owned by `PiChatApp` and its Runtime services.

## Classification result

No listed field is currently both the sole authority for two domains. The apparently similar values intentionally differ:

- `navigationEpochRef`, `paneCommitRevisionRef`, and `draftGenerationRef` protect cancellation/intent, committed pane replacement, and successive drafts respectively.
- `sessionEventVersionRef` and cache revision protect data freshness; they supplement rather than replace Pane authority.
- RPC generation, run epoch, run generation, and admission/abort generations protect child/process provenance and lifecycle.
- Symbols and `AbortController` values identify or cancel individual requests; they are not monotonic cross-request revisions.

Accordingly, 4B.1 stops after removing the one duplicate new-draft epoch comparison. Deleting or combining any further field requires the domain-specific behavior tests listed above plus a separately approved 4B, 4C, or 4D change.
