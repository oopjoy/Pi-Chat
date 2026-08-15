# Pi Chat

Pi Chat 是一个连接本机 Pi RPC 的 local-first Web/PWA 客户端。它提供浏览器中的聊天、会话管理与本地运行协调，不替代 Pi 的 agent、模型、工具或扩展内核。服务启动全局安装的 `pi --mode rpc`，通过本地 HTTP API 与 SSE 连接浏览器；不捆绑 Electron/Chromium，也不嵌入完整 Pi SDK。

## 当前基础版

- 用户输入、可靠停止生成，以及生成中的可撤销 Follow-up 队列
- Pi 模型流式输出
- 发送按钮旁统一 `＋` 附件入口：图片与本地文件
- 图片支持选择、粘贴、拖入、预览和视觉模型输入
- 普通文件通过 Windows 原生选择器或资源管理器复制粘贴获取绝对路径，只引用路径并由 Pi 工具按需读取
- Pi 扩展命令、Prompt Templates、Skills 与常用内置命令的 `/` 指令联想
- Extension 状态命令立即执行并仅显示通知，不写入对话或 Follow-up 队列
- Markdown、GFM 与 KaTeX
- 选中渲染内容时复制原始 Markdown / LaTeX
- Pi-web 风格的可收起会话侧栏、New 和刷新
- 当前 Session 若有 `pi-subagents` 后台步骤，顶栏显示紧凑的“N 个子代理”只读入口：仅投影安全别名、生命周期、耗时/更新年龄和有界计数，不把子 Session 加入左侧会话，也不提供启动、Steer、恢复、中断或停止操作；弹层会明确提示 Composer 下方 Queue / Steer 仍只控制主 Session
- 长会话初始仅渲染最近 20 个用户发起的完整对话轮次（包含该轮后续回复与工具过程）；滚到顶部可点击“加载更早 10 轮”逐步展开历史；侧栏会话元数据使用持久化索引缓存，变更时增量更新
- 对话右侧提供首条、上一条、下一条、最新的四格导航
- 固定铺满动态视口，兼容窗口最大化/还原、Windows DPI、页面缩放和窄窗口
- Session-first 历史会话列表、切换和新建：服务与界面先打开、读取并缓存 JSONL；Primary 会在后台启动并完成兼容性验证，未 ready 或验证失败时历史仍可浏览且不会探测 Primary RPC。选中、滚动、搜索或切换冷历史只读取 JSONL，不启动 Secondary Runtime；只有发送、Compact、Model/Thinking、接管或显式启动 Pi 等实际操作才会为该 Session 单飞准备专属 Runtime。服务的默认工作目录保持固定；需要不同目录时，在创建该条 New 草稿后使用“新对话工作路径”选择器单独修改，不会影响其他对话。新对话首条消息将 Runtime 创建、Model、Thinking、Gate 与 prompt 合并为一个服务事务。最多 5 个热对话（Primary + 4 个 Secondary），达到容量时优先 LRU 回收空闲 Secondary，正在显示的历史也可退回 view-only
- 同一 Session 可在多个窗口观察，但同一时刻仅一个浏览器窗口可发送、停止、处理 Gate 或改队列；Model/Thinking 修改不会自动取得控制权，无 Owner 时可设置，存在其他窗口 Owner 时必须先显式接管
- 文件权限 Gate：作为 Pi Chat 内置安全功能呈现；顶栏可切换“严格 / 放行”。严格模式始终确认 `write` / `edit`，并对可识别的高风险 Bash 做辅助确认；Bash 可运行任意脚本，副作用识别不构成完整 sandbox。随应用自动安装、校验和修复的极小 Pi 工具执行适配器仍在真实工具执行前运行
- 侧栏提供独立刷新和“完整重启 Pi Chat 并应用更新”：应用级 Lifecycle Barrier 会在构建前同步阻止所有新写操作；新版本先在独立 staging 目录完成并验证，构建失败不会修改当前 `dist`，二次核验全部 Runtime、队列和确认状态通过后才提升产物并执行服务切换。维护期间历史、健康检查和只读 API 保持可用。网页与服务的 build identity 不一致时，普通修改会暂停，但“完整重启”与设置中的“关闭 Pi Chat”仍可请求服务端执行其最终 Busy 检查，避免客户端恢复路径被旧页面状态锁死。SSE/EventSource 是可重连传输，断开不会自动关闭 Pi Chat 服务或托管 RPC；但全部浏览器/PWA 页面都通过非 BFCache 关闭明确离开后，服务会等待生成、队列、确认、恢复、Runtime transition 与 mutation 全部结束，并连续空闲 $10$ 秒后自动退出。设置中的“关闭 Pi Chat”仍可显式立即请求关闭，并同样先执行全局 Busy 检查
- 外观设置：主题、字体、字号、行距和对话宽度
- 设置中的“诊断”可一键导出最近五分钟的服务端/当前浏览器页面结构状态时间线，用于复现 Runtime、SSE 实际投递、Sidebar、Composer、多窗口控制与队列投影不一致；两条时间线始终在内存中有界保留，不需要预先开始录制，也不拥有窗口或 Session 控制权。普通累计流式更新不会逐帧入库，而只在有界计数器中汇总 SSE 调度、背压、无客户端、超限替代、写错误与浏览器调度结果；可见当前 Pane 的首个 Assistant 提交仅通过双 `requestAnimationFrame` 记录一次绘制机会（不代表物理显示或首 token）。排队 Prompt 只复用既有公开 Queue ID，立即发送 Prompt 的诊断 UUID 仅存在于服务内存，最终文件对 Session 与全部 Prompt 关联统一使用一次性别名，且不包含请求 token、聊天/草稿正文、图片、文件路径、密钥或原始错误堆栈
- 可用模型列表、Models 面板与模型切换；支持基于 `~/.pi/agent/models.json` 的自定义模型 Add/Remove
- 顶栏 Thinking 强度切换
- 固定左右布局的设置窗口：左侧依次为外观、Models、Skills、Extensions、Packages、诊断；顶栏模型切换与侧栏 Models 快捷入口仍保留
- Skills、Extensions、Packages 按 Pi 原生资源层级分别呈现：资源只在对应能力页显示一次；包内 Extension 标注“由 Package 管理”，Package 页只显示来源与资源摘要。Model 变更和 Skill/Extension/Package 开关使用原子文件写入；Runtime Reload 失败时恢复原配置并尝试恢复旧 Runtime。目录树安装/卸载不执行自动删除式回滚
- 设置与 Models 使用居中 Windows 式小窗口
- Thinking 和工具调用折叠显示
- Pi 扩展的 select / confirm / input / editor 对话框；模型可见的澄清类 Extension 可复用同一条 Session 控制、恢复和响应通道
- 响应式桌面和移动端界面

## 环境要求

- **Node.js** 22.19 或更高版本（用来运行 Pi Chat 本地服务）
- **已全局安装并完成模型认证的 Pi**：`pi --version`  
  Pi Chat **不会**内置 Pi 内核；服务会在后台拉起本机全局的 `pi --mode rpc`。Pi 尚未就绪时，已保存的 Session JSONL 仍可浏览；发送或其他需要 Pi 的操作会提示 Runtime 不可用。
- Windows 桌面快捷方式可选；Edge PWA 仅影响独立窗口体验，不是硬性依赖

### 没有安装 Pi 时会发生什么？

双击或运行 `start-pi-chat.cmd`、`pi-chat-launch.cmd`、桌面 **Pi Chat / Pi Chat Web** 时：

1. 启动器先尝试用 **Node** 启动本机 `http://127.0.0.1:30170` 服务；
2. 服务先开放 Session JSONL 浏览，再在后台查找全局 Pi 的 `rpc-entry.js`、启动 RPC 并验证协议能力；
3. **找不到 Pi 或兼容性验证失败**时，已保存的历史仍可查看，但发送、运行指令和其他 Runtime 操作会稳定返回“Pi Runtime 不可用”，不会通过隐式重启绕过兼容性验证。找不到 Pi 时会显示：
   `找不到全局 Pi。请先安装 Pi，或设置 PI_CHAT_PI_ENTRY 指向 dist/rpc-entry.js。`
4. 表现：
   - **带启动浮窗**（桌面快捷方式 / `start-pi-chat-ui.ps1`）：浮窗在服务可浏览时关闭；Pi Runtime 的后续失败记录在 server 日志；
   - **直接跑 cmd**：浏览器仍可打开本地历史；详细 Runtime 错误在 server 的 stderr 日志。

若要聊天或运行工具，请安装并配置好 Pi。可选环境变量：`PI_CHAT_PI_ENTRY` 指向 Pi 的 `dist/rpc-entry.js`。

### 可选：让模型在歧义处暂停提问

Pi Chat 会原样承载 Pi RPC 的 `select`、`confirm`、`input` 与 `editor` Extension UI。可选安装已验证支持 RPC dialog fallback 的 `ask_user_question` Package：

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
```

安装后对目标 Runtime 执行 `/reload`，或在没有进行中对话、队列及确认时正常重启 Pi Chat。原生 Pi 终端显示 Package 的完整多题 TUI；Pi Chat 会从 `ask_user_question` 工具调用投影出同一份多题问卷：单选后自动进入下一题，多选保留“下一个”，自由输入直接展开在对应选项行并可按 Enter 前进，最后一题完成后才开放“提交”，同时保留“上一个”用于修改答案。提交时 Pi Chat 仍通过 Package 现有的 Session-scoped `select` / `input` RPC 请求逐步回送已确认答案，不会伪造新的用户 Prompt，也不会改变 request ID 或 Session/control authority。若页面在工具开始事件之后才恢复，无法重建完整问卷时会安全退回原生标量 RPC 对话框。该 Package 是具有当前用户权限的第三方 Pi 扩展，不属于 Pi Chat 内置 Gate；安装前应审查并固定可信版本。

## 开发

首次参与请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，其中给出了 live `dist` 安全边界、focused/full 验证入口和单 writer 工作方式。

如果环境设置了 `NODE_ENV=production`，安装时需要显式包含开发依赖：

```bash
npm install --include=dev
npm run dev
```

默认地址：`http://127.0.0.1:30170`。没有已保存工作目录选择的新安装，New 草稿默认使用当前用户的桌面目录（Windows 下为 `C:\\Users\\<用户名>\\Desktop`）；`PI_CHAT_CWD` 或 `--cwd` 可提供启动回退目录，但已有的用户保存选择不会被自动覆盖。每个尚未提交的 New 草稿可单独修改其工作路径。

### 测试

快速聚焦验证通过 npm 别名直接进入官方 harness，不会触发 `npm test` 的 `pretest` 全量构建：

```bash
# --file 可重复，路径必须是仓库 tests/ 下已发现的 .test.ts
npm run test:focus -- --file tests/web/composer-capabilities.test.ts
# 文件与名称过滤可以组合；NODE_ENV=test 由 harness 负责设置
npm run test:focus -- --file tests/web/composer-capabilities.test.ts --test-name-pattern="slash suggestions"
```

阶段门禁使用自动隔离的系统临时 staging，不会写 live `dist`。成功后 staging 自动删除；失败时会保留并打印诊断路径：

```bash
npm run verify:unit
npm run verify:e2e
# typecheck → unit → e2e → git diff HEAD --check，全部串行
npm run verify
```

Harness 会递归发现 `tests/**/*.test.ts`，不会跟随测试目录中的符号链接；`--file` 同时接受 `/` 和 Windows `\\` 分隔符。使用 `--test-name-pattern` 时，Harness 会先确认所选文件中至少有一个可静态解析的具体测试名匹配，拼错名称会以状态码 `2` 失败。对于 `for...of` 字面量数组生成的模板名称，Harness 会展开为具体名称；其他无法静态解析的动态名称应先重写为明确测试声明。不要绕过 `scripts/run-tests.mjs` 直接调用 `node --test`。需要保留指定构建产物的发布验证仍应显式设置独立 `PI_CHAT_DIST_DIR`；普通贡献者验证优先使用上述 wrapper。少数安全边界测试需要 `NODE_ENV=test` 才能使用仅限 JSDOM 的 identity override；生产 Web artifact 不存在该 override。

修改现有功能前，可先查阅 [`docs/change-map.md`](docs/change-map.md)：它把常见改动映射到唯一状态所有者、epoch/generation 边界、关键不变量和聚焦测试入口。详细政策仍以对应架构文档为准。

## Windows 桌面快捷方式

仓库**不会**提交桌面上的 `.lnk` 文件（会写死本机路径，别人 clone 后失效）。请在**本机项目目录**生成：

```powershell
# 必须先进入含 package.json 的项目目录（不要在 C:\Users\你的用户名 下直接 npm）
cd C:\path\to\pi-chat

# 方式一：npm 脚本
npm run install:shortcuts

# 方式二：不依赖 npm 的 package 脚本名，直接跑安装脚本
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-shortcuts.ps1
```

会在当前用户桌面创建 / 更新两个快捷方式：

| 名称 | 行为 |
|---|---|
| **Pi Chat** | 打开已安装的 Edge PWA 独立窗口（`pwa`） |
| **Pi Chat Web** | 用默认浏览器打开普通网页（`web`） |

说明：

- 快捷方式始终指向**当前项目目录**的 `start-pi-chat-ui.ps1`，不写死别人的机器路径；**移动或重装项目后请重新运行安装脚本**。
- 两者都会显示统一启动浮窗，并按需启动 `127.0.0.1:30170`；启动失败时浮窗会保留并提供日志。
- 兼容入口：`start-pi-chat.cmd` 等同 Web；也可手动运行 `pi-chat-launch.cmd web` 或 `pi-chat-launch.cmd pwa`。
- **没有安装全局 Pi** 时的失败行为见上文「没有安装 Pi 时会发生什么」。

Pi Chat 不提供 Todo 功能，也不会安装或管理 Todo Extension。历史 Session JSONL 中已有的 Todo 快照会保留为历史记录，但不会再注册 `/todo` 命令或 `todo` 工具。

文件权限 Gate 会安装为 Pi Chat 的系统安全执行组件 `pi-chat-file-permission-gate.ts`：它会在每次启动时校验完整性、自动修复并强制启用，且不在普通扩展管理中显示。若旧版 `file-permission-gate.ts` 与 Pi Chat 原组件等价，会安全改名为 `.pi-chat-legacy-disabled` 备份以避免重复注册 `/gate`；自定义旧 Gate 绝不会被覆盖，Pi Chat 会报告冲突并拒绝启用新的系统组件。

## 安装为独立窗口应用

Pi Chat 保留普通浏览器访问，同时提供适合 Edge / Chrome 的独立窗口安装配置。启动服务后，用 Edge 或 Chrome 打开 `http://127.0.0.1:30170`，在浏览器菜单中选择“应用 / Apps → 将此站点安装为应用（Install this site as an app）”。

安装后会以独立 Pi Chat 窗口启动，不显示地址栏、标签页、书签栏或浏览器导航；普通浏览器访问仍然可用。该模式不使用 Service Worker，避免本地更新后被旧前端缓存遮挡。关闭最后一个浏览器/PWA 窗口会在所有工作完成后开始连续空闲 $10$ 秒的自动退出倒计时；刷新、BFCache、网络/SSE 断线，以及旧页面延迟发送的关闭通知都不会关闭替代页面或误触发服务退出。也可使用设置中的“关闭 Pi Chat”显式关闭，或通过桌面的 **Pi Chat** / **Pi Chat Web** 重新启动。源码工作目录的启动器会先构建本地改动；Windows Release ZIP 已内置干净的编译产物，不需要 npm、源码或构建工具即可启动。

## 构建与运行

```bash
npm run build
npm start
```

如果 `127.0.0.1:30170` 已有 Pi Chat 服务，`npm run build` 以及所有会写 live `dist/` 的组成命令（`clean`、`build:identity`、`build:web`、`build:server`、`copy:resources`）都会拒绝覆盖它正在提供的 `dist/`，防止旧服务混用新网页资源。请使用界面的“完整重启 Pi Chat 并应用更新”，或先关闭 Pi Chat；应用内重启会安全地在 staging 目录构建。桌面启动器也会将监听服务的 build identity 与本地 `dist/build-identity.json` 比较：若端口上是不同构建（可能是另一个 checkout 或安装），启动器只报告冲突并退出，绝不自动关闭或按端口/PID 强杀该实例；请在它自身窗口中显式关闭或切换后，再启动当前版本。构建保护默认检查 `127.0.0.1:30170`；若以非默认端口运行，请设置 `PI_CHAT_PORT` 为实际端口。

可选参数：

```bash
node dist/server/server/index.js --host 127.0.0.1 --port 30170 --cwd C:\\work
```

也可以使用环境变量：`PI_CHAT_HOST`、`PI_CHAT_PORT`、`PI_CHAT_CWD`。如果无法自动发现全局 Pi，可设置 `PI_CHAT_PI_ENTRY` 指向 Pi 的 `dist/rpc-entry.js`。

## 安全说明

基础版只监听本机回环地址（默认 `127.0.0.1`）。每次服务启动会轮换内存请求 token，并校验精确 Host、同源 Origin 与 token，阻止普通跨站网页调用本机 Pi 接口。后台子代理状态只从当前用户精确临时根下的 UUID run 目录读取普通 `status.json`，拒绝符号链接、越界大小/年龄/数量、未知状态与畸形字段，并且只有状态中的父 Session JSONL 路径与当前 SessionIndex 或已拥有 Runtime 的 Session 路径精确一致时才投影；cwd 从不作为归属证明，浏览器永远收不到 run/toolCall ID、路径、任务、输出、参数或原始错误。启动时还会探测 Pi RPC 的必要能力；若 Pi 升级导致协议不兼容，服务会给出明确错误而不是带着部分失效功能启动。文件权限 Gate 的执行钩子虽然技术上运行于 Pi Extension API，但由 Pi Chat 自动管理、不可通过普通扩展列表停用或移除；这确保网页 UI 保持内置体验，同时真实工具调用前仍有可靠拦截。

设置面板的“默认工作路径”可选择以后 New 草稿的默认目录；New 草稿中的“新对话工作路径”可只为该次对话另选目录。两者只更新未来草稿和目录索引上下文，绝不会重启、重绑或改变任何活 Runtime 的真实 cwd。`POST /api/workspace/set` 仅保留给本地自动化或未来本机 CLI，不是远程访问能力。当前版本不提供远程多用户、HTTPS 公网暴露或跨机器访问；请勿将服务绑定到非回环地址或暴露到公网。

Skills 可以向模型注入指令，Plugins/Packages 可以用当前用户的完整权限执行代码。安装来源必须可信；删除操作会在界面中二次确认。Skills/Plugins 配置变化后，Pi Chat 会重启 RPC 并恢复当前会话。

## 产品边界

当前功能入口、保留的本地 API 与已删除能力，以 [`docs/feature-surface.md`](docs/feature-surface.md) 的清单为准。标记为已删除的能力不得只保留隐藏路由、浏览器包装、共享类型或专用回归测试。

**Pi Chat 负责：** 会话展示与输入、本地 Session 切换、Runtime 按需启动与回收、多窗口控制权、Gate/确认交互、Pi 原生资源的有限管理，以及本地 Web/PWA 启动体验。

**Pi Chat 不负责：** 重写 agent loop、模型和工具执行、自建插件运行时、Electron 桌面壳、远程多用户服务、公网部署，或通用 agent 编排平台。

**当前不在路线图的伪需求：** 远程访问。代码与文档中可预留扩展点，但 0.4.x 不做半成品远程开关。若未来需要，应作为独立设计（认证、HTTPS、审计）而不是放开监听地址。

## 兼容的 Pi 版本

- **已验证：** Pi `0.84.2`（全局 `@earendil-works/pi-coding-agent`；包含 `ask_user_question` RPC dialog fallback 冒烟验证）
- **探测方式：** Primary 在后台执行一次针对当前本机 Pi entrypoint 的 RPC 能力探测（`get_state` / `get_messages` / `get_available_models` / `get_commands` / `get_session_stats`）。不兼容时 Session 浏览继续可用，而新的或需要恢复的 Runtime 写操作返回明确的不可用状态；已经健康的 Secondary 保持可用。任何 Primary 恢复都会重新探测
- 升级 Pi 后若启动失败，请先 `pi --version`，再确认 Pi Chat 是否为最新 0.4.x

更完整的模块边界与拆分优先级见 `docs/architecture.md`；日常维护入口见 [`docs/change-map.md`](docs/change-map.md)。
