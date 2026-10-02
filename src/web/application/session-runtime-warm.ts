import type { SessionRuntimeReadyData } from "../../shared/types";
import type { PaneAuthoritySnapshot } from "./pane-authority";
export function applyWarmReadiness(host: Record<string, any>, sessionId: string, ready: SessionRuntimeReadyData, authority: PaneAuthoritySnapshot, capabilityOnly = false): unknown {
  const state = capabilityOnly ? { isStreaming: ready.state.isStreaming } : ready.state;
  return host.commitPaneIfCurrent(authority, { type: "RUNTIME_READY", sessionId, state });
}

export function joinWarmPane(host: Record<string, any>, sessionId: string, authority: PaneAuthoritySnapshot): void {
  const warm = host.warmingRuntime(sessionId);
  if (!warm) return;
  void warm.then((ready: SessionRuntimeReadyData) => {
    applyWarmReadiness(host, sessionId, ready, authority, true);
  }).catch((cause: unknown) => {
    if (!host.commitPaneIfCurrent(authority, { type: "RUNTIME_FAILED", sessionId })) return;
    host.setError(cause instanceof Error ? cause.message : String(cause));
  });
}

export function warmSessionRuntime(host: Record<string, any>, sessionId: string): Promise<SessionRuntimeReadyData> {
  if (!sessionId) return Promise.reject(new Error("会话标识无效"));
  const existing = host.warmingRuntime(sessionId);
  if (existing) return existing;
  const runEpochGeneration = host.runEpochGeneration();
  const cacheAuthority = host.captureCacheAuthority(runEpochGeneration);
  host.setRuntimeWarming(sessionId, true);
  const start = host.apiWarmSession(sessionId)
    .then((ready: any) => {
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
