# Pi Chat Complete Setup — 测试预发布

这是供另一台 Windows 电脑验证安装体验的 **Pre-release**，不是新的正式版本。
应用版本仍为 0.5.2；确切提交、构建指纹和 Node 版本见旁边的 manifest。
正式 v0.5.2 的标签、旧资产和 Latest 状态保持不变。

## 下载哪一个

**下载 `pi-chat-setup.exe`（约 27 MB）即可。** 这是 Inno Setup 完整安装包：

- 内置 Pi Chat 本体、私有 Node/npm，安装主体不再下载 App 或 Node；
- 优先复用本机 Pi，不擅自升级、复制配置或凭证；
- 没有 Pi 时，完成页提供明确的可选联网安装。跳过或失败不撤销主体安装；
- 原生向导、开始菜单入口、可选桌面快捷方式、Windows 卸载；
- 不提供第二个 Web EXE 或 portable 包。GitHub 自动生成的 Source code 不是安装包。

## 请验证

1. 先核对 EXE 的 SHA256 与 `.sha256` 文件，然后双击，确认向导与进度可见。
2. 主体安装不需要系统 Node 或网络；可选 Pi 安装及模型服务调用仍可能需要网络和认证。
3. 打开后检查“关于”的 Build Revision；已有 Pi 的配置、Skills 和会话应继续由原来的 Pi 管理。
4. 关闭、从快捷方式再次打开；在“设置 → 应用”卸载时保留 Pi 用户数据。
5. 正在运行的目标安装应拒绝覆盖或卸载；另一个 checkout 的服务不会被强杀或接管。

安装器目前 **未签名**，可能触发 SmartScreen。不要关闭系统安全防护来完成测试；请记录提示与失败阶段。
安装日志可用 `/LOG="D:\PiChat-setup.log"` 指定，Pi 可选安装日志位于 `%TEMP%\pi-chat-pi-install.log`。
分享日志前请去除凭证和个人信息。

该测试包也包含 main 分支上的带图消息关联、超大历史分页和桌面反馈修复；
它们没有回填至旧 v0.5.2 的在线安装器。
