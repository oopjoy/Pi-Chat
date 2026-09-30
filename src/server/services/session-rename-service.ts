import { randomUUID } from "node:crypto";
import { HttpRequestError } from "../http-transport.js";
import type { PiRpcClient } from "../rpc-client.js";
import type { SecondaryRuntime } from "../runtime-pool.js";

export interface SessionRenameHost {
  sessionMutationOutcomePending(sessionId: string): boolean;
  activeSessionId(): string;
  knownRuntime(sessionId: string): SecondaryRuntime | undefined;
  ensureRuntime(sessionId: string): Promise<SecondaryRuntime>;
  primaryRpc(): PiRpcClient;
  acquireRuntimeOperation(runtime: SecondaryRuntime): () => void;
  acquirePrimaryOperation(): () => void;
  lateRpcOutcomeHandler(sessionId: string, token: string): (response: Record<string, unknown>) => void;
  markRpcOutcomePending(sessionId: string, error: unknown, token: string): void;
  rethrowResultPending(error: unknown, operation: string): never;
  clearNativeSteeringState(sessionId: string, reason: "reclaim"): void;
  reclaimRuntime(sessionId: string): Promise<void>;
  updateRuntimeName(sessionId: string, name: string): void;
  persistForkNameOverride?(sessionId: string, name: string): Promise<void>;
  broadcastRenamed(sessionId: string): void;
}

export async function renameSession(
  host: SessionRenameHost,
  id: string,
  name: string,
): Promise<{ id: string; name: string }> {
  if (host.sessionMutationOutcomePending(id))
    throw new HttpRequestError(
      409,
      "上一次操作结果尚未确认；请刷新页面核对，不要重复修改会话名称",
      "RESULT_PENDING",
      true,
    );
  const isPrimary = id === host.activeSessionId();
  const existingRuntime = isPrimary ? undefined : host.knownRuntime(id);
  if (existingRuntime?.draftSession)
    throw new Error("空白新对话会在发送第一条消息后保存，届时才能重命名");
  const wasOpen = isPrimary || Boolean(existingRuntime);
  const runtime = isPrimary ? undefined : existingRuntime || await host.ensureRuntime(id);
  const releaseOperation = runtime
    ? host.acquireRuntimeOperation(runtime)
    : host.acquirePrimaryOperation();
  const outcomeToken = randomUUID();
  try {
    try {
      await (runtime?.rpc || host.primaryRpc()).send(
        { type: "set_session_name", name },
        undefined,
        { onLateResponse: host.lateRpcOutcomeHandler(id, outcomeToken) },
      );
    } catch (error) {
      host.markRpcOutcomePending(id, error, outcomeToken);
      host.rethrowResultPending(error, "重命名");
    }
  } finally {
    releaseOperation();
  }
  if (!wasOpen && runtime && !runtime.running) {
    host.clearNativeSteeringState(id, "reclaim");
    try {
      await host.reclaimRuntime(id);
    } catch (error) {
      host.rethrowResultPending(error, "回收会话运行时");
    }
  }
  if (host.persistForkNameOverride)
    await host.persistForkNameOverride(id, name);
  host.updateRuntimeName(id, name);
  host.broadcastRenamed(id);
  return { id, name };
}
