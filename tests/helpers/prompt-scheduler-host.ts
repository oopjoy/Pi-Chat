import type { GateMode, PromptSettingsSnapshot } from "../../src/shared/types";
import type {
  PromptSchedulerHost,
} from "../../src/server/prompt-scheduler";
import type { PiRpcClient, RpcRequestObserver } from "../../src/server/rpc-client";
import type {
  AppliedTurnSettings,
  PendingTurnSettings,
  SecondaryRuntime,
} from "../../src/server/runtime-pool";

/**
 * Test-only flat fixture adapter. Production PromptSchedulerHost is grouped by
 * capability; existing scheduler scenarios may override only the dependency
 * relevant to their behavior without duplicating unrelated port defaults.
 */
export interface PromptSchedulerFixture {
  isClosed?: () => boolean;
  isLifecycleIdle?: () => boolean;
  primaryRpc?: () => PiRpcClient;
  activeSessionId?: () => string;
  ensurePrimaryRuntime?: () => Promise<void>;
  recoverRuntime?: (runtime: SecondaryRuntime) => Promise<void>;
  acquirePrimaryOperation?: () => () => void;
  acquireRuntimeOperation?: (runtime: SecondaryRuntime) => () => void;
  touchRuntime?: (runtime: SecondaryRuntime) => void;
  applyPendingTurnSettings?: (
    rpc: PiRpcClient,
    pending: PendingTurnSettings,
  ) => Promise<void>;
  applyPromptSettings?: (
    rpc: PiRpcClient,
    pending: PendingTurnSettings,
    settings?: PromptSettingsSnapshot,
    consumeSupersededLegacy?: boolean,
  ) => Promise<AppliedTurnSettings>;
  onPrimaryPromptSettingsApplied?: (settings: AppliedTurnSettings) => void;
  onRuntimePromptSettingsApplied?: (
    runtime: SecondaryRuntime,
    settings: AppliedTurnSettings,
  ) => void;
  syncGateMode?: (
    rpc: PiRpcClient,
    sessionId: string,
    mode?: GateMode,
  ) => Promise<void>;
  promptRpcObserver?: (
    rpc: PiRpcClient,
    sessionId: string,
    promptId: string,
  ) => RpcRequestObserver | undefined;
  tracePrompt?: (sessionId: string, promptId: string, name: string) => void;
  abandonPromptDiagnostic?: (sessionId: string, promptId: string) => void;
  broadcast?: (event: Record<string, unknown>) => void;
  publishSessionActivity?: (sessionId: string) => void;
  onPrimaryPromptAccepted?: (sessionId: string, promptAt: number) => void;
  onSecondaryPromptAccepted?: (
    runtime: SecondaryRuntime,
    promptAt: number,
  ) => void;
}

export function promptSchedulerHost(
  fixture: PromptSchedulerFixture = {},
): PromptSchedulerHost {
  return {
    runtime: {
      isClosed: fixture.isClosed || (() => false),
      isLifecycleIdle: fixture.isLifecycleIdle || (() => true),
      primaryRpc: fixture.primaryRpc || (() => ({
        send: async () => ({ type: "response", success: true }),
      } as never)),
      activeSessionId: fixture.activeSessionId || (() => "primary"),
      ensurePrimaryRuntime: fixture.ensurePrimaryRuntime || (async () => {}),
      recoverRuntime: fixture.recoverRuntime || (async () => {}),
      acquirePrimaryOperation: fixture.acquirePrimaryOperation || (() => () => {}),
      acquireRuntimeOperation: fixture.acquireRuntimeOperation || (() => () => {}),
      touchRuntime: fixture.touchRuntime || (() => {}),
    },
    preparation: {
      applyPendingTurnSettings: fixture.applyPendingTurnSettings || (async () => {}),
      applyPromptSettings: fixture.applyPromptSettings,
      onPrimaryPromptSettingsApplied: fixture.onPrimaryPromptSettingsApplied,
      onRuntimePromptSettingsApplied: fixture.onRuntimePromptSettingsApplied,
      syncGateMode: fixture.syncGateMode || (async () => {}),
    },
    observation: {
      promptRpcObserver: fixture.promptRpcObserver,
      tracePrompt: fixture.tracePrompt,
      abandonPromptDiagnostic: fixture.abandonPromptDiagnostic,
    },
    publication: {
      broadcast: fixture.broadcast || (() => {}),
      publishSessionActivity: fixture.publishSessionActivity,
      onPrimaryPromptAccepted: fixture.onPrimaryPromptAccepted || (() => {}),
      onSecondaryPromptAccepted: fixture.onSecondaryPromptAccepted || (() => {}),
    },
  };
}
