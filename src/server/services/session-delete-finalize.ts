import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";

export interface SessionDeleteFinalizeHost {
  getForkOrigin(sessionId: string): Promise<unknown | undefined>;
  removeForkDestination(sessionId: string): Promise<void>;
  restoreForkOrigin(sessionId: string, origin: unknown): Promise<void>;
  reportRelationFailure(operation: string, error: unknown): void;
  validateDeletePath(path: string, sessionId: string): Promise<string>;
  clearDeletedSessionState(sessionId: string): void;
  refreshSessions(): Promise<void>;
  broadcastDeleted(sessionId: string): void;
  bootstrap(): Promise<unknown>;
}

/** Final destructive Session boundary: relation rollback, unlink, and cleanup. */
export async function finalizeSessionDelete(
  host: SessionDeleteFinalizeHost,
  sessionId: string,
  path: string | undefined,
): Promise<unknown> {
  const removedForkOrigin = await host.getForkOrigin(sessionId);
  await host.removeForkDestination(sessionId);
  try {
    if (path && existsSync(path)) {
      const safePath = await host.validateDeletePath(path, sessionId);
      await unlink(safePath);
    }
  } catch (error) {
    if (removedForkOrigin !== undefined) {
      try {
        await host.restoreForkOrigin(sessionId, removedForkOrigin);
      } catch (restoreError) {
        host.reportRelationFailure("delete-rollback", restoreError);
      }
    }
    throw error;
  }
  host.clearDeletedSessionState(sessionId);
  await host.refreshSessions();
  host.broadcastDeleted(sessionId);
  return host.bootstrap();
}
