import type { CSSProperties } from "react";
import type { ModelInfo, PiState, SessionStats, ThinkingLevel } from "../../shared/types";
import { contextUsageTone } from "../lib/context-usage";
import type { GateMode } from "../lib/gate-mode";
import { LightbulbIcon, LightningIcon } from "./Icons";
import { CompactSelect } from "./CompactSelect";
import { ComposerModelSelect } from "./ComposerModelSelect";
import { GateControl } from "./GateControl";

function compactTokens(value: number | undefined | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(value));
}

const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: "off", label: "off" },
  { value: "minimal", label: "min" },
  { value: "low", label: "low" },
  { value: "medium", label: "med" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

function formatPercent(percent: number | null): string {
  return percent === null ? "—" : `${percent.toFixed(1).replace(/\.0$/, "")}%`;
}

function UsageStats({ stats, isCompacting, fastModeActive = false }: { stats?: SessionStats; isCompacting?: boolean; fastModeActive?: boolean }) {
  const usage = stats?.tokens;
  const context = stats?.contextUsage;
  const pendingRefresh = stats?.contextUsagePendingRefresh === true;
  const percent = pendingRefresh ? null : typeof context?.percent === "number" ? Math.max(0, Math.min(100, context.percent)) : null;
  const tone = pendingRefresh ? "normal" : contextUsageTone(percent, isCompacting);
  const percentText = formatPercent(percent);
  const ringPercent = pendingRefresh ? 33.333 : percent ?? 0;
  return (
    <div className={`usage-pill composer-usage is-${tone}${fastModeActive ? " has-fast-mode" : ""}`} tabIndex={0} aria-label={`会话上下文用量 ${pendingRefresh ? "待更新" : percentText}${fastModeActive ? "，Fast 模式已开启" : ""}`}>
      <i className="context-donut" style={{ "--context-percent": `${ringPercent}%` } as CSSProperties} aria-hidden="true" />
      <span>{pendingRefresh ? "?" : percentText}</span>
      {fastModeActive && <span className="fast-mode-indicator" title="Fast 模式已开启" aria-hidden="true"><LightningIcon /></span>}
      <div className="usage-card" role="tooltip">
        <dl>
          <div><dt>上下文</dt><dd>{pendingRefresh ? "?" : compactTokens(context?.tokens)} / {compactTokens(context?.contextWindow)}（{pendingRefresh ? "待更新" : percentText}）</dd></div>
          <div><dt>累计输入</dt><dd>{compactTokens(usage?.input)}</dd></div>
          <div><dt>累计输出</dt><dd>{compactTokens(usage?.output)}</dd></div>
          <div><dt>缓存读取</dt><dd>{compactTokens(usage?.cacheRead)}</dd></div>
          {fastModeActive && <div><dt>Fast 模式</dt><dd>已开启</dd></div>}
        </dl>
        {pendingRefresh && <p>执行对话以更新上下文占比</p>}
      </div>
    </div>
  );
}

export function ComposerControls({ state, models, stats, disabled, gateAvailable, gateMode, primaryUnavailable = false, onGate, onModel, onThinking }: {
  state: PiState;
  models: ModelInfo[];
  stats?: SessionStats;
  disabled: boolean;
  gateAvailable: boolean;
  gateMode?: GateMode;
  /** Model, thinking, and Gate mutate the selected Primary Runtime. */
  primaryUnavailable?: boolean;
  onGate: (mode: GateMode) => void;
  onModel: (provider: string, id: string) => void;
  onThinking: (level: ThinkingLevel) => void;
}) {
  // A setting request may still be in flight, but the next choice is a new
  // local preference snapshot rather than a reason to freeze the controls.
  const controlsDisabled = disabled || primaryUnavailable;
  const unavailableTitle = "Pi Runtime 尚未就绪；历史仍可阅读，Runtime 恢复后可修改此设置";

  return <div className="composer-controls" title={primaryUnavailable ? unavailableTitle : undefined}>
    <ComposerModelSelect value={state.model} models={models} disabled={controlsDisabled} onChange={onModel} />
    <CompactSelect value={(state.thinkingLevel || "off") as ThinkingLevel} options={THINKING_LEVELS} disabled={controlsDisabled || !state.model || state.model.reasoning === false} ariaLabel="思考强度" title="思考强度" align="left" icon={<LightbulbIcon className={`thinking-icon${state.thinkingLevel && state.thinkingLevel !== "off" ? " is-active" : ""}`} />} checkPosition="start" className="thinking-control thinking-select" onChange={onThinking} />
    {gateAvailable && <GateControl mode={gateMode} disabled={controlsDisabled} onChange={onGate} />}
    <UsageStats stats={stats} isCompacting={state.isCompacting} fastModeActive={state.fastModeActive} />
  </div>;
}
