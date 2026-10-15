# Web Visual Language — 0.5.x 分批体验打磨规则

适用范围：`src/web/` 全部界面样式与组件呈现层。本文件是 0.5.x 各批 UI 打磨的**唯一规则来源**，先立规则、再动组件；每批改动必须在规则内完成，不新增规则外数值。

原则（来自 2026-10-15 审核结论）：

1. 借鉴 Inspire 的**视觉语言**，不照搬其信息架构；Pi-Chat 保持"Sessions + Conversation + Composer"的轻量布局，不扩展成工作台。
2. 只做视觉一致性与状态表达优化，**不改发送/停止/队列/模型/Gate 的语义**，不创建第二套状态权威（presentation model 仍由既有 `conversation-process` 等投影层承担）。
3. 颜色是信号不是装饰；能用 typography/weight/opacity 表达的状态不加颜色。
4. 事实不能失真：辅助信息降权但必须可读、可访问；失败、待确认、危险操作保持醒目；不得把"已受理"显示成"已完成"。

---

## 1. Spacing 档位

新增/修改样式一律使用 `--space-*` token，不再手写新数值：

```css
--space-1: 4px;   /* 图标与文字贴合、极小间隙 */
--space-2: 6px;   /* 行内元素间距 */
--space-3: 8px;   /* 组件内 padding、行内分组 */
--space-4: 12px;  /* 组件内主 padding、相邻小组件间距 */
--space-5: 16px;  /* 组件间间距 */
--space-6: 24px;  /* 大区域分隔 */
--space-7: 32px;  /* 页面级留白 */
```

规则：

- 档位之外的 px 值（如 7px、11px、13px）属于**历史遗留**，触碰到该行的改动应顺手收敛到最近档位；不要求一次全局替换，也不禁止光学校正（图标与文字对齐、1px 边框补偿）保留有注释的例外。
- 语义用负值时通过 `calc(var(--space-1) * -1)` 表达。
- 行高、字体大小不在本节范围。

## 2. Typography 角色

只用 6 个字体角色（通过 `--font-*` + weight/opacity 组合，不新增字号种类）：

| 角色 | token | 大小/行高 | weight | 颜色 |
|---|---|---|---|---|
| 正文 | （阅读字体） | `var(--reading-font-size)` / 1.66 | 400 | `--text` |
| 控件文字 | `--font-ui` | 12px / 1.45 | 500 | `--text` |
| 标签/标题行 | `--font-ui` | 13px / 1.4 | 600 | `--text` |
| 元信息 | `--font-ui` | 11px / 1.4 | 450 | `--muted` |
| 微元信息 | `--font-ui` | 10px / 1.35 | 450 | `--muted`（可再降 opacity 至 .85） |
| 等宽（路径/代码/ID） | `--font-mono-ui` | 11px / 1.45 | 450 | `--muted` |

规则：

- 新样式不再引入 9px、10.5px、11.5px、12.5px、13.5px 等中间字号；遇到时收敛到上表。
- 层级优先用 weight（450/500/600/650）与 `--muted`/opacity 区分，而不是新增字号。
- `letter-spacing` 仅允许正文区既有值与 `0.01em`（等宽标签）两种。

## 3. 尺寸与圆角

```css
--control-h: 28px;      /* composer 工具行按钮/select 触发器 */
--control-h-lg: 32px;   /* 主要操作按钮、菜单触发 */
--radius-sm: 6px;       /* 菜单内条目、小徽标 */
--radius-md: 8px;       /* 控件、输入、session 行 */
--radius-lg: 11px;      /* 卡片级容器（composer、浮层） */
```

- 圆角收敛目标：5/6→sm，7/8/9/10→md，11/12/14→lg；`50%`（圆点/圆钮）与 `999px`（胶囊）保留。
- `--control-h` 系列用于新代码；存量 29/30/31px 触发高度在触碰到时收敛。

## 4. 颜色纪律

- 底色只用 `--page / --surface / --surface-soft / --surface-hover`；卡片默认**无框或 1px `--line`**，仅可操作/错误/代码区保留强边界。
- accent 仅用于：焦点、选中、主操作、进行中状态、链接。同一屏 accent 元素 ≤ 2 类。
- 状态色仅用于状态点/图标/边框，不再作为大面积背景（`--accent-soft` 行选中背景除外）。
- 现存硬编码色值（`#c99110` 等）触碰到时改为语义 token 或注释保留理由。

## 5. 状态表达（transient state 呈现规则）

一致性指的是**位置与规则**，不是把状态都压成一个转圈：

- 会话级状态 → Session 行右缘固定槽（现状保留）。
- 发送/等待/失败 → composer 上方 `.system-notice-stack` / `.composer-submission-status`。
- 过程状态 → 过程卡片 summary 行（折叠时只显示状态 + 摘要）。
- 用户语言映射保持"简洁不失真"（如"正在核实发送结果，请勿重复发送"），禁止假进度。
- 进行中可动画（刷新环/脉冲）；已完成一律静止，靠 weight 与 muted 区分层级。

## 6. 交互细节

- hover/focus 统一：`.12s ease` 背景/边框过渡；focus-visible 必须有可见焦点（沿用既有 outline/box-shadow 规则）。
- 不逐 token 动画；遵守 `prefers-reduced-motion`（既有规则不删）。
- 展开状态由用户掌控：流式更新不强制折叠、不抢焦点、不跳滚动位置。

---

## 分批计划（每批独立提交 + 验收）

| 批次 | 范围 | 验收 | 状态 |
|---|---|---|---|
| **A** | 规则落地 token；Composer 行（toolbar/actions 密度与对齐、发送区主次）；Session 行（行高/padding/元信息字号收敛） | 截图矩阵 | ✅ f773e89 |
| **B** | 过程/工具活动叙事摘要（已确认事实，不改状态语义）；过程卡片视觉收敛 | 截图矩阵 + 语义回归测试 | ✅ 8736904 |
| **C** | 全局 typography/spacing 收敛（侧栏 chrome、TopBar、notice、队列/Steer、对话框、工作台检查器、diff）；消灭全部中间字号 | 截图矩阵 | ✅ 764a123 |
| **D** | metadata 降权补漏；hover/focus/动效统一（reduced-motion 补齐过程环）；forced-colors 补等价态 | 截图矩阵 + forced-colors e2e | 本批 |

截图矩阵最低集（每批）：浅/深色 × {空闲, 流式中, 工具运行, 失败/待确认} + 长模型名/长路径 + 键盘焦点可见 + `prefers-reduced-motion`。所有既有 CSS 断言测试（`tests/*style*.test.ts`、composer/session 相关 44 处 `assert.match(css`）必须保持绿或随批更新。
