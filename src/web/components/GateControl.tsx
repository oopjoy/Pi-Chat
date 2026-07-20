import type { GateMode } from "../lib/gate-mode";
import { gateLabel } from "../lib/gate-mode";

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
  return <label className={`gate-control is-${mode}`} title={title}>
    <span aria-hidden="true">⌁</span>
    <em>文件权限</em>
    <select value={mode} disabled={disabled} aria-label="文件权限模式" onChange={(event) => onChange(event.target.value as GateMode)}>
      {OPTIONS.map((option) => <option key={option} value={option}>{gateLabel(option)}</option>)}
    </select>
  </label>;
}
