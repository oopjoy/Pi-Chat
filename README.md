# Pi Chat

Pi Chat 是一个独立、轻量、local-first 的 Pi Web 聊天客户端。它不嵌入完整 Pi SDK，而是启动全局安装的 `pi --mode rpc`，通过本地 HTTP API 与 SSE 将 Pi 的会话和流式事件连接到浏览器。

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
- 长会话初始仅渲染最近 20 个用户发起的完整对话轮次（包含该轮后续回复与工具过程）；侧栏会话元数据使用持久化索引缓存，变更时增量更新
- 对话右侧提供首条、上一条、下一条、最新的四格导航
- 固定铺满动态视口，兼容窗口最大化/还原、Windows DPI、页面缩放和窄窗口
- 左侧“浏览工作目录”会弹出前台 Windows Explorer 文件夹窗口，可预览、浏览并选择本地目录；支持目录持久化，并按工作目录筛选 Sessions
- 历史会话列表、切换和新建；服务启动后会在后台顺序预热最近 3 个历史会话，历史会话的独立 Pi worker 空闲 10 分钟自动回收，最多保留 3 个空闲 worker，超限时按最近使用时间回收
- 会话级 Todo：Pi Chat 首次启动会安装随附的标准 Pi Todo Extension，提供 `/todo` 与 `todo add / toggle / clear / list`；状态由 Extension 写入真实 Session JSONL，网页面板只读显示
- 文件权限 Gate：首次启动按需安装随附的标准 Pi Gate Extension；顶栏可切换“严格 / 仅一次 / 放行”，写入、编辑和危险 Bash 的 Allow / Block 仍由 Pi Extension 实际执行
- 侧栏提供独立的刷新会话列表和重启 Pi RPC 按钮；重启不会删除 Session JSONL 或聊天记录，并在生成、排队或等待权限确认时禁止操作
- 外观设置：主题、字体、字号、行距和对话宽度
- 可用模型列表、Models 面板与模型切换；支持基于 `~/.pi/agent/models.json` 的自定义模型 Add/Remove
- 顶栏 Thinking 强度切换
- 固定左右布局的设置窗口：左侧依次为外观、Models、Skills、Extensions、Packages；顶栏模型切换与侧栏 Models 快捷入口仍保留
- Skills、Extensions、Packages 按 Pi 原生资源层级分别呈现：资源只在对应能力页显示一次；包内 Extension 标注“由 Package 管理”，Package 页只显示来源与资源摘要
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

Windows 上构建后也可以双击 `start-pi-chat.cmd`，它会打开浏览器并启动服务。

首次启动时，Pi Chat 会将随附的 `pi-chat-todo.ts` 与 `pi-chat-file-permission-gate.ts` 按需安装到 `~/.pi/agent/extensions/`，因此迁移到新设备后无需另行寻找 Todo 或文件权限 Gate 插件。安装器不会覆盖已有的同名 Pi Chat Extension、旧版 `local-todo.ts` 或 `file-permission-gate.ts`；如果你已有第三方 `todo` 或 `gate` 工具，Pi 会继续以其加载顺序和行为为准。

## 安装为独立窗口应用

Pi Chat 保留普通浏览器访问，同时提供适合 Edge / Chrome 的独立窗口安装配置。启动服务后，用 Edge 或 Chrome 打开 `http://127.0.0.1:30170`，在浏览器菜单中选择“应用 / Apps → 将此站点安装为应用（Install this site as an app）”。

安装后会以独立 Pi Chat 窗口启动，不显示地址栏、标签页、书签栏或浏览器导航；普通浏览器访问仍然可用。该模式不使用 Service Worker，避免本地更新后被旧前端缓存遮挡。

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

基础版默认只监听 `127.0.0.1`。远程认证、HTTPS、CSRF/Origin 校验和访问审计尚未完成，请勿将当前版本直接暴露到公网。

Skills 可以向模型注入指令，Plugins/Packages 可以用当前用户的完整权限执行代码。安装来源必须可信；删除操作会在界面中二次确认。Skills/Plugins 配置变化后，Pi Chat 会重启 RPC 并恢复当前会话。
