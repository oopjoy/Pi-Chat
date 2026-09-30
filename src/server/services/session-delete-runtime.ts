import type { PiState } from "../../shared/types.js";
import type { SecondaryRuntime } from "../runtime-pool.js";

export interface SessionDeleteRuntimeHost {
  activeSessionId(): string;
  primaryState(): Promise<PiState>;
  primaryTurnActive(): boolean;
  primaryQueueLength(): number;
  primaryExtensionPending(): boolean;
  resetPrimarySession(): Promise<{ cancelled: boolean }>;
  runtime(sessionId: string): SecondaryRuntime | undefined;
  indexedSessionPath(sessionId: string): string | null;
  runtimeSessionPath(runtime: SecondaryRuntime): string | undefined;
  runtimeTurnActive(runtime: SecondaryRuntime): boolean;
  runtimeQueueLength(runtime: SecondaryRuntime): number;
  runtimeExtensionPending(runtime: SecondaryRuntime): boolean;
  releaseRuntimeForDeletion(sessionId: string): Promise<boolean>;
}

export async function prepareSessionDeletionRuntime(
  host: SessionDeleteRuntimeHost,
  sessionId: string,
): Promise<{ path?: string; primary: boolean }> {
  const primary = sessionId === host.activeSessionId();
  const runtime = primary ? undefined : host.runtime(sessionId);
  const state = primary ? await host.primaryState() : undefined;
  const path = primary
    ? state?.sessionFile
    : runtime?.sessionPath || runtime?.draftSessionPath || host.indexedSessionPath(sessionId) || undefined;
  if (!primary && !path && !runtime) throw new Error("会话不存在");

  if (primary) {
    if (host.primaryTurnActive() || host.primaryQueueLength() || host.primaryExtensionPending())
      throw new Error("请先停止当前生成、处理权限确认并清空队列，再删除此会话");
    const result = await host.resetPrimarySession();
    if (result.cancelled)
      throw new Error("扩展取消了新建会话，无法删除当前会话");
    return { path, primary: true };
  }

  if (runtime) {
    if (host.runtimeTurnActive(runtime) || host.runtimeQueueLength(runtime) || host.runtimeExtensionPending(runtime))
      throw new Error("请先停止该会话的生成、处理权限确认并清空队列，再删除对话");
    if (!await host.releaseRuntimeForDeletion(sessionId))
      throw new Error("该会话正在执行其他操作，请稍后重试删除");
  }
  return { path, primary: false };
}
