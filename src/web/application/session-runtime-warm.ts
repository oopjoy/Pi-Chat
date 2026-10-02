import type { GateMode, SessionRuntimeReadyData, SessionViewData } from "../../shared/types";
import type { PaneAuthoritySnapshot } from "./pane-authority";
import type { ConversationPaneAction } from "../state/conversation-pane";
import type { SessionViewCacheWriteAuthority } from "./session-view-cache-writer";

type WarmReadinessAction = Extract<ConversationPaneAction, { type: "RUNTIME_READY" | "RUNTIME_FAILED" }>;

export interface SessionRuntimeWarmHost {
  warmingRuntime: (sessionId: string) => Promise<SessionRuntimeReadyData> | undefined;
  setRuntimeWarming: (sessionId: string, warming: boolean) => void;
  runEpochGeneration: () => number;
  captureCacheAuthority: (generation: number) => SessionViewCacheWriteAuthority;
  cacheAuthorityIsCurrent: (authority: SessionViewCacheWriteAuthority) => boolean;
  apiWarmSession: (sessionId: string) => Promise<SessionRuntimeReadyData>;
  updateGateMode: (sessionId: string, mode: GateMode | undefined, authority?: SessionViewCacheWriteAuthority) => void;
  refreshSessionCacheForAuthority: (id: string, patch: Partial<SessionViewData>, authority: SessionViewCacheWriteAuthority) => unknown;
  clearWarmingRuntime: (sessionId: string) => void;
  setWarmingRuntime: (sessionId: string, promise: Promise<SessionRuntimeReadyData>) => void;
}

type SessionRuntimePaneHost = Pick<SessionRuntimeWarmHost, "warmingRuntime"> & {
  commitPaneIfCurrent: (authority: PaneAuthoritySnapshot, action: WarmReadinessAction) => boolean;
  setError: (message: string) => void;
};

export function applyWarmReadiness(
  host: Pick<SessionRuntimePaneHost, "commitPaneIfCurrent">,
  sessionId: string,
  ready: SessionRuntimeReadyData,
  authority: PaneAuthoritySnapshot,
  capabilityOnly = false,
): unknown {
  const state = capabilityOnly ? { isStreaming: ready.state.isStreaming } : ready.state;
  return host.commitPaneIfCurrent(authority, { type: "RUNTIME_READY", sessionId, state });
}

export function joinWarmPane(
  host: SessionRuntimePaneHost,
  sessionId: string,
  authority: PaneAuthoritySnapshot,
): void {
  const warm = host.warmingRuntime(sessionId);
  if (!warm) return;
  void warm.then((ready) => {
    applyWarmReadiness(host, sessionId, ready, authority, true);
  }).catch((cause: unknown) => {
    if (!host.commitPaneIfCurrent(authority, { type: "RUNTIME_FAILED", sessionId })) return;
    host.setError(cause instanceof Error ? cause.message : String(cause));
  });
}

export function warmSessionRuntime(
  host: SessionRuntimeWarmHost,
  sessionId: string,
): Promise<SessionRuntimeReadyData> {
  if (!sessionId) return Promise.reject(new Error("会话标识无效"));
  const existing = host.warmingRuntime(sessionId);
  if (existing) return existing;
  const runEpochGeneration = host.runEpochGeneration();
  const cacheAuthority = host.captureCacheAuthority(runEpochGeneration);
  host.setRuntimeWarming(sessionId, true);
  const start = host.apiWarmSession(sessionId)
    .then((ready) => {
      if (!host.cacheAuthorityIsCurrent(cacheAuthority)) return ready;
      host.updateGateMode(sessionId, ready.gateMode, cacheAuthority);
      host.refreshSessionCacheForAuthority(sessionId, {
        state: ready.state,
        isActive: true,
        runtimeStatus: "active",
        isStreaming: ready.state.isStreaming,
        gateMode: ready.gateMode,
      }, cacheAuthority);
      return ready;
    })
    .finally(() => {
      if (host.warmingRuntime(sessionId) === start && host.runEpochGeneration() === runEpochGeneration) {
        host.clearWarmingRuntime(sessionId);
        host.setRuntimeWarming(sessionId, false);
      }
    });
  host.setWarmingRuntime(sessionId, start);
  return start;
}
