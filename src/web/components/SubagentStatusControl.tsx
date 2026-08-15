import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type { BackgroundSubagentSnapshot, BackgroundSubagentStatus, BackgroundSubagentStep } from "../../shared/types";
import { useBackgroundSubagents } from "../hooks/use-background-subagents";
import { ChevronDownIcon, SubagentsIcon } from "./Icons";

const STATUS_LABEL: Record<BackgroundSubagentStatus, string> = {
  running: "运行中",
  waiting: "等待中",
  attention: "需要关注",
  complete: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const EMPTY: BackgroundSubagentSnapshot = {
  total: 0,
  activeCount: 0,
  attentionCount: 0,
  truncated: false,
  steps: [],
};

type Placement = {
  top: number;
  popoverLeft: number;
  popoverWidth: number;
  popoverMaxHeight: number;
  tooltipLeft: number;
  tooltipWidth: number;
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
  const [placement, setPlacement] = useState<Placement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const appearedRef = useRef(false);
  if (snapshot.total > 0) appearedRef.current = true;
  const shown = snapshot.total > 0 ? snapshot : appearedRef.current ? EMPTY : snapshot;
  const hasLive = shown.activeCount > 0 || shown.attentionCount > 0;

  const updatePlacement = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || window.innerWidth <= 640) {
      setPlacement(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
    const margin = 12;
    const popoverWidth = Math.min(390, Math.max(240, viewportWidth - margin * 2));
    const tooltipWidth = Math.min(320, Math.max(180, viewportWidth - margin * 2));
    const clampLeft = (wanted: number, width: number) =>
      Math.min(Math.max(margin, wanted), Math.max(margin, viewportWidth - width - margin));
    const top = Math.max(margin, rect.bottom + 7);
    setPlacement({
      top,
      popoverLeft: clampLeft(rect.left, popoverWidth),
      popoverWidth,
      popoverMaxHeight: Math.max(120, viewportHeight - top - margin),
      tooltipLeft: clampLeft(rect.left, tooltipWidth),
      tooltipWidth,
    });
  }, []);

  useEffect(() => {
    appearedRef.current = false;
    setOpen(false);
    setPlacement(null);
  }, [sessionId]);

  useLayoutEffect(() => {
    if (!appearedRef.current) return;
    updatePlacement();
  }, [shown.total, updatePlacement]);

  useEffect(() => {
    if (!appearedRef.current) return;
    const update = () => updatePlacement();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [updatePlacement]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (snapshot.total !== 0 || !open) return;
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }, [snapshot.total, open]);

  if (!appearedRef.current) return null;

  const openAndFocus = () => {
    updatePlacement();
    setOpen(true);
    queueMicrotask(() => popoverRef.current?.focus());
  };
  const onPopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  };
  const tooltip = "后台子代理仅供查看；Queue / Steer 始终只控制主会话";
  const ariaLabel = shown.total === 0
    ? "后台子代理状态暂不可用或已结束"
    : `${shown.total} 个后台子代理，${shown.attentionCount} 个需要关注，${shown.activeCount} 个运行中`;
  const tooltipStyle: CSSProperties | undefined = placement ? {
    top: placement.top,
    left: placement.tooltipLeft,
    width: placement.tooltipWidth,
  } : undefined;
  const popoverStyle: CSSProperties | undefined = placement ? {
    top: placement.top,
    left: placement.popoverLeft,
    width: placement.popoverWidth,
    maxHeight: placement.popoverMaxHeight,
  } : undefined;

  return (
    <div className="subagent-status-control" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`subagent-status-trigger${open ? " is-open" : ""}${shown.attentionCount ? " has-attention" : hasLive ? " has-active" : ""}${shown.total === 0 ? " is-empty" : ""}`}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="background-subagent-popover"
        aria-describedby={open ? undefined : "background-subagent-tooltip"}
        onClick={() => open ? setOpen(false) : shown.total > 0 && openAndFocus()}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || shown.total === 0) return;
          event.preventDefault();
          openAndFocus();
        }}
      >
        <span className="subagent-status-indicator" aria-hidden="true"><SubagentsIcon /></span>
        <span>{shown.total > 0 ? `${shown.total} 个子代理` : "子代理已结束"}</span>
        {shown.total > 0 && <ChevronDownIcon className="subagent-status-chevron" aria-hidden="true" />}
      </button>
      {!open && <span id="background-subagent-tooltip" role="tooltip" className="subagent-status-tooltip" style={tooltipStyle}>{tooltip}</span>}
      {open && (
        <div
          ref={popoverRef}
          id="background-subagent-popover"
          role="dialog"
          aria-label="后台子代理状态"
          className="subagent-status-popover"
          style={popoverStyle}
          tabIndex={-1}
          onKeyDown={onPopoverKeyDown}
        >
          <div className="subagent-status-heading">
            <strong>后台子代理</strong>
            <span>只读投影</span>
          </div>
          <div className="subagent-status-list">
            {shown.steps.map((step) => <StepRow key={step.key} step={step} />)}
          </div>
          {shown.truncated && <p className="subagent-status-truncated">仅显示优先级最高的 24 个步骤。</p>}
          <p className={`subagent-status-authority${hasLive ? " is-important" : ""}`}>
            Queue / Steer 始终只控制主会话；这些后台子代理仅供查看，不会加入左侧会话列表。
          </p>
        </div>
      )}
    </div>
  );
}
