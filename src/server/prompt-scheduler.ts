import { randomUUID } from "node:crypto";
import type { PromptImage, QueuedPrompt } from "../shared/types.js";
import type { PendingTurnSettings, RuntimeQueuedPrompt, SecondaryRuntime } from "./runtime-pool.js";
import type { PiRpcClient } from "./rpc-client.js";

/** Prompt RPC resolves only after Pi preflight (may auto-compact). */
export const PROMPT_PREPARE_TIMEOUT_MS = 200_000;
const MAX_QUEUE_LENGTH = 20;
const MAX_QUEUED_IMAGE_CHARS = 45_000_000;

export interface InternalQueuedPrompt extends QueuedPrompt {
  images: PromptImage[];
}

export interface PromptSchedulerHost {
  isClosed(): boolean;
  isLifecycleIdle(): boolean;
  primaryRpc(): PiRpcClient;
  activeSessionId(): string;
  ensurePrimaryRuntime(): Promise<void>;
  recoverRuntime(runtime: SecondaryRuntime): Promise<void>;
  touchRuntime(runtime: SecondaryRuntime): void;
  applyPendingTurnSettings(rpc: PiRpcClient, pending: PendingTurnSettings): Promise<void>;
  broadcast(event: Record<string, unknown>): void;
  onPrimaryPromptAccepted(sessionId: string): void;
  onSecondaryPromptAccepted(runtime: SecondaryRuntime): void;
}

/**
 * Owns primary follow-up queue + dispatch, and secondary queue dispatch glue.
 * Does not own HTTP, SSE maps, or Runtime lifecycle maps.
 */
export class PromptScheduler {
  readonly primaryQueue: InternalQueuedPrompt[] = [];
  primaryQueuePaused = false;
  primaryDispatching = false;
  primaryRunning = false;
  primaryLiveMessage: import("../shared/types.js").PiMessage | undefined;
  primaryToolStatus = "";
  primaryPendingTurnSettings: PendingTurnSettings = {};
  primaryPendingExtensionRequest: import("../shared/types.js").ExtensionUiRequest | undefined;

  constructor(private readonly host: PromptSchedulerHost) {}

  publicQueue(queue: Array<InternalQueuedPrompt | RuntimeQueuedPrompt> = this.primaryQueue): QueuedPrompt[] {
    return queue.map(({ id, message, imageCount, createdAt }) => ({ id, message, imageCount, createdAt }));
  }

  broadcastQueue(sessionId: string, queue: Array<InternalQueuedPrompt | RuntimeQueuedPrompt>, paused: boolean): void {
    this.host.broadcast({
      type: "pi_chat_queue_update",
      queue: this.publicQueue(queue),
      paused,
      piChatSessionId: sessionId,
    });
  }

  broadcastPrimaryQueue(): void {
    this.broadcastQueue(this.host.activeSessionId(), this.primaryQueue, this.primaryQueuePaused);
  }

  broadcastRuntimeQueue(runtime: SecondaryRuntime): void {
    this.broadcastQueue(runtime.id, runtime.promptQueue, runtime.queuePaused);
  }

  queuedImageChars(queue: Array<{ images: PromptImage[] }>): number {
    return queue.reduce((total, item) => total + item.images.reduce((sum, image) => sum + image.data.length, 0), 0);
  }

  assertCanEnqueue(queue: Array<{ images: PromptImage[] }>, images: PromptImage[]): string | null {
    if (queue.length >= MAX_QUEUE_LENGTH) return "队列已满，最多保留 20 条";
    const incoming = images.reduce((total, image) => total + image.data.length, 0);
    if (this.queuedImageChars(queue) + incoming > MAX_QUEUED_IMAGE_CHARS) {
      return "队列中的图片总量超过约 32 MB，请先等待或撤销部分消息";
    }
    return null;
  }

  enqueuePrimary(message: string, images: PromptImage[]): InternalQueuedPrompt {
    const queued: InternalQueuedPrompt = {
      id: randomUUID(),
      message,
      images,
      imageCount: images.length,
      createdAt: Date.now(),
    };
    this.primaryQueue.push(queued);
    this.broadcastPrimaryQueue();
    return queued;
  }

  enqueueRuntime(runtime: SecondaryRuntime, message: string, images: PromptImage[]): RuntimeQueuedPrompt {
    const queued: RuntimeQueuedPrompt = {
      id: randomUUID(),
      message,
      images,
      imageCount: images.length,
      createdAt: Date.now(),
    };
    runtime.promptQueue.push(queued);
    this.broadcastRuntimeQueue(runtime);
    return queued;
  }

  cancel(queue: Array<{ id: string }>, id: string): boolean {
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  }

  primaryBusyForQueue(): boolean {
    return this.primaryRunning || this.primaryDispatching || this.primaryQueue.length > 0 || this.primaryQueuePaused;
  }

  runtimeBusyForQueue(runtime: SecondaryRuntime): boolean {
    return runtime.running || runtime.dispatching || runtime.promptQueue.length > 0 || runtime.queuePaused;
  }

  async sendPrimaryPrompt(message: string, images: PromptImage[]): Promise<void> {
    await this.host.ensurePrimaryRuntime();
    await this.host.applyPendingTurnSettings(this.host.primaryRpc(), this.primaryPendingTurnSettings);
    this.primaryRunning = true;
    try {
      await this.host.primaryRpc().send(
        { type: "prompt", message: message || "请查看这些图片。", ...(images.length ? { images } : {}) },
        PROMPT_PREPARE_TIMEOUT_MS,
      );
      this.host.onPrimaryPromptAccepted(this.host.activeSessionId());
    } catch (error) {
      this.primaryRunning = false;
      throw error;
    }
  }

  /** Immediate (non-queued) secondary prompt after host already applied settings. */
  notifySecondaryPromptAccepted(runtime: SecondaryRuntime): void {
    this.host.onSecondaryPromptAccepted(runtime);
  }

  async dispatchPrimaryNext(): Promise<void> {
    if (
      this.host.isClosed()
      || !this.host.isLifecycleIdle()
      || this.primaryRunning
      || this.primaryDispatching
      || this.primaryQueuePaused
      || !this.primaryQueue.length
    ) {
      return;
    }
    const next = this.primaryQueue.shift();
    if (!next) return;
    this.primaryDispatching = true;
    this.broadcastPrimaryQueue();
    this.host.broadcast({
      type: "pi_chat_queue_dispatch",
      id: next.id,
      message: next.message,
      imageCount: next.imageCount,
      piChatSessionId: this.host.activeSessionId(),
    });
    try {
      await this.sendPrimaryPrompt(next.message, next.images);
    } catch (error) {
      this.primaryDispatching = false;
      this.primaryQueuePaused = true;
      this.primaryQueue.unshift(next);
      this.broadcastPrimaryQueue();
      this.host.broadcast({
        type: "pi_chat_queue_error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async dispatchRuntimeNext(runtime: SecondaryRuntime): Promise<void> {
    this.host.touchRuntime(runtime);
    if (
      this.host.isClosed()
      || !this.host.isLifecycleIdle()
      || runtime.running
      || runtime.dispatching
      || runtime.queuePaused
      || !runtime.promptQueue.length
    ) {
      return;
    }
    if (runtime.failed || runtime.rpc.isRunning?.() === false) {
      try {
        await this.host.recoverRuntime(runtime);
      } catch (error) {
        runtime.queuePaused = true;
        this.broadcastRuntimeQueue(runtime);
        this.host.broadcast({
          type: "pi_chat_queue_error",
          error: error instanceof Error ? error.message : String(error),
          piChatSessionId: runtime.id,
        });
        return;
      }
    }
    const next = runtime.promptQueue.shift();
    if (!next) return;
    runtime.dispatching = true;
    this.broadcastRuntimeQueue(runtime);
    this.host.broadcast({
      type: "pi_chat_queue_dispatch",
      id: next.id,
      message: next.message,
      imageCount: next.imageCount,
      piChatSessionId: runtime.id,
    });
    try {
      await this.host.applyPendingTurnSettings(runtime.rpc, runtime.pendingTurnSettings);
      runtime.running = true;
      await runtime.rpc.send(
        { type: "prompt", message: next.message || "请查看这些图片。", ...(next.images.length ? { images: next.images } : {}) },
        PROMPT_PREPARE_TIMEOUT_MS,
      );
    } catch (error) {
      runtime.running = false;
      runtime.dispatching = false;
      runtime.queuePaused = true;
      runtime.promptQueue.unshift(next);
      this.broadcastRuntimeQueue(runtime);
      this.host.broadcast({
        type: "pi_chat_queue_error",
        error: error instanceof Error ? error.message : String(error),
        piChatSessionId: runtime.id,
      });
    }
  }

  clearPrimary(): void {
    this.primaryQueue.length = 0;
    this.primaryQueuePaused = false;
    this.primaryDispatching = false;
    this.primaryRunning = false;
    this.primaryLiveMessage = undefined;
    this.primaryToolStatus = "";
    this.primaryPendingTurnSettings = {};
    this.primaryPendingExtensionRequest = undefined;
  }
}
