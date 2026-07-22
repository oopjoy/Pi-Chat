import type { GateMode } from "../lib/gate-mode";
import { gateLabel } from "../lib/gate-mode";
import { CompactSelect } from "./CompactSelect";

const OPTIONS: GateMode[] = ["strict", "once", "open"];

export function GateControl({ mode, disabled, onChange }: {
  mode: GateMode;
  disabled: boolean;
  onChange: (mode: GateMode) => void;
}) {
  const title = mode === "strict"
    ? "严格：写入、编辑和破坏性 Bash 均需确认"
    : mode === "once"
      ? "仅一次：下一次受保护操作直接允许，随后恢复严格"
      : "放行：当前 Pi 会话的受保护操作不再确认";
  const shield = <svg className="gate-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 20 6v5.6c0 4.8-3.25 8.3-8 9.6-4.75-1.3-8-4.8-8-9.6V6l8-3.2Z" /><path d="M12 7.2v6.1" /><circle cx="12" cy="16.8" r=".7" fill="currentColor" stroke="none" /></svg>;
  return <CompactSelect value={mode} options={OPTIONS.map((option) => ({ value: option, label: gateLabel(option) }))} disabled={disabled} ariaLabel="文件权限模式" title={title} icon={shield} className={`gate-control is-${mode}`} onChange={onChange} />;
}
