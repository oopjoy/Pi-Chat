import type { GateMode } from "../lib/gate-mode";
import { gateLabel } from "../lib/gate-mode";
import { CompactSelect } from "./CompactSelect";

const OPTIONS: GateMode[] = ["strict", "open"];

export function GateControl({ mode, disabled, onChange }: {
  mode?: GateMode;
  disabled: boolean;
  onChange: (mode: GateMode) => void;
}) {
  // Missing mode is missing authority, not a third mode and not proof that a
  // previously open Session became strict. The caller supplies strict for a
  // genuinely new draft; an existing Session waits for its host projection.
  const title = mode === undefined
    ? "正在确认当前 Pi 会话的文件权限模式"
    : mode === "strict"
    ? "严格：write/edit 均需确认；可识别的高风险 Bash 也会确认。Bash 副作用识别为有限辅助防护。"
    : "放行：当前 Pi 会话的 Gate 不再确认 write/edit 或已识别的高风险 Bash";
  const shield = <svg className="gate-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 20 6v5.6c0 4.8-3.25 8.3-8 9.6-4.75-1.3-8-4.8-8-9.6V6l8-3.2Z" /><path d="M12 7.2v6.1" /><circle cx="12" cy="16.8" r=".7" fill="currentColor" stroke="none" /></svg>;
  const options = OPTIONS.map((option) => ({ value: option, label: gateLabel(option) }));
  return <CompactSelect value={mode || ""} options={options} disabled={disabled || mode === undefined} ariaLabel="文件权限模式" title={title} icon={shield} checkPosition="start" fallbackLabel="正在确认" className={`gate-control${mode ? ` is-${mode}` : " is-syncing"}`} onChange={(next) => onChange(next as GateMode)} />;
}
