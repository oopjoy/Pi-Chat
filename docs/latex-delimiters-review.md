# LaTeX 反斜线分隔符修复 — 独立审核

- 工作区：`D:\Pi-Chat-math-fix`
- 分支：`fix/latex-delimiters`
- 基线：main `ece2ed4`
- 不包含 `feat/deployment-p0` 的部署改动；未合并、推送或部署，也未停止原服务。

## 问题确认

该会话的只读文本响应中仍有成对的 `\(...\)` 和 `\[...\]`，不是简单的 JSON 把所有反斜线都吃掉。现有 `remark-math` 管线识别美元分隔符，却没有先识别 LaTeX 的反斜线分隔符。

因此 CommonMark 会把 `\[` 处理成普通 `[`，正文中的 `\frac` 等命令不能进入 KaTeX。公式中单独一行的 `=` 还可能被当成 Setext 标题标记，造成截图中的粗体大字。

已先添加最小回归并在旧代码复现：预期 4 个 KaTeX 节点，实际 0 个。测试使用人工最小公式，不包含真实聊天记录或用户文档。

## 改动

1. 新增 `markdown-latex-delimiters.ts`，在原有渲染准备阶段之后，将配对反斜线分隔符转换为 remark-math 可处理的形式。
2. 借助 Markdown AST 的原始位置排除代码、链接、HTML 标签及已有美元公式，避免简单全局正则替换。额外保护常见裸 URL、Windows 路径和原始 code/pre/script/style 内容。
3. 支持行内、独立行间、同一行 display、列表/引用、TeX 换行与正文中的美元字符；GFM 表格使用行内数学形式。
4. 新坐标映射与既有 display-normalization 映射组合，终态选中公式复制保留原始反斜线分隔符、空格和 CRLF。相邻公式使用仅在渲染副本中的不可见注释防止美元分隔符合并，不向复制结果插入不可见字符。
5. 流式分段使用同一范围扫描器；空行和普通正文的 tail-size cap 不会截断未完成公式。普通非数学长文本仍沿用原分段规则。

所有变换只发生在渲染副本。没有修改 Session JSONL、模型输出、请求载荷、KaTeX trust/sanitize 配置或 Pi Runtime。

未配对的分隔符不猜测补全；它们保留为字面量，并在标题/代码围栏处结束待定范围，行内待定范围不能越过空白段落。未知 LaTeX 命令仍由 KaTeX 报错，本补丁不是通用 TeX 编译器。

## 验证

- Markdown 相关聚焦测试 **38/38 通过**：数学渲染、源码复制、流式分段、代码/链接保护、CRLF/emoji、GFM 表格、相邻公式及长公式分段。
- TypeScript、type-debt guard 通过；Lint 0 errors / 1328 warnings，与基线数量相同。
- 对该会话返回的含公式文本做了只读、内存中的离线渲染验证，KaTeX error 节点为 0；没有把会话文本保存为测试夹具。
- 完成隔离生产构建和完整 Playwright 尝试。新用例验证了真实 Chromium 中的数学节点、标题、表格、代码字面量，并在桌面验证 Ctrl+C 得到原始 `\(\psi\)`。
- 新浏览器用例初次失败源于测试代理 `route.fetch()` 未携带同源 Origin，已修正测试请求；没有放宽服务安全校验。

### 全量门禁仍未全绿

- `verify:unit` 在 batch 18 遇到既有 Runtime capacity 测试同一断言失败。上一轮部署工作已在未修改的 detached 基线复现。本分支不改该测试或 RuntimePool。
- 后续 source batch 19/20 已补跑，分别 109 / 103 通过；完整 benchmark lane 34/34 通过。
- 最终完整 E2E：9 通过、21 失败，失败均涉及 Windows 临时根目录 `EBUSY` 清理；新增桌面/移动数学用例的功能断言已完成，但整条用例仍按清理失败记录。
- 初轮完整 E2E 还出现此前已有的 Files/Changes 拖拽高度断言失败，不能仅因后次未出现就认定该问题解决。

本修复不能据此标记为已通过全部发布门禁。没有通过重试参数、删除测试或放宽断言来掩盖失败。

## 本机证据

日志位于 `%LOCALAPPDATA%\Temp`：

- `pi-chat-math-focused-final.log`
- `pi-chat-math-lint.log`
- `pi-chat-math-unit-RonhPM.log`
- `pi-chat-math-remaining-MtQ6F9.log`
- `pi-chat-math-e2e-D5nhcC.log`（首次浏览器定位）
- `pi-chat-math-e2e-final-WbumTR.log`（最终完整运行）

浏览器 trace 保留在工作区 `test-results/` 和 `dist-local/math-browser-focused/`。

## 审核 / 应用边界

```powershell
cd D:\Pi-Chat-math-fix
git diff main...fix/latex-delimiters
npm run test:focus -- --file tests/latex-delimiters.test.ts --file tests/markdown-source-copy.test.ts --file tests/streaming-markdown.test.ts --file tests/markdown-local-links.test.ts
```

当前 `127.0.0.1:30170` 仍是旧构建，普通刷新或重启电脑不会使未部署的补丁生效。审核并构建部署后，已有聊天记录可直接按新规则重新渲染，不需要重新生成回复或改写历史。
