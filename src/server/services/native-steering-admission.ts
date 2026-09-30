import { randomUUID } from "node:crypto";
import type { PiMessage, PromptImage } from "../../shared/types.js";
import { RpcRequestTimeoutError } from "../rpc-client.js";

/** Accepted Steers belong to the App-owned RPC worker generation, never this service. */
export interface NativeSteeringAdmissions {
  generation: number;
  items: Array<{
    id: string;
    message: string;
    promptAt: number;
    imageChars: number;
    imageCount?: number;
    baselinePersistedUserIds: Set<string>;
    baselinePersistedTailId?: string;
  }>;
}

export interface NativeSteeringAdmissionPorts {
  getAdmissions(): NativeSteeringAdmissions | undefined;
  setAdmissions(admissions: NativeSteeringAdmissions | undefined): void;
  advanceProjection(): void;
  persistedMessages(): PiMessage[];
  send(message: string, images: PromptImage[]): Promise<void>;
  readStreaming(): Promise<boolean>;
  clearOnProcessError(): void;
  hasPending(generation: number): boolean;
  reset(): Promise<void>;
  afterReset(): void;
}

export type NativeSteeringAdmissionResult = {
  status: 202 | 400 | 409;
  body: Record<string, unknown>;
};

/**
 * One native Steer admission, from bounded enqueue through RPC write, optional
 * state probe and settlement. The caller owns the per-Session Prompt FIFO and
 * Runtime operation lease through HTTP response publication. This service
 * retains no Queue, Session, or Runtime state between calls.
 */
export async function admitNativeSteering(
  ports: NativeSteeringAdmissionPorts,
  input: {
    generation: number;
    message: string;
    images: PromptImage[];
    requestedSteerId?: string;
    hasSettings: boolean;
    promptAt: number;
    maxPending: number;
    maxImageChars: number;
    maxBaselineIds: number;
  },
): Promise<NativeSteeringAdmissionResult> {
  if (input.message.startsWith("/"))
    return { status: 400, body: { error: "Slash 指令不能作为 Steer 消息发送" } };
  if (input.hasSettings)
    return { status: 400, body: { error: "Steer 消息不能修改下一轮模型设置" } };

  const existing = ports.getAdmissions();
  const admissions = existing?.generation === input.generation
    ? existing
    : { generation: input.generation, items: [] } satisfies NativeSteeringAdmissions;
  if (admissions.items.length >= input.maxPending)
    return { status: 409, body: {
      error: `Steer 队列已满，最多保留 ${input.maxPending} 条未执行的 Steer`,
    } };
  const incomingImageChars = input.images.reduce((sum, image) => sum + image.data.length, 0);
  const queuedImageChars = admissions.items.reduce((sum, item) => sum + item.imageChars, 0);
  if (queuedImageChars + incomingImageChars > input.maxImageChars)
    return { status: 409, body: { error: "Steer 排队图片总量超限" } };

  const message = input.message || "请查看这些图片。";
  const steerId = input.requestedSteerId || randomUUID();
  const persisted = ports.persistedMessages();
  const baselinePersistedUserIds = new Set(
    persisted
      .filter((item) => item.role === "user" && item.piChatPersistedMessageId)
      .slice(-input.maxBaselineIds)
      .map((item) => item.piChatPersistedMessageId!),
  );
  let baselinePersistedTailId: string | undefined;
  for (let index = persisted.length - 1; index >= 0; index -= 1) {
    const persistedId = persisted[index]?.piChatPersistedMessageId;
    if (!persistedId) continue;
    baselinePersistedTailId = persistedId;
    break;
  }
  admissions.items.push({
    id: steerId,
    message,
    promptAt: input.promptAt,
    imageChars: incomingImageChars,
    imageCount: input.images.length,
    baselinePersistedUserIds,
    ...(baselinePersistedTailId ? { baselinePersistedTailId } : null),
  });
  ports.setAdmissions(admissions);
  ports.advanceProjection();

  let deliveryUncertain = false;
  try {
    await ports.send(message, input.images);
  } catch (error) {
    if (error instanceof RpcRequestTimeoutError && error.outcomeUnknown) {
      // An already-written Steer may still be consumed. Only an authoritative
      // queue/dequeue/terminal frame can retire this admission.
      deliveryUncertain = true;
    } else {
      const current = ports.getAdmissions();
      if (current?.generation === input.generation) {
        const index = current.items.findIndex((item) => item.id === steerId);
        if (index >= 0) current.items.splice(index, 1);
        ports.setAdmissions(current.items.length ? current : undefined);
        ports.advanceProjection();
      }
      throw error;
    }
  }

  let streaming: boolean | null;
  try {
    streaming = await ports.readStreaming();
  } catch (error) {
    if (error instanceof RpcRequestTimeoutError) streaming = null;
    else {
      ports.clearOnProcessError();
      return { status: 409, body: { error: "Pi 已退出，Steer 消息未执行" } };
    }
  }
  if (streaming === false && ports.hasPending(input.generation)) {
    await ports.reset();
    ports.afterReset();
    return { status: 409, body: {
      error: "当前对话已结束，Steer 消息未执行",
      code: "STEER_ALREADY_SETTLED",
    } };
  }
  return { status: 202, body: {
    accepted: true,
    queued: false,
    steered: true,
    ...(input.requestedSteerId ? { id: steerId } : null),
    ...(deliveryUncertain ? { deliveryUncertain: true } : null),
  } };
}
