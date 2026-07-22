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
- 长会话初始仅渲染最近 20 个用户发起的完整对话轮次（包含该轮后续回复与工具过程）；滚到顶部可点击“加载更早 10 轮”逐步展开历史；侧栏会话元数据使用持久化索引缓存，变更时增量更新
- 对话右侧提供首条、上一条、下一条、最新的四格导航
- 固定铺满动态视口，兼容窗口最大化/还原、Windows DPI、页面缩放和窄窗口
- 左侧“浏览工作目录”会弹出前台 Windows Explorer 文件夹窗口，可预览、浏览并选择本地目录；支持目录持久化，并按工作目录筛选 Sessions
- 历史会话列表、切换和新建；打开或查看历史只读取并缓存 JSONL，不启动 Secondary Runtime。发送、Compact、Model/Thinking 等实际操作才按需恢复 Runtime 并显示绿色就绪灯；最多保留 3 个空闲 Secondary Runtime，正在显示的历史仍可在空闲时被容量回收并自动退回 view-only
- 同一 Session 可在多个窗口观察，但同一时刻仅一个浏览器窗口可发送、停止、处理 Gate 或改队列；Model/Thinking 修改不会自动取得控制权，无 Owner 时可设置，存在其他窗口 Owner 时必须先显式接管
- 文件权限 Gate：作为 Pi Chat 内置安全功能呈现；顶栏可切换“严格 / 仅一次 / 放行”，随应用自动安装、校验和修复的极小 Pi 工具执行适配器仍会在真实工具执行前拦截写入、编辑和危险 Bash
- 侧栏提供独立刷新和“完整重启 Pi Chat 并应用更新”：应用级 Lifecycle Barrier 会在构建前同步阻止所有新写操作；新版本先在独立 staging 目录完成并验证，构建失败不会修改当前 `dist`，二次核验全部 Runtime、队列和确认状态通过后才提升产物并执行服务切换。维护期间历史、健康检查和只读 API 保持可用。设置中的“关闭 Pi Chat”同样先执行全局 Busy 检查，再关闭全部窗口、服务和托管 RPC
- 外观设置：主题、字体、字号、行距和对话宽度
- 可用模型列表、Models 面板与模型切换；支持基于 `~/.pi/agent/models.json` 的自定义模型 Add/Remove
- 顶栏 Thinking 强度切换
- 固定左右布局的设置窗口：左侧依次为外观、Models、Skills、Extensions、Packages；顶栏模型切换与侧栏 Models 快捷入口仍保留
- Skills、Extensions、Packages 按 Pi 原生资源层级分别呈现：资源只在对应能力页显示一次；包内 Extension 标注“由 Package 管理”，Package 页只显示来源与资源摘要。Model 变更和 Skill/Extension/Package 开关使用原子文件写入；Runtime Reload 失败时恢复原配置并尝试恢复旧 Runtime。目录树安装/卸载不执行自动删除式回滚
- 设置与 Models 使用居中 Windows 式小窗口
- Thinking 和工具调用折叠显示
- Pi 扩展的 select / confirm / input / editor 对话框
- 响应式桌面和移动端界面

## 环境要求

- Node.js 22.19 或更高版本
- 已全局安装并完成模型认证的 Pi：`pi --version`

## 开发

如果环境设置了 `NODE_ENV=production`，安装时需要显式包含开发依赖：

```bash
npm install --include=dev
npm run dev
```

默认地址：`http://127.0.0.1:30170`，新会话默认使用当前用户主目录作为工作目录。

Windows 上可在项目目录运行 `npm run install:shortcuts`（或运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1`）动态安装两个桌面快捷方式：**Pi Chat** 直接打开已安装的 Edge PWA，**Pi Chat Web** 使用默认浏览器打开普通网页。快捷方式始终指向当前项目目录，不包含开发者机器路径；移动项目后请重新运行安装脚本。两者都会显示统一启动浮窗并按需启动 `127.0.0.1:30170`；启动失败时浮窗会保留并提供日志。兼容入口 `start-pi-chat.cmd` 等同于 Web 快捷方式，也可手动运行 `pi-chat-launch.cmd web` 或 `pi-chat-launch.cmd pwa`。

Pi Chat 不提供 Todo 功能，也不会安装或管理 Todo Extension。历史 Session JSONL 中已有的 Todo 快照会保留为历史记录，但不会再注册 `/todo` 命令或 `todo` 工具。

文件权限 Gate 会安装为 Pi Chat 的系统安全执行组件 `pi-chat-file-permission-gate.ts`：它会在每次启动时校验完整性、自动修复并强制启用，且不在普通扩展管理中显示。若旧版 `file-permission-gate.ts` 与 Pi Chat 原组件等价，会安全改名为 `.pi-chat-legacy-disabled` 备份以避免重复注册 `/gate`；自定义旧 Gate 绝不会被覆盖，Pi Chat 会报告冲突并拒绝启用新的系统组件。

## 安装为独立窗口应用

Pi Chat 保留普通浏览器访问，同时提供适合 Edge / Chrome 的独立窗口安装配置。启动服务后，用 Edge 或 Chrome 打开 `http://127.0.0.1:30170`，在浏览器菜单中选择“应用 / Apps → 将此站点安装为应用（Install this site as an app）”。

安装后会以独立 Pi Chat 窗口启动，不显示地址栏、标签页、书签栏或浏览器导航；普通浏览器访问仍然可用。该模式不使用 Service Worker，避免本地更新后被旧前端缓存遮挡。关闭浏览器窗口不会停止后台 Pi Chat 服务；请使用设置中的“关闭 Pi Chat”，或通过桌面的 **Pi Chat** / **Pi Chat Web** 重新启动。源码工作目录的启动器会先构建本地改动；Windows Release ZIP 已内置干净的编译产物，不需要 npm、源码或构建工具即可启动。

## 构建与运行

```bash
npm run build
npm start
```

可选参数：

```bash
node dist/server/server/index.js --host 127.0.0.1 --port 30170 --cwd C:\\work
```

也可以使用环境变量：`PI_CHAT_HOST`、`PI_CHAT_PORT`、`PI_CHAT_CWD`。如果无法自动发现全局 Pi，可设置 `PI_CHAT_PI_ENTRY` 指向 Pi 的 `dist/rpc-entry.js`。

## 安全说明

基础版只监听本机回环地址（默认 `127.0.0.1`）。每次服务启动会轮换内存请求 token，并校验精确 Host、同源 Origin 与 token，阻止普通跨站网页调用本机 Pi 接口。启动时还会探测 Pi RPC 的必要能力；若 Pi 升级导致协议不兼容，服务会给出明确错误而不是带着部分失效功能启动。文件权限 Gate 的执行钩子虽然技术上运行于 Pi Extension API，但由 Pi Chat 自动管理、不可通过普通扩展列表停用或移除；这确保网页 UI 保持内置体验，同时真实工具调用前仍有可靠拦截。

网页 UI 使用本机文件夹选择器 `POST /api/workspace/pick`。`POST /api/workspace/set` 是本地/自动化工作目录切换入口（例如脚本或后续本机 CLI），不是远程访问能力。当前版本不提供远程多用户、HTTPS 公网暴露或跨机器访问；请勿将服务绑定到非回环地址或暴露到公网。

Skills 可以向模型注入指令，Plugins/Packages 可以用当前用户的完整权限执行代码。安装来源必须可信；删除操作会在界面中二次确认。Skills/Plugins 配置变化后，Pi Chat 会重启 RPC 并恢复当前会话。

## 产品边界

**Pi Chat 负责：** 会话展示与输入、本地 Session 切换、Runtime 按需启动与回收、多窗口控制权、Gate/确认交互、Pi 原生资源的有限管理，以及本地 Web/PWA 启动体验。

**Pi Chat 不负责：** 重写 agent loop、模型和工具执行、自建插件运行时、Electron 桌面壳、远程多用户服务、公网部署，或通用 agent 编排平台。

**当前不在路线图的伪需求：** 远程访问。代码与文档中可预留扩展点，但 0.2.x 不做半成品远程开关。若未来需要，应作为独立设计（认证、HTTPS、审计）而不是放开监听地址。

更完整的模块边界与拆分优先级见 `docs/architecture.md`。
