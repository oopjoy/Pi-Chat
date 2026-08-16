import { randomUUID } from "node:crypto";
import { MAX_PROMPT_IMAGES_ENCODED_BYTES } from "../shared/rpc-contracts.js";
import type { GateMode, PromptImage, QueuedPrompt } from "../shared/types.js";
import type { PendingTurnSettings, RuntimeQueuedPrompt, SecondaryRuntime } from "./runtime-pool.js";
import {
  RpcRequestTimeoutError,
  type PiRpcClient,
  type RpcRequestObserver,
} from "./rpc-client.js";
import { incidentReference } from "./incident-diagnostics.js";

/** Prompt RPC resolves only after Pi preflight (may auto-compact). */
export const PROMPT_PREPARE_TIMEOUT_MS = 200_000;
/** A write timeout means Pi may still process the already-written JSONL RPC command. */
export type PromptAcceptance = "confirmed" | "unknown";
const MAX_QUEUE_LENGTH = 20;
const MAX_QUEUED_IMAGE_CHARS = MAX_PROMPT_IMAGES_ENCODED_BYTES;

export interface InternalQueuedPrompt extends QueuedPrompt {
  images: PromptImage[];
  /** Gate mode selected for this turn; replayed immediately before dispatch. */
  gateMode?: GateMode;
}

export interface PromptSchedulerHost {
  isClosed(): boolean;
  isLifecycleIdle(): boolean;
  primaryRpc(): PiRpcClient;
  activeSessionId(): string;
  ensurePrimaryRuntime(): Promise<void>;
  recoverRuntime(runtime: SecondaryRuntime): Promise<void>;
  acquirePrimaryOperation(): () => void;
  acquireRuntimeOperation(runtime: SecondaryRuntime): () => void;
  touchRuntime(runtime: SecondaryRuntime): void;
  applyPendingTurnSettings(rpc: PiRpcClient, pending: PendingTurnSettings): Promise<void>;
  syncGateMode(rpc: PiRpcClient, sessionId: string, mode?: GateMode): Promise<void>;
  /** Optional observation seam; it may observe but never proxy prompt delivery. */
  promptRpcObserver?(
    rpc: PiRpcClient,
    sessionId: string,
    promptId: string,
  ): RpcRequestObserver | undefined;
  tracePrompt?(sessionId: string, promptId: string, name: string): void;
  abandonPromptDiagnostic?(sessionId: string, promptId: string): void;
  broadcast(event: Record<string, unknown>): void;
  /** Publish the server-derived activity snapshot after a queue-state mutation. */
  publishSessionActivity?(sessionId: string): void;
  /** `promptAt` is the original user-admission time, including queued prompts. */
  onPrimaryPromptAccepted(sessionId: string, promptAt: number): void;
  onSecondaryPromptAccepted(runtime: SecondaryRuntime, promptAt: number): void;
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
  primaryAbortGeneration = 0;

  constructor(private readonly host: PromptSchedulerHost) {}

  private promptRpcObserver(
    rpc: PiRpcClient,
    sessionId: string,
    promptId: string,
  ): RpcRequestObserver | undefined {
    try {
      return this.host.promptRpcObserver?.(rpc, sessionId, promptId);
    } catch {
      return undefined;
    }
  }

  private tracePrompt(sessionId: string, promptId: string, name: string): void {
    try {
      this.host.tracePrompt?.(sessionId, promptId, name);
    } catch {
      // Diagnostics cannot perturb queue ordering or prompt delivery.
    }
  }

  private abandonPromptDiagnostic(sessionId: string, promptId: string): void {
    try {
      this.host.abandonPromptDiagnostic?.(sessionId, promptId);
    } catch {
      // Observation cleanup is fail-open too.
    }
  }

  publicQueue(queue: Array<InternalQueuedPrompt | RuntimeQueuedPrompt> = this.primaryQueue): QueuedPrompt[] {
    return queue.map(({ id, message, imageCount, createdAt }) => ({ id, message, imageCount, createdAt }));
  }

  broadcastQueue(sessionId: string, queue: Array<InternalQueuedPrompt | RuntimeQueuedPrompt>, paused: boolean, admittedId = ""): void {
    this.host.broadcast({
      type: "pi_chat_queue_update",
      queue: this.publicQueue(queue),
      paused,
      ...(admittedId ? { admittedId } : null),
      piChatSessionId: sessionId,
    });
    this.host.publishSessionActivity?.(sessionId);
  }

  broadcastPrimaryQueue(admittedId = ""): void {
    this.broadcastQueue(this.host.activeSessionId(), this.primaryQueue, this.primaryQueuePaused, admittedId);
  }

  broadcastRuntimeQueue(runtime: SecondaryRuntime, admittedId = ""): void {
    this.broadcastQueue(runtime.id, runtime.promptQueue, runtime.queuePaused, admittedId);
  }

  queuedImageChars(queue: Array<{ images: PromptImage[] }>): number {
    return queue.reduce((total, item) => total + item.images.reduce((sum, image) => sum + image.data.length, 0), 0);
  }

  assertCanEnqueue(queue: Array<{ images: PromptImage[] }>, images: PromptImage[]): string | null {
    if (queue.length >= MAX_QUEUE_LENGTH) return "队列已满，最多保留 20 条";
    const incoming = images.reduce((total, image) => total + image.data.length, 0);
    if (this.queuedImageChars(queue) + incoming > MAX_QUEUED_IMAGE_CHARS) {
      return "队列中的图片总量超过 40 MB，请先等待或撤销部分消息";
    }
    return null;
  }

  enqueuePrimary(
    message: string,
    images: PromptImage[],
    createdAt = Date.now(),
    gateMode?: GateMode,
  ): InternalQueuedPrompt {
    const queued: InternalQueuedPrompt = {
      id: randomUUID(),
      message,
      images,
      imageCount: images.length,
      createdAt,
      ...(gateMode ? { gateMode } : null),
    };
    this.primaryQueue.push(queued);
    this.broadcastPrimaryQueue(queued.id);
    return queued;
  }

  enqueueRuntime(
    runtime: SecondaryRuntime,
    message: string,
    images: PromptImage[],
    createdAt = Date.now(),
    gateMode?: GateMode,
  ): RuntimeQueuedPrompt {
    const queued: RuntimeQueuedPrompt = {
      id: randomUUID(),
      message,
      images,
      imageCount: images.length,
      createdAt,
      ...(gateMode ? { gateMode } : null),
    };
    runtime.promptQueue.push(queued);
    this.broadcastRuntimeQueue(runtime, queued.id);
    return queued;
  }

  cancel(queue: Array<{ id: string }>, id: string): boolean {
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  }

  primaryBusyForQueue(): boolean {
    return Boolean(this.primaryLiveMessage) || Boolean(this.primaryToolStatus) || this.primaryRunning || this.primaryDispatching || this.primaryQueue.length > 0 || this.primaryQueuePaused;
  }

  runtimeBusyForQueue(runtime: SecondaryRuntime): boolean {
    return Boolean(runtime.liveMessage) || Boolean(runtime.toolStatus) || runtime.running || runtime.dispatching || runtime.promptQueue.length > 0 || runtime.queuePaused;
  }

  async sendPrimaryPrompt(
    message: string,
    images: PromptImage[],
    promptAt = Date.now(),
    gateMode?: GateMode,
    promptId: string = randomUUID(),
  ): Promise<PromptAcceptance> {
    const releaseOperation = this.host.acquirePrimaryOperation();
    try {
      await this.host.ensurePrimaryRuntime();
      const generation = this.primaryAbortGeneration;
      await this.host.applyPendingTurnSettings(this.host.primaryRpc(), this.primaryPendingTurnSettings);
      if (generation !== this.primaryAbortGeneration || this.host.isClosed() || !this.host.isLifecycleIdle()) throw new Error("消息发送已取消");
      const rpc = this.host.primaryRpc();
      const sessionId = this.host.activeSessionId();
      await this.host.syncGateMode(rpc, sessionId, gateMode);
      this.primaryRunning = true;
      this.host.publishSessionActivity?.(sessionId);
      const observe = this.promptRpcObserver(rpc, sessionId, promptId);
      this.tracePrompt(sessionId, promptId, "dispatch");
      try {
        await rpc.send(
          { type: "prompt", message: message || "请查看这些图片。", ...(images.length ? { images } : {}) },
          PROMPT_PREPARE_TIMEOUT_MS,
          observe ? { observe } : undefined,
        );
        this.host.onPrimaryPromptAccepted(this.host.activeSessionId(), promptAt);
        return "confirmed";
      } catch (error) {
        // Pi's RPC protocol has no cancellation. Once stdin accepted the JSONL
        // command, a caller timeout cannot prove the prompt was rejected. Keep
        // the turn in the running/queue state so a following browser prompt is
        // queued behind it instead of racing a possibly active Pi turn.
        if (error instanceof RpcRequestTimeoutError && error.outcomeUnknown) {
          // Conservatively retain recency/history overlays too. Pi may emit
          // agent_start after this response timer has elapsed.
          this.host.onPrimaryPromptAccepted(this.host.activeSessionId(), promptAt);
          this.host.publishSessionActivity?.(this.host.activeSessionId());
          return "unknown";
        }
        this.primaryRunning = false;
        this.abandonPromptDiagnostic(sessionId, promptId);
        this.host.publishSessionActivity?.(sessionId);
        throw error;
      }
    } finally { releaseOperation(); }
  }

  /** Immediate (non-queued) secondary prompt after host already applied settings. */
  notifySecondaryPromptAccepted(runtime: SecondaryRuntime, promptAt = Date.now()): void {
    this.host.onSecondaryPromptAccepted(runtime, promptAt);
  }

  async dispatchPrimaryNext(): Promise<void> {
    if (
      this.host.isClosed()
      || !this.host.isLifecycleIdle()
      || this.primaryRunning
      || this.primaryLiveMessage
      || this.primaryToolStatus
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
      const acceptance = await this.sendPrimaryPrompt(
        next.message,
        next.images,
        next.createdAt,
        next.gateMode,
        next.id,
      );
      if (acceptance === "unknown") {
        // Normal prompt acceptance is released by Pi's ordered agent_start
        // event. A response timeout may never receive that frame, so release
        // only this indeterminate preparation lease; a later agent_settled
        // will then schedule the required FIFO state barrier.
        this.primaryDispatching = false;
        this.tracePrompt(this.host.activeSessionId(), next.id, "delivery-uncertain");
        this.host.broadcast({
          type: "pi_chat_prompt_delivery_uncertain",
          id: next.id,
          piChatSessionId: this.host.activeSessionId(),
        });
        this.host.publishSessionActivity?.(this.host.activeSessionId());
      }
    } catch (error) {
      this.primaryDispatching = false;
      this.primaryQueuePaused = true;
      this.primaryQueue.unshift(next);
      this.tracePrompt(this.host.activeSessionId(), next.id, "requeued");
      this.abandonPromptDiagnostic(this.host.activeSessionId(), next.id);
      this.broadcastPrimaryQueue();
      const incidentId = incidentReference(error)?.incidentId;
      this.host.broadcast({
        type: "pi_chat_queue_error",
        id: next.id,
        queue: this.publicQueue(),
        paused: true,
        piChatSessionId: this.host.activeSessionId(),
        error: error instanceof Error ? error.message : String(error),
        ...(incidentId ? { incidentId } : null),
      });
      this.host.publishSessionActivity?.(this.host.activeSessionId());
    }
  }

  async dispatchRuntimeNext(runtime: SecondaryRuntime): Promise<void> {
    this.host.touchRuntime(runtime);
    let releaseOperation: (() => void) | null = null;
    try { releaseOperation = this.host.acquireRuntimeOperation(runtime); }
    catch { return; }
    const generation = runtime.abortGeneration;
    if (
      this.host.isClosed()
      || !this.host.isLifecycleIdle()
      || runtime.running
      || runtime.liveMessage
      || runtime.toolStatus
      || runtime.dispatching
      || runtime.queuePaused
      || !runtime.promptQueue.length
    ) {
      releaseOperation();
      return;
    }
    if (runtime.failed || runtime.rpc.isRunning?.() === false) {
      try {
        await this.host.recoverRuntime(runtime);
        if (generation !== runtime.abortGeneration) {
          runtime.queuePaused = true;
          this.broadcastRuntimeQueue(runtime);
          releaseOperation();
          return;
        }
      } catch (error) {
        runtime.queuePaused = true;
        this.broadcastRuntimeQueue(runtime);
        const incidentId = incidentReference(error)?.incidentId;
        this.host.broadcast({
          type: "pi_chat_queue_error",
          error: error instanceof Error ? error.message : String(error),
          piChatSessionId: runtime.id,
          ...(incidentId ? { incidentId } : null),
        });
        this.host.publishSessionActivity?.(runtime.id);
        releaseOperation();
        return;
      }
    }
    const next = runtime.promptQueue.shift();
    if (!next) {
      releaseOperation();
      return;
    }
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
      if (generation !== runtime.abortGeneration || this.host.isClosed() || !this.host.isLifecycleIdle()) throw new Error("消息发送已取消");
      await this.host.syncGateMode(runtime.rpc, runtime.id, next.gateMode);
      runtime.running = true;
      this.host.publishSessionActivity?.(runtime.id);
      const observe = this.promptRpcObserver(runtime.rpc, runtime.id, next.id);
      this.tracePrompt(runtime.id, next.id, "dispatch");
      await runtime.rpc.send(
        { type: "prompt", message: next.message || "请查看这些图片。", ...(next.images.length ? { images: next.images } : {}) },
        PROMPT_PREPARE_TIMEOUT_MS,
        observe ? { observe } : undefined,
      );
      this.host.onSecondaryPromptAccepted(runtime, next.createdAt);
    } catch (error) {
      // A write timeout can occur after the prompt JSONL command reached Pi
      // stdin. Requeueing here could duplicate a turn Pi accepts later. Keep
      // the Runtime conservatively running until its event stream or process
      // failure gives a definitive verdict.
      if (error instanceof RpcRequestTimeoutError && error.outcomeUnknown) {
        runtime.dispatching = false;
        this.tracePrompt(runtime.id, next.id, "delivery-uncertain");
        this.host.onSecondaryPromptAccepted(runtime, next.createdAt);
        this.host.broadcast({
          type: "pi_chat_prompt_delivery_uncertain",
          id: next.id,
          piChatSessionId: runtime.id,
        });
        this.host.publishSessionActivity?.(runtime.id);
        return;
      }
      runtime.running = false;
      runtime.dispatching = false;
      runtime.queuePaused = true;
      runtime.promptQueue.unshift(next);
      this.tracePrompt(runtime.id, next.id, "requeued");
      this.abandonPromptDiagnostic(runtime.id, next.id);
      this.broadcastRuntimeQueue(runtime);
      const incidentId = incidentReference(error)?.incidentId;
      this.host.broadcast({
        type: "pi_chat_queue_error",
        id: next.id,
        queue: this.publicQueue(runtime.promptQueue),
        paused: true,
        error: error instanceof Error ? error.message : String(error),
        piChatSessionId: runtime.id,
        ...(incidentId ? { incidentId } : null),
      });
      this.host.publishSessionActivity?.(runtime.id);
    } finally { releaseOperation(); }
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
    this.primaryAbortGeneration += 1;
  }
}
