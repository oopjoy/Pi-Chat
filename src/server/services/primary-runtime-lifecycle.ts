import { randomUUID } from "node:crypto";
import { idForPath } from "../session-index.js";
import type { GateMode, PiState } from "../../shared/types.js";
import type { PiRpcClient } from "../rpc-client.js";
import type { PrimaryRuntimeReadinessBridge } from "../primary-runtime-readiness.js";
import { PROMPT_PREPARE_TIMEOUT_MS } from "../prompt-scheduler.js";

export interface PrimaryRuntimeLifecyclePorts {
  closed(): boolean;
  primaryRuntime?: PrimaryRuntimeReadinessBridge;
  isConcreteReadinessController(): boolean;
  rpc: PiRpcClient;
  primaryRuntimeCwd(): string;
  activeSessionId(): string;
  currentGateMode(): GateMode;
  recoverPrimary(runtime: PrimaryRuntimeReadinessBridge, sessionFile: string | undefined, cwd: string): Promise<void>;
  legacyRestart(sessionFile: string | undefined, cwd: string): Promise<void>;
  lateRpcOutcomeHandler(sessionId: string, token: string): (response: Record<string, unknown>) => void;
  markRpcOutcomePending(sessionId: string, error: unknown, token: string): void;
  isOutcomeUnknown(error: unknown): boolean;
  fencePrimaryOperation(): void;
  setPrimaryGateMode(mode: GateMode): void;
}

export async function restartPrimaryRuntime(
  ports: PrimaryRuntimeLifecyclePorts,
  sessionFile?: string,
  cwd = ports.primaryRuntimeCwd(),
): Promise<void> {
  if (ports.closed()) throw new Error("Pi Chat 已关闭");
  if (cwd !== ports.primaryRuntimeCwd())
    throw new Error("Primary Runtime 工作目录不可在原进程上重绑定");
  if (ports.primaryRuntime) {
    ports.rpc.setDiagnosticSessionId?.(
      sessionFile ? idForPath(sessionFile) : ports.activeSessionId(),
    );
    await ports.recoverPrimary(ports.primaryRuntime, sessionFile, cwd);
    if (ports.isConcreteReadinessController()) return;
  } else {
    await ports.legacyRestart(sessionFile, cwd);
  }
  if (ports.closed()) return;
  const desiredGateMode = sessionFile ? ports.currentGateMode() : "strict";
  if (desiredGateMode !== "strict") {
    const outcomeToken = randomUUID();
    try {
      await ports.rpc.send(
        { type: "prompt", message: `/gate ${desiredGateMode}` },
        PROMPT_PREPARE_TIMEOUT_MS,
        { onLateResponse: ports.lateRpcOutcomeHandler(ports.activeSessionId(), outcomeToken) },
      );
    } catch (error) {
      ports.markRpcOutcomePending(ports.activeSessionId(), error, outcomeToken);
      if (ports.isOutcomeUnknown(error)) ports.fencePrimaryOperation();
      throw error;
    }
    if (ports.closed()) return;
  }
  ports.setPrimaryGateMode(desiredGateMode);
}

export interface PrimaryReloadPorts {
  getPrimaryState(): Promise<PiState>;
  stopSecondaryRuntimes(): Promise<void>;
  restartPrimary(sessionFile?: string): Promise<void>;
  rethrowResultPending(error: unknown, operation: string): never;
  broadcastReloaded(): void;
}

/** Replace all child/Primary Runtime processes after a resource mutation. */
export async function reloadPrimaryResources(
  ports: PrimaryReloadPorts,
  knownState?: PiState,
): Promise<void> {
  const state = knownState || await ports.getPrimaryState();
  if (state.isStreaming)
    throw new Error("请先停止所有并行生成，再修改资源配置");
  try {
    await ports.stopSecondaryRuntimes();
    await ports.restartPrimary(state.sessionFile);
  } catch (error) {
    ports.rethrowResultPending(error, "配置重载");
  }
  ports.broadcastReloaded();
}
