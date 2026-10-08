import { useEffect, useRef } from "react";
import type { RuntimeEntryInfo, RuntimeSetupStatus } from "../../shared/runtime-setup";
import { useModalFocus } from "../lib/modal-focus";

export interface RuntimeSetupDialogProps {
  status: RuntimeSetupStatus | null;
  candidate: RuntimeEntryInfo | null;
  mode: "retry" | "automatic" | "select";
  loading: boolean;
  applying: boolean;
  blocked: boolean;
  error: string;
  onClose(): void;
  onDetect(): void;
  onPick(): void;
  onAutomatic(): void;
  onApply(): void;
}

/** Display only. App owns requests, stale-response admission and restart intent. */
export function RuntimeSetupDialog(props: RuntimeSetupDialogProps) {
  const { status, candidate, mode, loading, applying, blocked, error, onClose } = props;
  const dialog = useRef<HTMLElement>(null);
  useModalFocus(true, dialog);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape" && !applying) onClose(); };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [applying, onClose]);
  const busy = loading || applying;
  return <div className="panel-backdrop" role="presentation">
    <section ref={dialog} className="runtime-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="runtime-setup-title">
      <header className="management-head"><h2 id="runtime-setup-title">连接本机 Pi</h2>
        <button type="button" onClick={props.onClose} disabled={applying} aria-label="关闭 Pi 连接设置">关闭</button>
      </header>
      <p>网页服务与 Pi Runtime 是两个独立阶段。检测只读取安装信息，不启动 Pi、不下载软件，也不修改模型认证。</p>
      <dl className="runtime-setup-paths">
        <dt>当前服务入口</dt><dd>{status?.current?.entry || "未识别"}</dd>
        <dt>下次启动来源</dt><dd>{status ? ({ environment: "环境变量 PI_CHAT_PI_ENTRY", saved: "已保存的入口", automatic: "自动发现" }[status.source]) : "正在检测…"}</dd>
        <dt>本次待应用入口</dt><dd>{candidate?.entry || "尚未找到可用入口"}{candidate?.version ? `（Pi ${candidate.version}）` : ""}</dd>
      </dl>
      {status?.error && <p className="resource-error">{status.error}</p>}
      {status?.environmentOverride && <p>环境变量拥有优先权。修改入口前，请在启动环境中修改或移除 PI_CHAT_PI_ENTRY；此处不会覆盖它。</p>}
      {error && <p className="resource-error" role="alert">{error}</p>}
      <div className="about-actions">
        <button type="button" disabled={busy} onClick={props.onDetect}>{loading ? "正在检测…" : "重新检测"}</button>
        <button type="button" disabled={busy || blocked || !status?.pickerAvailable || status.environmentOverride} onClick={props.onPick}>选择 rpc-entry.js</button>
        <button type="button" disabled={busy || !status || status.environmentOverride} onClick={props.onAutomatic}>使用自动发现</button>
      </div>
      <p>只选择你信任的 Pi 安装中的 <code>dist/rpc-entry.js</code>。包名检查不代表安全认证；应用后会运行该安装及其扩展，权限与当前 Windows 用户相同。</p>
      <p>没有安装 Pi？请先通过 Pi 官方安装器或 npm 安装，再点“重新检测”。模型认证请在 Pi 中通过 /login 配置。</p>
      {status && !status.restartAvailable && <p>当前开发启动方式不支持免构建重启，请手动重启开发服务。</p>}
      {blocked && <p role="status">当前有运行、排队、等待确认的任务或维护操作，请完成后再应用。最终以服务端空闲检查为准。</p>}
      <p>应用会安全重启整个 Pi Chat 服务及其 Pi 会话进程，但不构建、不下载、不删除聊天记录。请先保存未发送内容；无需重启电脑。</p>
      <div className="about-actions">
        <button type="button" className="about-primary-action" disabled={busy || blocked || !candidate || !status?.restartAvailable} onClick={props.onApply}>
          {applying ? "正在重启服务…" : mode === "retry" ? "重试连接（重启服务）" : "保存入口并重启服务"}
        </button>
      </div>
    </section>
  </div>;
}
