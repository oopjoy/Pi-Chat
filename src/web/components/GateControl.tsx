import type { GateMode } from "../lib/gate-mode";
import { gateLabel } from "../lib/gate-mode";
import { CompactSelect } from "./CompactSelect";

const OPTIONS: GateMode[] = ["strict", "open"];

export function GateControl({ mode, disabled, onChange }: {
  mode?: GateMode;
  disabled: boolean;
  onChange: (mode: GateMode) => void;
}) {
  const title = mode === undefined
    ? "文件权限模式尚未与当前 Runtime 同步"
    : mode === "strict"
    ? "严格：write/edit 均需确认；可识别的高风险 Bash 也会确认。Bash 副作用识别为有限辅助防护。"
    : "放行：当前 Pi 会话的 Gate 不再确认 write/edit 或已识别的高风险 Bash";
  const shield = <svg className="gate-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 20 6v5.6c0 4.8-3.25 8.3-8 9.6-4.75-1.3-8-4.8-8-9.6V6l8-3.2Z" /><path d="M12 7.2v6.1" /><circle cx="12" cy="16.8" r=".7" fill="currentColor" stroke="none" /></svg>;
  const value = mode || "unknown";
  const options = mode === undefined
    ? [{ value: "unknown", label: "未同步" }, ...OPTIONS.map((option) => ({ value: option, label: gateLabel(option) }))]
    : OPTIONS.map((option) => ({ value: option, label: gateLabel(option) }));
  return <CompactSelect value={value} options={options} disabled={disabled} ariaLabel="文件权限模式" title={title} icon={shield} checkPosition="start" className={`gate-control${mode ? ` is-${mode}` : " is-unknown"}`} onChange={(next) => { if (next !== "unknown") onChange(next as GateMode); }} />;
}
