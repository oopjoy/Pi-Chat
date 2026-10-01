import type { SessionForkOrigin } from "../../shared/types.js";
import type { SecondaryRuntime } from "../runtime-pool.js";

export function createSessionCopyOriginActions(host: Record<string, any>) {
  const {
    executeSessionCopyRpc,
    idForPath,
    validateCopiedSessionIdentity,
  } = host;
  function reportSessionRelationFailure(operation: string, error: unknown): void {
    console.error(`[Pi Chat] Session relation ${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  async function forkOriginForSession(destinationSessionId: string): Promise<SessionForkOrigin | undefined> {
    let relation;
    try { relation = await host.sessionRelations.getForkOrigin(destinationSessionId); }
    catch (error) {
      host.reportSessionRelationFailure("read", error);
      return undefined;
    }
    if (!relation) return undefined;
    const runtime = host.runtimePool.get(relation.sourceSessionId);
    let source = runtime?.summarySnapshot
      || (relation.sourceSessionId === host.activeSessionId ? host.primarySummarySnapshot : undefined)
      || host.options.sessions.summaryForId(relation.sourceSessionId);
    if (!source) {
      try { source = await host.options.sessions.cachedSummaryForId(relation.sourceSessionId); }
      catch { /* An unavailable source is still valid Fork provenance. */ }
    }
    return {
      ...relation,
      sourceName: source?.name || relation.sourceName,
      sourceAvailable: Boolean(source),
    };
  }

  async function runBoundSessionCopy(input: {
    id: string;
    sourcePath: string;
    mode: "clone" | "fork";
    entryId?: string;
    runtime?: SecondaryRuntime;
    knownSessionIds: ReadonlySet<string>;
  }): Promise<{ sessionId: string; sessionPath: string; piSessionId: string; warning?: string } | null> {
    const rpc = input.runtime?.rpc || host.options.rpc;
    let committed: { sessionId: string; sessionPath: string; piSessionId: string; warning?: string } | null = null;
    host.copyingSessionIds.add(input.id);
    try {
      const copyResult = await executeSessionCopyRpc({
        host: {
          lateRpcOutcomeHandler: (id: any, token: any) => host.lateRpcOutcomeHandler(id, token, "copy"),
          markRpcOutcomePending: (id: any, error: any, token: any) => host.markRpcOutcomePending(id, error, token),
          installOutcomeFence: (id: any, token: any) => host.installRpcOutcomeFence(id, token),
          addCopyOutcomePending: (id: any) => host.copyOutcomePendingSessionIds.add(id),
        },
        rpc,
        sourceSessionId: input.id,
        mode: input.mode,
        entryId: input.entryId,
      });
      committed = validateCopiedSessionIdentity({
        sourcePath: input.sourcePath,
        sourceSessionId: input.id,
        sessionIdForPath: (path: any) => idForPath(path),
        state: copyResult.state,
        knownSessionIds: input.knownSessionIds,
        liveRuntimeIds: new Set(host.runtimePool.runtimes.keys()),
        activeSessionId: host.activeSessionId,
        cancelled: copyResult.cancelled,
        mutationOutcomeUnknown: copyResult.mutationOutcomeUnknown,
        copyMayHaveCommitted: copyResult.copyMayHaveCommitted,
        installOutcomeFence: () => host.installRpcOutcomeFence(input.id, copyResult.outcomeToken),
        mode: input.mode,
      });
      return committed;
    } finally {
      host.copyingSessionIds.delete(input.id);
      try {
        if (input.runtime) {
          input.runtime.failed = true;
          // copySession closed this Runtime's admission for the duration of
          // the attached-writer transaction; its owner may recover in place
          // before the outer finally reopens that exact generation.
          await host.runtimePool.recover(input.runtime, true);
        } else {
          await host.restartPrimaryRuntime(input.sourcePath);
        }
      } catch (error) {
        if (!committed) throw error;
        if (!input.runtime) host.primaryFailed = true;
        host.copyRecoveryPendingSessionIds.add(input.id);
        host.recordRuntimeFailure(input.id, error);
        console.error(`[Pi Chat] Session copy source recovery failed: ${error instanceof Error ? error.message : String(error)}`);
        committed.warning = "新对话已创建，但原对话恢复尚未确认；请勿重复操作";
      }
    }
  }


  return {
    reportSessionRelationFailure,
    forkOriginForSession,
    runBoundSessionCopy,
  };
}
