# 第四批：模型 / Thinking 设置事务边界

工作区：`D:\Pi-Chat-reliability`。分支：`fix/review-turn-settings`，基于第三批复制来源事务提交 `3ce289f`。本批保留在工作分支，main 稳定点不变，不自动推送或部署。

## 唯一职责与权限

`createTurnSettingsAction` 只负责：验证当前 Runtime 的模型路由，依次应用 Model / Thinking，返回已确认生效的设置事实。

它不拥有 Prompt 排队、Session 切换、进程启停、结果不确定的判定策略、App 私有 Map 或显示状态写入权。

删除 App 中对应的整对象 Proxy 和服务中的 `Record<string, any>`。现在接口分为：

- `TurnSettingsRpc`：只读 send 能力，命令类型限定为 `get_available_models`、`get_state`、`set_model`、`set_thinking_level`。没有 stop/restart 等方法，不能替换 send。
- `TurnSettingsSnapshot`：只读请求设置与模型路由。
- `TurnSettingsPorts`：迟到响应处理器工厂、写入失败的 outcome 判定入口、模型上下文信息登记，共三个明确能力。

App 传入的实际对象也只有 send；箭头适配器保留真实 RPC 接收者、超时和选项，不把完整 RPC 实例交给服务。同步状态副作用要求返回 undefined，避免 async 函数被普通 void 回调类型静默接受。

`applyTurnSettings` 调用点不再使用 `...any[]` 或 `as any`。常量、纯解码函数和错误类由模块直接导入，不通过万能 host 注入。

## 保持的行为

- provider/model/API 不匹配时，在写入前拒绝。
- 同一 provider/model 对应多个 API 时，仍拒绝无法由当前 set_model 协议区分的选择。
- 原生 set_model 仍只发送 provider 和 modelId，不新增协议字段。
- Model 成功但 Thinking 失败，仍抛出带已应用 Model 的 PartialTurnSettingsError。
- 非 reasoning 模型仍投影为 off，跳过不兼容的 Thinking 写入和多余探测。
- 后续状态读取失败不会把已经确认的写入重新标成不确定；错误模型或未知 Thinking 返回值不能覆盖已确认值。
- 每次写入保留独立 outcome token 与原迟到响应处理器，App 继续负责错误分类和 fence 策略。

## 回归与类型证明

- 新服务测试覆盖命令顺序、路由拒绝、读取失败、写入失败、部分成功、非 reasoning 模型、档位修正、空设置、Thinking-only 和实际 RPC 接收者绑定。
- 既有 Prompt settings snapshot 与复制来源回归保持通过；聚焦合计 45/45。
- 编译期负例实际进入 tsc：不允许发 Prompt、切 Session、停止/重启、替换 send、发送不支持的 Thinking、把 API 塞进 set_model、缺少失败处理能力、用 async 实现同步回调或修改输入快照。
- 原复制边界守卫扩为 `tests/service-port-boundaries.test.ts`，保留原测试并覆盖两个服务及其真实接线/转发方法，禁止 any、断言、Proxy、Reflect 和 host spread。
- 此模块加入类型感知 Promise 和 unsafe 操作的严格 lint 范围。

类型和 AST 规则用于防止维护误用，不宣称 JavaScript 运行时安全沙箱；进程与 Session 的实际准入仍由原 Runtime / App 所有者负责。

## 验证结果

完整 `npm run verify` 退出码 0：

| Lane | 通过 | 跳过 | 失败 |
|---|---:|---:|---:|
| Source | 1501 | 2 | 0 |
| Benchmark | 34 | 0 | 0 |
| Playwright | 28 | 0 | 0 |
| Artifact | 39 | 1 | 0 |

TypeScript（包含类型负例）、writer 检查通过。Lint 0 errors / 1296 warnings。

相对上一批：显式 `: any` 714→710，`Record<string, any>` 31→30，`as any` 34→31，Proxy 7→6，上限同步下降。其他六处 Proxy 与宽泛编排接口仍属后续工作。

日志位于 `D:\Pi-Chat-review-artifacts\turn-settings-focused.log`、`turn-settings-full-verify.log`、`turn-settings-lint.log`。构建、配置及会话夹具均隔离，未使用真实模型发送请求或改写用户记录。
