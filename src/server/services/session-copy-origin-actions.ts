import type { SessionForkOrigin } from "../../shared/types.js";
import type { StoredSessionForkOrigin } from "../session-relations.js";
import type { SecondaryRuntime } from "../runtime-pool.js";
import { idForPath } from "../session-index.js";
import { validateCopiedSessionIdentity, type executeSessionCopyRpc } from "./session-copy-transaction.js";

export interface SessionCopyOriginInput {
  readonly id: string;
  readonly sourcePath: string;
  readonly mode: "clone" | "fork";
  readonly entryId?: string;
  /** Identity-only handle; the App revalidates ownership before using its RPC. */
  readonly runtime?: Readonly<Pick<SecondaryRuntime, "id">>;
  readonly knownSessionIds: ReadonlySet<string>;
}

export interface SessionCopyOriginResult {
  sessionId: string;
  sessionPath: string;
  piSessionId: string;
  warning?: string;
}

type SourceSummary = Readonly<{ name: string }>;

/** Copy/provenance orchestration only; no App object, raw Maps, setters or RPC ownership. */
export interface SessionCopyOriginPorts {
  readOrigin(destinationSessionId: string): Promise<Readonly<StoredSessionForkOrigin> | null>;
  sourceSummary(sourceSessionId: string): SourceSummary | undefined;
  cachedSourceSummary(sourceSessionId: string): Promise<SourceSummary | undefined>;
  executeCopy(input: SessionCopyOriginInput): ReturnType<typeof executeSessionCopyRpc>;
  activeSessionId(): string;
  liveRuntimeIds(): ReadonlySet<string>;
  /** Synchronous state effects must not accidentally accept async callbacks. */
  setCopying(sessionId: string, copying: boolean): undefined;
  recoverSource(input: SessionCopyOriginInput): Promise<void>;
  recordCommittedRecoveryFailure(input: SessionCopyOriginInput, error: unknown): undefined;
  installOutcomeFence(sessionId: string, token: string): undefined;
}

export function createSessionCopyOriginActions(ports: SessionCopyOriginPorts) {
  function reportSessionRelationFailure(operation: string, error: unknown): void {
    console.error(`[Pi Chat] Session relation ${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  async function forkOriginForSession(destinationSessionId: string): Promise<SessionForkOrigin | undefined> {
    let relation: Readonly<StoredSessionForkOrigin> | null;
    try { relation = await ports.readOrigin(destinationSessionId); }
    catch (error) {
      reportSessionRelationFailure("read", error);
      return undefined;
    }
    if (!relation) return undefined;
    let source = ports.sourceSummary(relation.sourceSessionId);
    if (!source) {
      try { source = await ports.cachedSourceSummary(relation.sourceSessionId); }
      catch { /* An unavailable source is still valid Fork provenance. */ }
    }
    return {
      ...relation,
      sourceName: source?.name || relation.sourceName,
      sourceAvailable: Boolean(source),
    };
  }

  async function runBoundSessionCopy(input: SessionCopyOriginInput): Promise<SessionCopyOriginResult | null> {
    let committed: SessionCopyOriginResult | null = null;
    ports.setCopying(input.id, true);
    try {
      const copyResult = await ports.executeCopy(input);
      committed = validateCopiedSessionIdentity({
        sourcePath: input.sourcePath,
        sourceSessionId: input.id,
        sessionIdForPath: idForPath,
        state: copyResult.state,
        knownSessionIds: input.knownSessionIds,
        liveRuntimeIds: ports.liveRuntimeIds(),
        activeSessionId: ports.activeSessionId(),
        cancelled: copyResult.cancelled,
        mutationOutcomeUnknown: copyResult.mutationOutcomeUnknown,
        copyMayHaveCommitted: copyResult.copyMayHaveCommitted,
        installOutcomeFence: () => ports.installOutcomeFence(input.id, copyResult.outcomeToken),
        mode: input.mode,
      });
      return committed;
    } finally {
      ports.setCopying(input.id, false);
      try {
        // Restoring the original writer stays with its existing Runtime owner.
        await ports.recoverSource(input);
      } catch (error) {
        if (!committed) throw error;
        ports.recordCommittedRecoveryFailure(input, error);
        console.error(`[Pi Chat] Session copy source recovery failed: ${error instanceof Error ? error.message : String(error)}`);
        committed.warning = "新对话已创建，但原对话恢复尚未确认；请勿重复操作";
      }
    }
  }

  return { reportSessionRelationFailure, forkOriginForSession, runBoundSessionCopy };
}
