import type { FileSnapshot } from "../file-transaction.js";

export interface ModelFileTransactionHost {
  snapshot(): Promise<FileSnapshot>;
  restore(snapshot: FileSnapshot): Promise<void>;
  invalidateCatalogue(): void;
  rethrowResultPending(error: unknown, operation: string): never;
}

/** Atomic models.json mutation boundary; ModelManager remains file authority. */
export async function applyModelFileTransaction<T>(
  host: ModelFileTransactionHost,
  operation: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const snapshot = await host.snapshot();
  let changed = false;
  try {
    const result = await mutation();
    changed = true;
    host.invalidateCatalogue();
    return result;
  } catch (error) {
    if (changed) {
      await host.restore(snapshot);
      host.invalidateCatalogue();
      throw new Error(
        `模型配置失败，原配置已自动恢复：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    host.rethrowResultPending(error, operation);
    throw error;
  }
}
