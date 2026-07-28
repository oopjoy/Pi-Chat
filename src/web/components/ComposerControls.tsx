import type { CSSProperties } from "react";
import type { ModelInfo, PiState, SessionStats, ThinkingLevel } from "../../shared/types";
import { contextUsageTone } from "../lib/context-usage";
import type { GateMode } from "../lib/gate-mode";
import { ChipIcon, LightbulbIcon } from "./Icons";
import { CompactSelect } from "./CompactSelect";
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

function UsageStats({ stats, isCompacting }: { stats?: SessionStats; isCompacting?: boolean }) {
  const usage = stats?.tokens;
  const context = stats?.contextUsage;
  const pendingRefresh = stats?.contextUsagePendingRefresh === true;
  const percent = pendingRefresh ? null : typeof context?.percent === "number" ? Math.max(0, Math.min(100, context.percent)) : null;
  const tone = pendingRefresh ? "normal" : contextUsageTone(percent, isCompacting);
  const percentText = formatPercent(percent);
  const ringPercent = pendingRefresh ? 33.333 : percent ?? 0;
  return (
    <div className={`usage-pill composer-usage is-${tone}`} tabIndex={0} aria-label={`会话上下文用量 ${pendingRefresh ? "待更新" : percentText}`}>
      <i className="context-donut" style={{ "--context-percent": `${ringPercent}%` } as CSSProperties} aria-hidden="true" />
      <span>{pendingRefresh ? "?" : percentText}</span>
      <div className="usage-card" role="tooltip">
        <dl>
          <div><dt>上下文</dt><dd>{pendingRefresh ? "?" : compactTokens(context?.tokens)} / {compactTokens(context?.contextWindow)}（{pendingRefresh ? "待更新" : percentText}）</dd></div>
          <div><dt>累计输入</dt><dd>{compactTokens(usage?.input)}</dd></div>
          <div><dt>累计输出</dt><dd>{compactTokens(usage?.output)}</dd></div>
          <div><dt>缓存读取</dt><dd>{compactTokens(usage?.cacheRead)}</dd></div>
        </dl>
        {pendingRefresh && <p>执行对话以更新上下文占比</p>}
      </div>
    </div>
  );
}

export function ComposerControls({ state, models, stats, disabled, settingsBusy = false, streaming, gateAvailable, gateMode, onGate, onModel, onThinking }: {
  state: PiState;
  models: ModelInfo[];
  stats?: SessionStats;
  disabled: boolean;
  settingsBusy?: boolean;
  streaming: boolean;
  gateAvailable: boolean;
  gateMode?: GateMode;
  onGate: (mode: GateMode) => void;
  onModel: (provider: string, id: string) => void;
  onThinking: (level: ThinkingLevel) => void;
}) {
  const current = state.model ? modelValue(state.model) : "";
  const controlsDisabled = disabled || settingsBusy;
  const modelOptions = models.map((model) => ({ value: modelValue(model), label: model.name || model.id }));

  return <div className="composer-controls" title={settingsBusy ? "正在切换模型或思考强度…" : streaming ? "当前回复不会中断；新设置将在下一轮对话生效" : undefined}>
    <CompactSelect value={current} options={modelOptions} disabled={controlsDisabled || !models.length} ariaLabel="模型" title="模型" align="left" icon={<ChipIcon className="model-icon" />} checkPosition="start" className="composer-model-select" onChange={(value) => {
      const model = models.find((candidate) => modelValue(candidate) === value);
      if (model) onModel(model.provider, model.id);
    }} />
    <CompactSelect value={(state.thinkingLevel || "off") as ThinkingLevel} options={THINKING_LEVELS} disabled={controlsDisabled || !state.model?.reasoning} ariaLabel="思考强度" title="思考强度" align="left" icon={<LightbulbIcon className={`thinking-icon${state.thinkingLevel && state.thinkingLevel !== "off" ? " is-active" : ""}`} />} checkPosition="start" className="thinking-control thinking-select" onChange={onThinking} />
    {gateAvailable && <GateControl mode={gateMode} disabled={controlsDisabled} onChange={onGate} />}
    <UsageStats stats={stats} isCompacting={state.isCompacting} />
  </div>;
}
