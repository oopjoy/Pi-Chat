import type { RuntimeCompactionResult } from "./runtime-compaction.js";

type CompactCallback = (...args: any[]) => any;
export interface CompactActionHost {
  PROMPT_PREPARE_TIMEOUT_MS: number;
  SessionNotFoundError: typeof import("../runtime-pool.js").SessionNotFoundError;
  compactRuntime: typeof import("./runtime-compaction.js").compactRuntime;
  randomUUID: typeof import("node:crypto").randomUUID;
  rpcData: typeof import("../rpc-client.js").rpcData;
  beginPromptAdmission: (sessionId: string) => Promise<() => void>;
  runtimePool: { get: (sessionId: string) => any; acquireOperation: CompactCallback; touch: CompactCallback };
  activeSessionId: string;
  ensurePrimaryIdentity: CompactCallback;
  ensureRuntime: (sessionId: string) => Promise<any>;
  rethrowResultPending: (error: unknown, operation: string, fence?: boolean) => never;
  secondaryNeedsRecovery: CompactCallback;
  recoverRuntime: CompactCallback;
  primaryOperationAdmission: { acquire: CompactCallback };
  ensurePrimaryRuntime: CompactCallback;
  options: { rpc: any };
  compactionPendingBySession: Set<string>;
  sessionMutationOutcomePending: (sessionId: string) => boolean;
  scheduler: { runtimeBusyForQueue: CompactCallback; primaryBusyForQueue: CompactCallback };
  lateRpcOutcomeHandler: CompactCallback;
  rpcOutcomeUnknown: (error: unknown) => boolean;
  markRpcOutcomePending: CompactCallback;
  uncertainCompactionBySession: Set<string>;
  broadcastSessionActivity: (sessionId: string) => void;
}

export function createCompactAction(host: CompactActionHost) {
  const {
    PROMPT_PREPARE_TIMEOUT_MS,
    SessionNotFoundError,
    compactRuntime,
    randomUUID,
    rpcData,
  } = host;
  async function compactSession(
    sessionId: string,
    customInstructions: string,
    present: (result: RuntimeCompactionResult) => void,
  ): Promise<void> {
    const releasePromptAdmission = await host.beginPromptAdmission(sessionId);
    let releaseRuntimeOperation: (() => void) | null = null;
    try {
      // A cold/reclaimed persisted Session is neither Primary nor an error.
      // Bind Primary identity before allocating a Secondary so restoration,
      // Gate, recovery, fast mode, and RuntimePool capacity stay App-owned.
      let secondaryRuntime = host.runtimePool.get(sessionId) || null;
      if (!secondaryRuntime && !host.activeSessionId) {
        try {
          await host.ensurePrimaryIdentity();
        } catch (error) {
          host.rethrowResultPending(error, "准备压缩运行时", false);
        }
      }
      const requestedIsPrimary = sessionId === host.activeSessionId;
      if (!requestedIsPrimary && !secondaryRuntime) {
        try {
          secondaryRuntime = await host.ensureRuntime(sessionId);
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            present({ kind: "conflict", error: "该会话尚未启用" });
            return;
          }
          throw error;
        }
      }
      if (secondaryRuntime) {
        releaseRuntimeOperation = host.runtimePool.acquireOperation(secondaryRuntime);
        host.runtimePool.touch(secondaryRuntime);
        if (host.secondaryNeedsRecovery(secondaryRuntime))
          await host.recoverRuntime(secondaryRuntime);
      } else {
        releaseRuntimeOperation = host.primaryOperationAdmission.acquire().release;
        try {
          await host.ensurePrimaryRuntime();
        } catch (error) {
          host.rethrowResultPending(error, "准备压缩运行时", false);
        }
      }
      const targetRpc = secondaryRuntime?.rpc || host.options.rpc;
      const result = await compactRuntime({
        outcomePending: () =>
          host.compactionPendingBySession.has(sessionId) ||
          host.sessionMutationOutcomePending(sessionId),
        busy: () => secondaryRuntime
          ? host.scheduler.runtimeBusyForQueue(secondaryRuntime)
          : host.scheduler.primaryBusyForQueue(),
        newOutcomeToken: () => randomUUID(),
        sendCompact: async (command: any, outcomeToken: any) => rpcData(
          await targetRpc.send(
            command,
            PROMPT_PREPARE_TIMEOUT_MS,
            {
              onLateResponse: host.lateRpcOutcomeHandler(
                sessionId,
                outcomeToken,
                "compact",
              ),
            },
          ),
        ),
        outcomeUnknown: (error: any) => host.rpcOutcomeUnknown(error),
        markOutcomePending: (error: any, token: any) =>
          host.markRpcOutcomePending(sessionId, error, token),
        markUncertainCompaction: () => host.uncertainCompactionBySession.add(sessionId),
        broadcastActivity: () => host.broadcastSessionActivity(sessionId),
        rethrowResultPending: (error: any) => host.rethrowResultPending(error, "上下文压缩"),
      }, customInstructions);
      // Preserve the response-write-before-admission-release boundary. A
      // same-Session Prompt may not pass this compact transaction until its
      // caller has received the compact outcome.
      present(result);
    } finally {
      releaseRuntimeOperation?.();
      releasePromptAdmission();
    }
  }


  return compactSession;
}
