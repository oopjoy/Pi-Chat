import { resolve } from "node:path";
import type { SessionCopyData, SessionForkOrigin, SessionSummary } from "../../shared/types.js";
import { HttpRequestError } from "../http-transport.js";

export interface CopiedSessionIdentity {
  sessionId: string;
  sessionPath: string;
  piSessionId: string;
  warning?: string;
}

export interface SessionCopyFinalizeHost {
  now(): number;
  recordFork(destinationSessionId: string, origin: Omit<SessionForkOrigin, "sourceAvailable">): Promise<void>;
  reportRelationFailure(operation: string, error: unknown): void;
  listSessions(): Promise<unknown>;
  summaryForId(sessionId: string): SessionSummary | null;
  pathForId(sessionId: string): string | null;
  markProjectionPending(sourceSessionId: string): void;
  clearOutcome(sourceSessionId: string): void;
  broadcastCopied(input: { action: "cloned" | "forked"; sessionId: string; sourceSessionId: string }): void;
}

export async function finalizeSessionCopy(input: {
  host: SessionCopyFinalizeHost;
  sourceSessionId: string;
  sourceName: string;
  mode: "clone" | "fork";
  copied: CopiedSessionIdentity;
  forkTarget?: { text: string; images: SessionCopyData["editorImages"] };
  persistedMessageId?: string;
}): Promise<SessionCopyData> {
  const { host, sourceSessionId, sourceName, mode, copied } = input;
  let forkOrigin: SessionForkOrigin | undefined;
  let copyWarning = copied.warning || "";
  if (input.forkTarget && input.persistedMessageId) {
    const storedOrigin: Omit<SessionForkOrigin, "sourceAvailable"> = {
      sourceSessionId,
      sourceName,
      sourcePersistedMessageId: input.persistedMessageId,
      createdAt: host.now(),
    };
    try {
      await host.recordFork(copied.sessionId, storedOrigin);
      forkOrigin = { ...storedOrigin, sourceAvailable: true };
    } catch (error) {
      host.reportRelationFailure("write", error);
      copyWarning ||= "新对话已创建，但分叉来源关系尚未保存；请勿重复操作";
    }
  }
  try {
    await host.listSessions();
  } catch {
    host.markProjectionPending(sourceSessionId);
    throw new HttpRequestError(409, "新对话已创建，但列表索引尚未确认；请刷新页面核对，不要重复操作");
  }
  const session = host.summaryForId(copied.sessionId);
  const indexedPath = host.pathForId(copied.sessionId);
  if (
    !session
    || !indexedPath
    || resolve(indexedPath).toLowerCase() !== resolve(copied.sessionPath).toLowerCase()
    || session.sessionId !== copied.piSessionId
  ) {
    host.markProjectionPending(sourceSessionId);
    throw new HttpRequestError(409, "新对话已创建，但列表索引尚未确认；请刷新页面核对，不要重复操作");
  }
  host.clearOutcome(sourceSessionId);
  host.broadcastCopied({
    action: mode === "clone" ? "cloned" : "forked",
    sessionId: session.id,
    sourceSessionId,
  });
  return {
    session,
    ...(input.forkTarget ? { editorText: input.forkTarget.text, editorImages: input.forkTarget.images } : null),
    ...(forkOrigin ? { forkOrigin } : null),
    ...(copyWarning ? { warning: copyWarning } : null),
  };
}
