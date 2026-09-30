import { randomUUID } from "node:crypto";
import { HttpRequestError } from "../http-transport.js";
import { RpcRequestTimeoutError, type PiRpcClient } from "../rpc-client.js";
import { rpcData } from "../rpc-client.js";

export interface CompletedDequeue {
  sessionId: string;
  generation: number;
  items: unknown[];
}

export interface NativeSteeringDequeueTarget {
  rpc: PiRpcClient;
  generation: number;
  releaseRuntimeAdmission: () => void;
}

export interface NativeSteeringDequeueHost {
  beginPromptAdmission(sessionId: string): Promise<() => void>;
  resolveTarget(sessionId: string): NativeSteeringDequeueTarget | null;
  completed(dequeueId: string): CompletedDequeue | undefined;
  settle(sessionId: string, dequeueId: string, items: unknown[], generation: number): void;
  forget(dequeueId: string): void;
}

/**
 * Owns the native Steer dequeue transaction, but not Runtime/Prompt state.
 * Runtime ownership, generation maps, and late-event reconciliation remain
 * behind explicit host ports supplied by PiChatApp.
 */
export async function dequeueNativeSteering(
  host: NativeSteeringDequeueHost,
  sessionId: string,
): Promise<{ items: unknown[]; count: number }> {
  const releasePromptAdmission = await host.beginPromptAdmission(sessionId);
  const dequeueId = randomUUID();
  let target: NativeSteeringDequeueTarget | null = null;
  try {
    target = host.resolveTarget(sessionId);
    if (!target)
      throw new HttpRequestError(409, "当前对话没有可撤回的原生 Steer 队列", "STEER_RUNTIME_NOT_HOT");
    if (target.rpc.isRunning?.() === false)
      throw new HttpRequestError(409, "Pi 已退出，无法撤回 Steer", "STEER_RUNTIME_NOT_RUNNING");
    let result: Record<string, unknown> | null = null;
    try {
      result = await target.rpc.send({ type: "dequeue", dequeueId }, 10_000);
    } catch (error) {
      const completed = host.completed(dequeueId);
      if (!(error instanceof RpcRequestTimeoutError && error.outcomeUnknown && completed))
        throw error;
    }
    let completed = host.completed(dequeueId);
    if (!completed && result) {
      const data = rpcData<{ steering?: unknown }>(result);
      host.settle(
        sessionId,
        dequeueId,
        Array.isArray(data.steering) ? data.steering : [],
        target.generation,
      );
      completed = host.completed(dequeueId);
    }
    host.forget(dequeueId);
    const items = completed?.sessionId === sessionId && completed.generation === target.generation
      ? completed.items
      : [];
    return { items, count: items.length };
  } finally {
    target?.releaseRuntimeAdmission();
    releasePromptAdmission();
  }
}
