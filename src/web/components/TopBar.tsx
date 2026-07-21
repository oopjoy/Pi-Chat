import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ModelInfo, PiState, SessionStats, ThinkingLevel } from "../../shared/types";
import type { GateMode } from "../lib/gate-mode";
import { GateControl } from "./GateControl";
import { CheckIcon, ChipIcon } from "./Icons";
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
  const pendingRefresh = stats?.contextUsagePendingRefresh === true;
  const percent = pendingRefresh ? null : typeof context?.percent === "number" ? Math.max(0, Math.min(100, context.percent)) : null;
  const tone = pendingRefresh ? "normal" : contextUsageTone(percent, isCompacting);
  const text = pendingRefresh ? "?" : formatPercent(percent);
  const ringPercent = pendingRefresh ? 33.333 : percent ?? 0;
  return (
    <div className={`usage-pill is-${tone}`} tabIndex={0} aria-label={`会话上下文用量 ${pendingRefresh ? "待更新" : text}`}>
      <i className="context-donut" style={{ "--context-percent": `${ringPercent}%` } as CSSProperties} aria-hidden="true" />
      <span>{text}</span>
      <div className="usage-card" role="tooltip">
        <dl>
          <div><dt>上下文</dt><dd>{pendingRefresh ? "?" : compactTokens(context?.tokens)} / {compactTokens(context?.contextWindow)}（{pendingRefresh ? "待更新" : text}）</dd></div>
          <div><dt>累计输入</dt><dd>{compactTokens(usage?.input)}</dd></div>
          <div><dt>累计输出</dt><dd>{compactTokens(usage?.output)}</dd></div>
          <div><dt>缓存读取</dt><dd>{compactTokens(usage?.cacheRead)}</dd></div>
        </dl>
        {pendingRefresh && <p>执行对话以更新上下文占比</p>}
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
  const currentModel = models.find((model) => modelValue(model) === current);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModelMenuOpen(false);
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [modelMenuOpen]);
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
          <div className="model-menu" ref={modelMenuRef}>
            <button type="button" className="model-menu-trigger" disabled={disabled || !models.length} aria-label="模型" aria-haspopup="listbox" aria-expanded={modelMenuOpen} onClick={() => setModelMenuOpen((open) => !open)}>
              <ChipIcon className="model-icon" />
              <span>{currentModel?.name || state.model?.id || "未选择"}</span>
              <i className="model-menu-chevron" aria-hidden="true" />
            </button>
            {modelMenuOpen && <div className="model-menu-popover" role="listbox" aria-label="选择模型">
              {models.map((model) => {
                const selected = modelValue(model) === current;
                return <button type="button" key={modelValue(model)} className={selected ? "is-selected" : ""} role="option" aria-selected={selected} onClick={() => { setModelMenuOpen(false); onModel(model.provider, model.id); }}>
                  <span>{model.name || model.id}</span>{selected && <CheckIcon />}
                </button>;
              })}
            </div>}
          </div>
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
