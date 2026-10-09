# 第三批：会话复制来源事务的边界收尾

基于已验证的稳定点 `10f2e96`，工作分支 `fix/review-copy-contract`，工作区 `D:\Pi-Chat-reliability`。本批单独提交，未自动部署。

## 删除的权限与隐含依赖

- 删除 `PiChatApp.sessionCopyOriginActions()` 中的一处 `new Proxy(this as any)`，不再把完整 App 和可写反射代理交给服务。
- `session-copy-origin-actions.ts` 不再接收 `Record<string, any>`，改为 10 个明确的 `SessionCopyOriginPorts` 能力。
- 服务不再访问 `options`、RuntimePool、RPC、copying/recovery Set 或 Primary 状态字段；这些操作保留在 App 的显式回调中。
- 来源关系和名称为只读投影；事务输入只读。跨边界的 Secondary Runtime 只暴露只读 id 句柄，App 使用前通过对象身份重新确认它仍是当前所有者，不能凭同一个 id 操作替代 Runtime。
- RPC 执行结果使用现有 `executeSessionCopyRpc` 的真实返回契约。同步状态回调返回 `undefined`，避免 TypeScript 的普通 `void` 回调规则静默接受 async 函数。
- 顺带收紧复制恢复路径使用的 `restartPrimaryRuntime(sessionFile?, cwd?)` 调用签名，不再通过 `...any[]` 和 `as any` 调用。

## 保持的业务规则

外层复制准入、操作租约和 generation reopening 仍由原所有者负责；服务没有获得新的生命周期所有权。RPC 完成之后才读取当前 active/live id 信息，避免把动态 getter 变成早期静态快照。

复制失败或取消仍恢复源 writer；结果未确认仍保留 outcome fence；目标已验证创建但源恢复失败时，保留目标并返回“请勿重复操作”的警告，不伪装成可以安全重试的未提交失败。冷 Fork 来源查询不启动 Runtime，也不执行复制/恢复能力。

## 编译器与边界测试

- 新增编译期负例，实际纳入 `tsc`：缺少恢复能力、错误 id 类型、错误 RPC 结果、async 冒充同步回调、访问 App options/Set、修改输入/来源关系、访问 Runtime RPC，均应被拒绝。
- 合同项目补充 Node 类型，以便同时检查 Web 与 Server 的契约，而不是仅通过 tsx 执行。
- AST 守卫覆盖服务文件及真实 App 接线方法：不得使用 any、强制类型断言、整对象 Proxy 或 Reflect 反射绕过；调用必须是显式能力对象，不允许把 host 隐藏在 spread 中。
- 该服务加入类型感知 Promise/any/unused 严格模块集合，另外启用 no-unsafe-assignment/call/member-access/return/argument/type-assertion。

这些是该边界的收尾，不代表其他万能 host、七处剩余 Proxy 或所有 Callback 已经清理。

## 验证

- 聚焦回归：41/41 通过，包括成功、取消、RPC 拒绝、结果不确定、复制后身份变化、源恢复失败、只读来源与过期 Runtime 句柄。
- 完整 `npm run verify`：退出码 0。
  - Source：1486 通过、2 跳过、0 失败。
  - Benchmark：34 通过。
  - Playwright：28 通过。
  - Artifact：39 通过、1 跳过、0 失败。
- TypeScript、编译期负例、writer 检查通过；Lint 0 errors / 1304 warnings。
- 类型债：显式 `: any` 724 → 714，`Record<string, any>` 32 → 31，`as any` 37 → 34，Proxy 8 → 7；上限同步下调。

日志：`D:\Pi-Chat-review-artifacts\copy-contract-focused.log`、`copy-contract-full-verify.log`、`copy-contract-lint.log`。

## 发布边界

稳定点推送和下一批代码合并分开处理。GitHub 凭据未就绪时，不把“本地验证通过”写成“已推送成功”，也不通过强推、修改远端地址或提交凭据绕过认证。main 的本机未提交启动补丁继续保留。
