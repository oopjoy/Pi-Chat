import type { DraftRuntimeLease } from "../runtime-pool.js";

export interface NewDraftPreparationPorts {
  primaryNeedsRecovery(): boolean;
  waitForPrimaryCompatibility(): Promise<void>;
  acquireDraft(clientId: string, cwd: string): Promise<DraftRuntimeLease>;
  rethrowResultPending(error: unknown, operation: string): never;
  markViewed(clientId: string, sessionId: string): void;
}

/** Prepare a New draft while preserving Primary overlap and lease ownership. */
export async function prepareNewDraftRuntime(
  ports: NewDraftPreparationPorts,
  input: { clientId: string; cwd: string },
): Promise<{ lease: DraftRuntimeLease }> {
  const primaryWasFailed = ports.primaryNeedsRecovery();
  if (primaryWasFailed) {
    try { await ports.waitForPrimaryCompatibility(); }
    catch (error) { ports.rethrowResultPending(error, "准备新会话运行时"); }
  }
  let lease: DraftRuntimeLease;
  try {
    lease = await ports.acquireDraft(input.clientId, input.cwd);
  } catch (error) {
    ports.rethrowResultPending(error, "新建会话");
  }
  if (!primaryWasFailed) {
    try { await ports.waitForPrimaryCompatibility(); }
    catch (error) { ports.rethrowResultPending(error, "准备新会话运行时"); }
  }
  ports.markViewed(input.clientId, lease.runtime.id);
  return { lease };
}
