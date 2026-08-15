import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { BackgroundSubagentStatus, BackgroundSubagentStep } from "../../shared/types";
import { useBackgroundSubagents } from "../hooks/use-background-subagents";
import { ChevronDownIcon, SubagentsIcon } from "./Icons";

const STATUS_LABEL: Record<BackgroundSubagentStatus, string> = {
  running: "运行中",
  attention: "需要关注",
  complete: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function age(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 10) return "刚刚更新";
  if (seconds < 60) return `${seconds} 秒前更新`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前更新` : `${Math.floor(hours / 24)} 天前更新`;
}

function StepRow({ step }: { step: BackgroundSubagentStep }) {
  const metrics = [
    `已用 ${duration(step.elapsedMs)}`,
    age(step.updateAgeMs),
    step.turnCount === undefined ? "" : `${step.turnCount} 轮`,
    step.toolCount === undefined ? "" : `${step.toolCount} 次工具`,
  ].filter(Boolean);
  return (
    <details className={`subagent-status-row is-${step.status}`}>
      <summary>
        <span className="subagent-status-dot" aria-hidden="true" />
        <span className="subagent-status-main">
          <strong>{step.label}</strong>
          <span>{metrics.slice(0, 2).join(" · ")}</span>
        </span>
        <span className="subagent-status-label">{STATUS_LABEL[step.status]}</span>
      </summary>
      <div className="subagent-status-detail">
        {step.activity && <span>{step.activity}</span>}
        <span>{metrics.join(" · ")}</span>
        <span>只读状态，不会打开子会话记录。</span>
      </div>
    </details>
  );
}

export function SubagentStatusControl({ sessionId }: { sessionId: string }) {
  const snapshot = useBackgroundSubagents(sessionId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hasLive = snapshot.activeCount > 0 || snapshot.attentionCount > 0;

  useEffect(() => {
    setOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (snapshot.total === 0 && open) setOpen(false);
  }, [snapshot.total, open]);

  if (snapshot.total === 0) return null;

  const openAndFocus = () => {
    setOpen(true);
    queueMicrotask(() => popoverRef.current?.focus());
  };
  const onPopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  };
  const tooltip = "后台子代理仅供查看，不受主会话 Queue / Steer 控制";

  return (
    <div className="subagent-status-control" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`subagent-status-trigger${open ? " is-open" : ""}${snapshot.attentionCount ? " has-attention" : hasLive ? " has-active" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="background-subagent-popover"
        aria-describedby={open ? undefined : "background-subagent-tooltip"}
        onClick={() => open ? setOpen(false) : openAndFocus()}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          openAndFocus();
        }}
      >
        <span className="subagent-status-indicator" aria-hidden="true"><SubagentsIcon /></span>
        <span>{snapshot.total} 个子代理</span>
        <ChevronDownIcon className="subagent-status-chevron" aria-hidden="true" />
      </button>
      {!open && <span id="background-subagent-tooltip" role="tooltip" className="subagent-status-tooltip">{tooltip}</span>}
      {open && (
        <div
          ref={popoverRef}
          id="background-subagent-popover"
          role="dialog"
          aria-label="后台子代理状态"
          className="subagent-status-popover"
          tabIndex={-1}
          onKeyDown={onPopoverKeyDown}
        >
          <div className="subagent-status-heading">
            <strong>后台子代理</strong>
            <span>只读投影</span>
          </div>
          <div className="subagent-status-list">
            {snapshot.steps.map((step) => <StepRow key={step.key} step={step} />)}
          </div>
          {snapshot.truncated && <p className="subagent-status-truncated">仅显示最近的 24 个步骤。</p>}
          <p className={`subagent-status-authority${hasLive ? " is-important" : ""}`}>
            {hasLive
              ? "下方 Queue / Steer 只控制主会话，不控制这些后台子代理。"
              : "这些记录仅供查看，不会加入左侧会话列表。"}
          </p>
        </div>
      )}
    </div>
  );
}
