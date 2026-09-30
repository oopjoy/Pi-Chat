import type { ApplicationLifecycle, PiMessage, QueuedPrompt } from "../../shared/types";
import type { LocalUserTurn } from "../lib/local-user-turn";
import { activeSessionIdsFromEvent } from "../lib/active-sessions";
import { isApplicationLifecycle } from "./application-lifecycle";

export interface ActiveSessionChangedEffect {
  activeSessionIds: string[];
  sessionId: string;
  viewedSessionBecameViewOnly: boolean;
}

/** Pure projection for the active-session lifecycle event group. */
export function deriveActiveSessionChangedEffect(
  event: Record<string, unknown>,
  viewedSessionId: string,
): ActiveSessionChangedEffect {
  const activeSessionIds = activeSessionIdsFromEvent(event.activeSessionIds);
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  return {
    activeSessionIds,
    sessionId,
    viewedSessionBecameViewOnly: Boolean(
      sessionId
      && sessionId === viewedSessionId
      && !activeSessionIds.includes(sessionId),
    ),
  };
}

export interface QueueSnapshotEffect {
  queue: QueuedPrompt[];
  paused: boolean;
  admittedId?: string;
}

export function deriveQueueSnapshotEffect(
  event: Record<string, unknown>,
): QueueSnapshotEffect | null {
  if (!Array.isArray(event.queue)) return null;
  return {
    queue: event.queue as QueuedPrompt[],
    paused: event.paused === true,
    ...(typeof event.admittedId === "string" ? { admittedId: event.admittedId } : null),
  };
}

export function deriveGateModeChangedEffect(
  event: Record<string, unknown>,
): { mode: "strict" | "open" } | null {
  return event.mode === "strict" || event.mode === "open"
    ? { mode: event.mode }
    : null;
}

export function deriveExtensionRequestResolvedEffect(
  event: Record<string, unknown>,
): { requestId: string } | null {
  return typeof event.id === "string" ? { requestId: event.id } : null;
}

export function derivePromptDeliveryUncertainEffect(): { notice: string } {
  return { notice: "消息已交给 Pi，正在确认执行状态；请勿重复发送" };
}

export function deriveWorkspaceChangedEffect(
  event: Record<string, unknown>,
  fallbackEpoch: string,
  fallbackRevision: number,
): { cwd: string; workspaceEpoch: string; workspaceRevision: number } | null {
  const cwd = typeof event.cwd === "string" ? event.cwd : "";
  if (!cwd) return null;
  const workspaceEpoch = typeof event.workspaceEpoch === "string"
    ? event.workspaceEpoch
    : fallbackEpoch;
  const workspaceRevision = typeof event.workspaceRevision === "number"
    && Number.isFinite(event.workspaceRevision)
    ? event.workspaceRevision
    : fallbackRevision;
  return { cwd, workspaceEpoch, workspaceRevision };
}

export function deriveSessionMutationEffect(
  event: Record<string, unknown>,
): { action: string; sessionId: string; structural: boolean } {
  const action = String(event.action || "");
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  return {
    action,
    sessionId,
    structural: ["deleted", "renamed"].includes(action),
  };
}

export interface QueueErrorTurnPlan {
  affectedQueueIds: string[];
  failedRenderedMessages: PiMessage[];
}

export function planQueueErrorTurns(
  turns: readonly LocalUserTurn[],
  queuedIds: ReadonlySet<string>,
  failedId: string,
): QueueErrorTurnPlan {
  const affectedQueueIds: string[] = [];
  const failedRenderedMessages: PiMessage[] = [];
  for (const turn of turns) {
    if (!turn.queueId || !queuedIds.has(turn.queueId)) continue;
    affectedQueueIds.push(turn.queueId);
    if (turn.queueId === failedId && turn.renderedInTranscript)
      failedRenderedMessages.push(turn.message);
  }
  return { affectedQueueIds, failedRenderedMessages };
}

export interface SessionControlChangedEffect {
  sessionId: string;
  controlOwner?: string;
  controlledByThisWindow: boolean;
}

export function deriveSessionControlChangedEffect(
  event: Record<string, unknown>,
): SessionControlChangedEffect {
  return {
    sessionId: typeof event.sessionId === "string" ? event.sessionId : "",
    ...(typeof event.controlOwner === "string" ? { controlOwner: event.controlOwner } : null),
    controlledByThisWindow: event.controlledByThisWindow === true,
  };
}

export function deriveFastModeChangedEffect(
  event: Record<string, unknown>,
): { active: boolean } {
  return { active: event.active === true };
}

export interface QueueDispatchEffect {
  id: string;
  message: string;
  clientPromptOperationId: string;
  imageCount: number;
  settings: unknown;
}

export function deriveQueueDispatchEffect(
  event: Record<string, unknown>,
): QueueDispatchEffect {
  const imageCount = typeof event.imageCount === "number" && Number.isFinite(event.imageCount)
    ? event.imageCount
    : 0;
  return {
    id: typeof event.id === "string" ? event.id : "",
    message: typeof event.message === "string" ? event.message : "",
    clientPromptOperationId:
      typeof event.piChatClientPromptOperationId === "string"
        ? event.piChatClientPromptOperationId
        : "",
    imageCount,
    settings: event.settings,
  };
}

export interface QueueErrorEffect {
  queue: QueuedPrompt[];
  paused: boolean;
  failedId: string;
}

export function deriveQueueErrorEffect(
  event: Record<string, unknown>,
  fallback: { queue: QueuedPrompt[]; paused: boolean },
): QueueErrorEffect {
  return {
    queue: Array.isArray(event.queue) ? event.queue as QueuedPrompt[] : fallback.queue,
    paused: event.paused === true || fallback.paused,
    failedId: typeof event.id === "string" ? event.id : "",
  };
}

export interface PromptRetryEffect {
  isRetryLifecycle: boolean;
  retryPhase: "scheduled" | "running" | "exhausted";
  serverPromptId?: string;
  retryAttempt?: number;
  retryAttempts?: number;
  maxAttempts?: number;
  delayMs?: number;
  status: string;
  provider?: string;
  model?: string;
  api?: string;
}

export function derivePromptRetryEffect(
  type: string,
  event: Record<string, unknown>,
): PromptRetryEffect {
  const retryAttempt = typeof event.retryAttempt === "number" ? event.retryAttempt : undefined;
  const retryAttempts = typeof event.retryAttempts === "number" ? event.retryAttempts : undefined;
  const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : undefined;
  const delayMs = typeof event.delayMs === "number" ? event.delayMs : undefined;
  const isRetryLifecycle = type === "pi_chat_prompt_retry_scheduled"
    || type === "pi_chat_prompt_retry_started"
    || type === "pi_chat_prompt_retry_exhausted";
  const serverPromptId = typeof event.piChatPromptId === "string"
    ? event.piChatPromptId
    : undefined;
  const retryPhase = type === "pi_chat_prompt_retry_scheduled"
    ? "scheduled" as const
    : type === "pi_chat_prompt_retry_started"
      ? "running" as const
      : "exhausted" as const;
  const status = type === "pi_chat_prompt_retry_scheduled"
    ? `Pi 正在等待重试${retryAttempt !== undefined && maxAttempts !== undefined ? `（第 ${retryAttempt}/${maxAttempts} 次）` : "…"}`
    : type === "pi_chat_prompt_retry_started"
      ? `Pi 正在重试${retryAttempt !== undefined && retryAttempts !== undefined ? `（第 ${retryAttempt}/${retryAttempts} 次）` : "…"}`
      : type === "pi_chat_prompt_retry_exhausted"
        ? "Pi 原生重试已耗尽"
        : "Pi Prompt 执行失败";
  return {
    isRetryLifecycle,
    retryPhase,
    ...(serverPromptId ? { serverPromptId } : null),
    ...(retryAttempt !== undefined ? { retryAttempt } : null),
    ...(retryAttempts !== undefined ? { retryAttempts } : null),
    ...(maxAttempts !== undefined ? { maxAttempts } : null),
    ...(delayMs !== undefined ? { delayMs } : null),
    status,
    ...(typeof event.provider === "string" ? { provider: event.provider } : null),
    ...(typeof event.model === "string" ? { model: event.model } : null),
    ...(typeof event.api === "string" ? { api: event.api } : null),
  };
}

export interface ApplicationLifecycleEffect {
  lifecycle: ApplicationLifecycle;
  notice?: string;
  cancelsNavigation: boolean;
  startsIdleRecovery: boolean;
}

/** Pure projection for the application-lifecycle SSE event group. */
export function deriveApplicationLifecycleEffect(
  incoming: unknown,
): ApplicationLifecycleEffect | null {
  if (!isApplicationLifecycle(incoming)) return null;
  const lifecycle = incoming;
  const notice = lifecycle === "restarting"
    ? "Pi Chat 正在构建并重启，暂时停止接收新操作…"
    : lifecycle === "workspace-changing"
      ? "正在切换工作目录…"
      : lifecycle === "resources-reloading"
        ? "正在更新配置并重载 Runtime…"
        : lifecycle === "models-refreshing"
          ? "正在刷新模型目录…"
          : undefined;
  return {
    lifecycle,
    ...(notice ? { notice } : null),
    cancelsNavigation: lifecycle !== "idle",
    startsIdleRecovery: lifecycle === "idle",
  };
}
