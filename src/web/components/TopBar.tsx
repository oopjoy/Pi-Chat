import type { CSSProperties } from "react";
import type { ModelInfo, PiState, SessionStats, ThinkingLevel } from "../../shared/types";
import type { GateMode } from "../lib/gate-mode";
import { GateControl } from "./GateControl";
import { ChipIcon } from "./Icons";
import { contextUsageTone } from "../lib/context-usage";

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

function formatPercent(percent: number | null): string {
  return percent === null ? "—" : `${percent.toFixed(1).replace(/\.0$/, "")}%`;
}

/**
 * Compact context-occupancy indicator. Cumulative token counters are
 * diagnostic-only, so they live in the hover/focus card instead of the bar.
 */
function UsageStats({ stats, isCompacting }: { stats?: SessionStats; isCompacting?: boolean }) {
  const usage = stats?.tokens;
  const context = stats?.contextUsage;
  const percent = typeof context?.percent === "number" ? Math.max(0, Math.min(100, context.percent)) : null;
  const tone = contextUsageTone(percent, isCompacting);
  const text = formatPercent(percent);
  return (
    <div className={`usage-pill is-${tone}`} tabIndex={0} aria-label={`会话上下文用量 ${text}`}>
      <i className="context-donut" style={{ "--context-percent": `${percent ?? 0}%` } as CSSProperties} aria-hidden="true" />
      <span>{isCompacting ? "压缩中" : text}</span>
      <div className="usage-card" role="tooltip">
        <dl>
          <div><dt>上下文</dt><dd>{compactTokens(context?.tokens)} / {compactTokens(context?.contextWindow)}（{text}）</dd></div>
          <div><dt>累计输入</dt><dd>{compactTokens(usage?.input)}</dd></div>
          <div><dt>累计输出</dt><dd>{compactTokens(usage?.output)}</dd></div>
          <div><dt>缓存读取</dt><dd>{compactTokens(usage?.cacheRead)}</dd></div>
        </dl>
        {isCompacting && <p>正在压缩上下文；当前消息会在完成后继续发送。</p>}
      </div>
    </div>
  );
}

export function TopBar({ state, models, stats, conversationName, workspacePath, disabled, streaming, gateAvailable, gateMode, onGate, onModel, onThinking }: {
  state: PiState;
  models: ModelInfo[];
  stats?: SessionStats;
  conversationName: string;
  workspacePath: string;
  disabled: boolean;
  streaming: boolean;
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
        <strong className="topbar-title">{conversationName}</strong>
      </div>
      <div className="topbar-indicators">
        <UsageStats stats={stats} isCompacting={state.isCompacting} />
      </div>
      <div className="topbar-controls">
        {gateAvailable && <GateControl mode={gateMode} disabled={disabled} onChange={onGate} />}
        <div className="model-controls" title={streaming ? "当前回复不会中断；新设置将在下一轮对话生效" : undefined}>
          <ChipIcon className="model-icon" />
          <label className="model-select" title="模型">
            <select value={current} disabled={disabled || !models.length} onChange={(event) => { const [provider, id] = event.target.value.split("\u0000"); onModel(provider, id); }}>
            {!current && <option value="">未选择</option>}
              {[...groups.entries()].map(([provider, providerModels]) => <optgroup key={provider} label={provider}>{providerModels.map((model) => <option key={modelValue(model)} value={modelValue(model)}>{model.name || model.id}</option>)}</optgroup>)}
            </select>
          </label>
          <label className="thinking-select" title="思考强度">
            <select aria-label="思考强度" value={state.thinkingLevel || "off"} disabled={disabled || !state.model?.reasoning} onChange={(event) => onThinking(event.target.value as ThinkingLevel)}>
              {THINKING_LEVELS.map((level) => <option key={level.value} value={level.value}>{level.label}</option>)}
            </select>
          </label>
        </div>
      </div>
    </header>
  );
}
