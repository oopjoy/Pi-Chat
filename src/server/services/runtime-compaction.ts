export type RuntimeCompactionResult =
  | { kind: "conflict"; error: string; code?: string }
  | { kind: "success"; result: Record<string, unknown> };

export interface RuntimeCompactionPorts {
  outcomePending(): boolean;
  busy(): boolean;
  newOutcomeToken(): string;
  sendCompact(
    command: Record<string, unknown>,
    outcomeToken: string,
  ): Promise<Record<string, unknown>>;
  outcomeUnknown(error: unknown): boolean;
  markOutcomePending(error: unknown, outcomeToken: string): void;
  markUncertainCompaction(): void;
  broadcastActivity(): void;
  rethrowResultPending(error: unknown): never;
}

/**
 * Compact one already-resolved Runtime. Session admission, target resolution,
 * leases, and Queue authority remain in App; the service owns only compact's
 * result-uncertainty transaction once an RPC target is stable.
 */
export async function compactRuntime(
  ports: RuntimeCompactionPorts,
  customInstructions: string,
): Promise<RuntimeCompactionResult> {
  if (ports.outcomePending())
    return {
      kind: "conflict",
      error: "上一次操作结果尚未确认；请刷新页面核对，不要重复压缩",
      code: "RESULT_PENDING",
    };
  if (ports.busy())
    return { kind: "conflict", error: "请先停止该会话的生成并清空队列" };

  const outcomeToken = ports.newOutcomeToken();
  try {
    const result = await ports.sendCompact({
      type: "compact",
      ...(customInstructions ? { customInstructions } : {}),
    }, outcomeToken);
    return { kind: "success", result };
  } catch (error) {
    if (ports.outcomeUnknown(error)) {
      ports.markOutcomePending(error, outcomeToken);
      // A compaction_start event proves activity, not that the RPC write was
      // accepted; retain the mutation fence until a lifecycle boundary.
      ports.markUncertainCompaction();
      ports.broadcastActivity();
    }
    ports.rethrowResultPending(error);
  }
}
