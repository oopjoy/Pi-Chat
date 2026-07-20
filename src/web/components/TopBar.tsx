import type { CSSProperties } from "react";
import type { ModelInfo, PiState, SessionStats, ThinkingLevel } from "../../shared/types";
import type { GateMode } from "../lib/gate-mode";
import { GateControl } from "./GateControl";

function modelValue(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}\u0000${model.id}`;
}

function compactTokens(value: number | undefined | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(value));
}

const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

function UsageStats({ stats }: { stats?: SessionStats }) {
  const usage = stats?.tokens;
  const context = stats?.contextUsage;
  const percent = typeof context?.percent === "number" ? Math.max(0, Math.min(100, context.percent)) : null;
  const contextTitle = percent === null || !context
    ? "当前上下文用量不可用"
    : `上下文：${compactTokens(context.tokens)} / ${compactTokens(context.contextWindow)}（${percent.toFixed(1).replace(/\.0$/, "")}%）`;
  return <div className="usage-stats" aria-label="会话 Token 用量">
    <span title={`累计输入 Token：${compactTokens(usage?.input)}`}><b className="usage-arrow">↑</b>{compactTokens(usage?.input)}</span>
    <span title={`累计输出 Token：${compactTokens(usage?.output)}`}><b className="usage-arrow">↓</b>{compactTokens(usage?.output)}</span>
    <span title={`累计缓存读取 Token：${compactTokens(usage?.cacheRead)}`}><b className="usage-cache">R</b>{compactTokens(usage?.cacheRead)}</span>
    <span className={`usage-context ${percent === null ? "is-unavailable" : ""}`} title={contextTitle}>
      <i className="context-donut" style={{ "--context-percent": `${percent ?? 0}%` } as CSSProperties} aria-hidden="true" />
      {percent === null ? "—" : `${percent.toFixed(1).replace(/\.0$/, "")}%`} / {compactTokens(context?.contextWindow)}
    </span>
  </div>;
}

export function TopBar({ state, models, stats, conversationName, workspacePath, disabled, gateAvailable, gateMode, onGate, onModel, onThinking }: {
  state: PiState;
  models: ModelInfo[];
  stats?: SessionStats;
  conversationName: string;
  workspacePath: string;
  disabled: boolean;
  gateAvailable: boolean;
  gateMode: GateMode;
  onGate: (mode: GateMode) => void;
  onModel: (provider: string, id: string) => void;
  onThinking: (level: ThinkingLevel) => void;
}) {
  const current = state.model ? modelValue(state.model) : "";
  const groups = models.reduce((map, model) => {
    const providerModels = map.get(model.provider) || [];
    providerModels.push(model);
    map.set(model.provider, providerModels);
    return map;
  }, new Map<string, ModelInfo[]>());
  return (
    <header className="topbar">
      <div className="topbar-context" title={`当前对话：${conversationName}\n工作路径：${workspacePath}`}>
        <div className="topbar-title"><strong>Pi Chat</strong><b><span className="topbar-label">当前对话：</span>{conversationName}</b></div>
        <div className="topbar-path" title={`工作路径：${workspacePath}`}><span aria-hidden="true">⌂</span><em>工作路径：</em>{workspacePath}</div>
      </div>
      <UsageStats stats={stats} />
      {gateAvailable && <GateControl mode={gateMode} disabled={disabled} onChange={onGate} />}
      <label className="topbar-select model-select">
        <span>模型</span>
        <select value={current} disabled={disabled || !models.length} onChange={(event) => { const [provider, id] = event.target.value.split("\u0000"); onModel(provider, id); }}>
          {!current && <option value="">未选择</option>}
          {[...groups.entries()].map(([provider, providerModels]) => <optgroup key={provider} label={provider}>{providerModels.map((model) => <option key={modelValue(model)} value={modelValue(model)}>{model.name || model.id}</option>)}</optgroup>)}
        </select>
      </label>
      <label className="topbar-select thinking-select">
        <span>思考强度</span>
        <select value={state.thinkingLevel || "off"} disabled={disabled || !state.model?.reasoning} onChange={(event) => onThinking(event.target.value as ThinkingLevel)}>
          {THINKING_LEVELS.map((level) => <option key={level.value} value={level.value}>{level.label}</option>)}
        </select>
      </label>
    </header>
  );
}
