import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, normalize, resolve } from "node:path";
import type { ApplicationLifecycle, BootstrapData, ExtensionUiRequest, ModelInfo, PiMessage, PiState, PromptImage, QueuedPrompt, SessionStats, SessionSummary, SessionViewData, SlashCommand, ThinkingLevel } from "../shared/types.js";
import { ApplicationBusyError, ApplicationLifecycleConflictError, ApplicationLifecycleCoordinator, lifecycleMessage } from "./application-lifecycle.js";
import { pickLocalFiles, pickWorkspaceFolder, readClipboardFiles } from "./file-picker.js";
import { type FileSnapshot, restoreSnapshots, snapshotFile } from "./file-transaction.js";
import { bodyJson, json, methodNotAllowed, MIME_TYPES, requestClientId, SECURITY_HEADERS } from "./http-transport.js";
import { ModelManager } from "./model-manager.js";
import { ResourceManager } from "./resource-manager.js";
import { PiRpcClient, rpcData } from "./rpc-client.js";
import { asCommands, asMessages, asModels, asSessionStats, asState, messageWindow, promptImages, RECENT_TURN_WINDOW_SIZE } from "./pi-data.js";
import { idForPath, readSessionMessages, SessionIndex, type SessionUsageSnapshot } from "./session-index.js";
import { saveWorkspace } from "./workspace-state.js";
import { requestGuardError } from "./request-guard.js";

export { messageWindow, promptImages, RECENT_TURN_WINDOW_SIZE } from "./pi-data.js";
export const TURN_WINDOW_INCREMENT = 10;
const MAX_TURN_WINDOW_SIZE = 10_000;
const DEFAULT_SECONDARY_RUNTIME_IDLE_MS = 10 * 60 * 1_000;
// A prompt RPC resolves only after Pi preflight. That phase may auto-compact a
// long session, so it needs a larger budget than normal RPC state operations.
const PROMPT_PREPARE_TIMEOUT_MS = 200_000;
const DEFAULT_MAX_IDLE_SECONDARY_RUNTIMES = 3;
const DEFAULT_SECONDARY_RUNTIME_SWEEP_MS = 60 * 1_000;
const DEFAULT_GATE_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "new", description: "新建会话", source: "builtin" },
  { name: "compact", description: "压缩当前会话上下文，可附加指令", source: "builtin" },
  { name: "abort", description: "停止当前生成", source: "builtin" },
];
class SessionControlConflictError extends Error {}


interface InternalQueuedPrompt extends QueuedPrompt {
  images: PromptImage[];
}

interface PendingTurnSettings {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

interface SecondaryRuntime {
  id: string;
  rpc: PiRpcClient;
  running: boolean;
  queuePaused: boolean;
  dispatching: boolean;
  promptQueue: InternalQueuedPrompt[];
  liveMessage?: PiMessage;
  toolStatus: string;
  extensionUiPending: boolean;
  lastUsedAt: number;
  unsubscribe: () => void;
  pendingTurnSettings: PendingTurnSettings;
  pendingExtensionRequest?: ExtensionUiRequest;
  /** A crashed worker remains addressable while one bounded restart is in flight. */
  failed?: boolean;
  recovery?: Promise<void>;
  /** File allocated by Pi for an as-yet empty draft. It is not indexed until a prompt is sent. */
  draftSession?: SessionSummary;
  /** Pi's JSONL path, available even before SessionIndex first observes the Session. */
  sessionPath?: string;
  draftSessionPath?: string;
}

export interface PreparedApplicationRestart {
  promote(): Promise<void>;
  handoff(): void;
  discard(): Promise<void>;
}

export interface PiChatAppOptions {
  rpc: PiRpcClient;
  createRpc?: (cwd: string) => PiRpcClient;
  sessions: SessionIndex;
  webRoot: string;
  cwd: string;
  resources: ResourceManager;
  modelManager?: ModelManager;
  devMiddleware?: (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
  secondaryRuntimeIdleMs?: number;
  maxIdleSecondaryRuntimes?: number;
  secondaryRuntimeSweepMs?: number;
  controllerReleaseMs?: number;
  gateRequestTimeoutMs?: number;
  now?: () => number;
  allowedHosts?: string[];
  requestToken?: string;
  /** Build a staged replacement; PiChatApp promotes it only after its second quiescence check. */
  applicationRestart?: () => Promise<PreparedApplicationRestart>;
  /** Gracefully terminate the entire Pi Chat service process. */
  applicationShutdown?: () => void;
}

export class PiChatApp {
  private readonly sseClients = new Map<ServerResponse, string>();
  private readonly unsubscribe: () => void;
  private readonly promptQueue: InternalQueuedPrompt[] = [];
  private running = false;
  private lastPrimaryState: PiState = { model: null, isStreaming: false };
  private queuePaused = false;
  private dispatching = false;
  private closed = false;
  private currentCwd: string;
  private activeSessionId = "";
  private activeSessionPath: string | undefined;
  private readonly runtimes = new Map<string, SecondaryRuntime>();
  private readonly runtimeStarts = new Map<string, Promise<SecondaryRuntime>>();
  private readonly runtimeStops = new Map<string, Promise<void>>();
  private runtimeCapacityTail: Promise<void> = Promise.resolve();
  /** Ephemeral browser-window ownership. It is reset when Pi Chat restarts. */
  private readonly sessionControllers = new Map<string, string>();
  private readonly connectedClients = new Map<string, number>();
  /** Session currently visible in each live browser/PWA window. */
  private readonly viewedSessionsByClient = new Map<string, string>();
  private readonly controllerReleaseTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingExtensionTimers = new Map<string, NodeJS.Timeout>();
  private primaryFailed = false;
  private primaryRecovery: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly secondaryRuntimeIdleMs: number;
  private readonly maxIdleSecondaryRuntimes: number;
  private readonly controllerReleaseMs: number;
  private readonly gateRequestTimeoutMs: number;
  private readonly secondaryRuntimeSweepTimer: NodeJS.Timeout;
  private readonly requestToken: string;
  private allowedHosts: string[];
  private liveMessage: PiMessage | undefined;
  private toolStatus = "";
  private pendingTurnSettings: PendingTurnSettings = {};
  private pendingExtensionRequest: ExtensionUiRequest | undefined;
  private readonly lifecycleCoordinator: ApplicationLifecycleCoordinator;
  /** A compaction changes the prompt structure; wait for a later completed turn before reporting occupancy again. */
  private readonly modelContextWindows = new Map<string, number>();
  private readonly contextUsagePendingRefresh = new Set<string>();
  private readonly contextUsageRefreshTurn = new Set<string>();

  constructor(private readonly options: PiChatAppOptions) {
    this.currentCwd = resolve(options.cwd);
    this.lifecycleCoordinator = new ApplicationLifecycleCoordinator(() => this.broadcastLifecycle());
    this.requestToken = options.requestToken || randomBytes(32).toString("base64url");
    // Bare loopback names are used only by in-process test apps. The production
    // entrypoint replaces them with one exact host:port after listen().
    this.allowedHosts = options.allowedHosts || ["127.0.0.1", "localhost", "::1"];
    this.now = options.now || Date.now;
    this.secondaryRuntimeIdleMs = Math.max(0, options.secondaryRuntimeIdleMs ?? DEFAULT_SECONDARY_RUNTIME_IDLE_MS);
    this.maxIdleSecondaryRuntimes = Math.max(0, Math.floor(options.maxIdleSecondaryRuntimes ?? DEFAULT_MAX_IDLE_SECONDARY_RUNTIMES));
    this.controllerReleaseMs = Math.max(0, options.controllerReleaseMs ?? 5_000);
    this.gateRequestTimeoutMs = Math.max(1, options.gateRequestTimeoutMs ?? DEFAULT_GATE_REQUEST_TIMEOUT_MS);
    const sweepMs = Math.max(100, options.secondaryRuntimeSweepMs ?? DEFAULT_SECONDARY_RUNTIME_SWEEP_MS);
    this.secondaryRuntimeSweepTimer = setInterval(() => void this.sweepSecondaryRuntimes(), sweepMs);
    this.secondaryRuntimeSweepTimer.unref();
    this.unsubscribe = options.rpc.onEvent((event) => this.handleRpcEvent(event));
  }

  setAllowedHosts(allowedHosts: string[]): void {
    this.allowedHosts = [...allowedHosts];
  }

  private get applicationLifecycle(): ApplicationLifecycle { return this.lifecycleCoordinator.lifecycle; }
  private get activeMutationRequests(): number { return this.lifecycleCoordinator.activeMutations; }

  private lifecycleMessage(lifecycle = this.applicationLifecycle): string { return lifecycleMessage(lifecycle); }

  private broadcastLifecycle(): void {
    this.broadcast({ type: "pi_chat_application_lifecycle", lifecycle: this.applicationLifecycle });
  }

  private beginLifecycle(lifecycle: Exclude<ApplicationLifecycle, "idle">): void { this.lifecycleCoordinator.begin(lifecycle); }
  private endLifecycle(lifecycle: Exclude<ApplicationLifecycle, "idle">): void { this.lifecycleCoordinator.end(lifecycle); }
  private beginMutation(): () => void { return this.lifecycleCoordinator.beginMutation(); }

  private async withLifecycle<T>(lifecycle: Exclude<ApplicationLifecycle, "idle">, action: string, operation: () => Promise<T>): Promise<T> {
    this.beginLifecycle(lifecycle);
    try {
      await this.verifyApplicationQuiescent(action);
      return await operation();
    } finally {
      this.endLifecycle(lifecycle);
    }
  }

  private busyConversationCount(): number {
    const primaryBusy = this.running || this.dispatching || this.queuePaused || this.promptQueue.length > 0 || Boolean(this.pendingExtensionRequest) || Boolean(this.primaryRecovery);
    const busyRuntimes = [...this.runtimes.values()].filter((runtime) => runtime.running || runtime.dispatching || runtime.queuePaused || runtime.promptQueue.length > 0 || runtime.extensionUiPending || Boolean(runtime.recovery)).length;
    return busyRuntimes + (primaryBusy ? 1 : 0);
  }

  private assertApplicationQuiescent(action: string): void {
    const busyCount = this.busyConversationCount();
    const transitioningCount = this.runtimeStarts.size + this.runtimeStops.size;
    if (busyCount || transitioningCount || this.activeMutationRequests) {
      throw new ApplicationBusyError(`仍有 ${busyCount + transitioningCount} 个对话正在执行、启动、停止、排队或等待确认，请处理完成后再${action}`);
    }
  }

  private async verifyApplicationQuiescent(action: string): Promise<void> {
    this.assertApplicationQuiescent(action);
    const rpcStates = await Promise.all([
      this.primaryFailed || this.options.rpc.isRunning?.() === false ? Promise.resolve(null) : this.options.rpc.send({ type: "get_state" }),
      ...[...this.runtimes.values()].map((runtime) => runtime.failed || runtime.rpc.isRunning?.() === false ? Promise.resolve(null) : runtime.rpc.send({ type: "get_state" })),
    ]);
    if (rpcStates.some((response) => response && asState(response).isStreaming)) {
      throw new ApplicationBusyError(`仍有对话正在执行，请完成后再${action}`);
    }
    this.assertApplicationQuiescent(action);
  }

  private isOrdinaryMutation(request: IncomingMessage, url: URL): boolean {
    if (request.method === "GET" || request.method === "HEAD") return false;
    if (["/api/restart", "/api/shutdown", "/api/window/close", "/api/workspace/pick", "/api/workspace/set", "/api/local-files/pick", "/api/local-files/clipboard"].includes(url.pathname)) return false;
    if (url.pathname === "/api/models" || url.pathname.startsWith("/api/resources/")) return false;
    if (/^\/api\/models\/[A-Za-z0-9._-]{1,80}\//.test(url.pathname)) return false;
    if (/^\/api\/sessions\/[a-f0-9]{20}\/viewing$/.test(url.pathname)) return false;
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.secondaryRuntimeSweepTimer);
    this.unsubscribe();
    await Promise.allSettled(this.runtimeStarts.values());
    await Promise.allSettled(this.runtimeStops.values());
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    for (const runtime of runtimes) runtime.unsubscribe();
    // Distinct Session workers can stop concurrently. Sequential forced-stop
    // windows made shutdown/restart scale by roughly three seconds per worker.
    await Promise.allSettled(runtimes.map(async (runtime) => {
      await runtime.rpc.stop();
      await this.cleanupEmptyDraft(runtime);
    }));
    for (const timer of this.controllerReleaseTimers.values()) clearTimeout(timer);
    this.controllerReleaseTimers.clear();
    for (const timer of this.pendingExtensionTimers.values()) clearTimeout(timer);
    this.pendingExtensionTimers.clear();
    this.connectedClients.clear();
    this.viewedSessionsByClient.clear();
    for (const client of this.sseClients.keys()) client.end();
    this.sseClients.clear();
  }

  private broadcast(event: Record<string, unknown>): void {
    const frame = `event: pi\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients.keys()) client.write(frame);
  }

  private broadcastControlState(sessionId: string): void {
    for (const [client, clientId] of this.sseClients) {
      const event = { type: "pi_chat_session_control_changed", sessionId, ...this.controlState(sessionId, clientId) };
      client.write(`event: pi\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }

  private publicQueue(queue = this.promptQueue): QueuedPrompt[] {
    return queue.map(({ id, message, imageCount, createdAt }) => ({ id, message, imageCount, createdAt }));
  }

  private broadcastQueue(sessionId = this.activeSessionId): void {
    const runtime = this.runtimes.get(sessionId);
    this.broadcast({ type: "pi_chat_queue_update", queue: this.publicQueue(runtime?.promptQueue || this.promptQueue), paused: runtime?.queuePaused ?? this.queuePaused, piChatSessionId: sessionId });
  }

  private activeSessionIds(): string[] {
    const primaryActive = !this.primaryFailed && this.options.rpc.isRunning?.() !== false;
    const secondaryActive = [...this.runtimes.values()]
      .filter((runtime) => !runtime.failed && runtime.rpc.isRunning?.() !== false)
      .map((runtime) => runtime.id);
    return [...(primaryActive ? [this.activeSessionId] : []), ...secondaryActive].filter((id): id is string => Boolean(id));
  }

  private controlState(sessionId: string, clientId = ""): { controlOwner?: string; controlledByThisWindow?: boolean } {
    const controlOwner = this.sessionControllers.get(sessionId);
    return { ...(controlOwner ? { controlOwner } : {}), ...(clientId ? { controlledByThisWindow: controlOwner === clientId } : {}) };
  }

  private setController(sessionId: string, clientId: string): void {
    if (!clientId || this.sessionControllers.get(sessionId) === clientId) return;
    this.sessionControllers.set(sessionId, clientId);
    this.broadcastControlState(sessionId);
  }

  private assertNoForeignController(sessionId: string, clientId: string): void {
    if (!clientId) return;
    const current = this.sessionControllers.get(sessionId);
    if (current && current !== clientId) throw new SessionControlConflictError("此对话正在另一窗口中控制；请先接管控制权");
  }

  private requireSessionControl(sessionId: string, clientId: string): void {
    // Non-browser integrations deliberately have no client identity. The Pi Chat
    // browser supplies X-Pi-Chat-Client for every request after bootstrap.
    this.assertNoForeignController(sessionId, clientId);
    if (clientId) this.setController(sessionId, clientId);
  }

  private clientConnected(clientId: string): void {
    if (!clientId) return;
    const timer = this.controllerReleaseTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.controllerReleaseTimers.delete(clientId);
    this.connectedClients.set(clientId, (this.connectedClients.get(clientId) || 0) + 1);
  }

  private releaseClient(clientId: string): string {
    if (!clientId) return "";
    const viewedSessionId = this.viewedSessionsByClient.get(clientId) || "";
    const timer = this.controllerReleaseTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.controllerReleaseTimers.delete(clientId);
    this.connectedClients.delete(clientId);
    this.viewedSessionsByClient.delete(clientId);
    for (const [sessionId, owner] of this.sessionControllers) {
      if (owner !== clientId) continue;
      this.sessionControllers.delete(sessionId);
      this.broadcastControlState(sessionId);
    }
    return viewedSessionId;
  }

  private async restSessionAfterWindowClose(sessionId: string): Promise<boolean> {
    if (!sessionId || this.isSessionViewed(sessionId)) return false;
    if (sessionId === this.activeSessionId) {
      if (this.running || this.dispatching || this.promptQueue.length || this.pendingExtensionRequest) return false;
      await this.options.rpc.stop();
      this.primaryFailed = true;
      this.broadcast({ type: "pi_chat_active_session_changed", sessionId, activeSessionIds: this.activeSessionIds(), reclaimed: true, reason: "window-closed" });
      return true;
    }
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || !this.canReclaimRuntime(runtime)) return false;
    return this.reclaimRuntime(sessionId, "idle");
  }

  private clientDisconnected(clientId: string): void {
    if (!clientId) return;
    const remaining = Math.max(0, (this.connectedClients.get(clientId) || 1) - 1);
    if (remaining) {
      this.connectedClients.set(clientId, remaining);
      return;
    }
    this.connectedClients.delete(clientId);
    const timer = setTimeout(() => {
      this.controllerReleaseTimers.delete(clientId);
      if (this.connectedClients.has(clientId)) return;
      this.viewedSessionsByClient.delete(clientId);
      for (const [sessionId, owner] of this.sessionControllers) {
        if (owner !== clientId) continue;
        this.sessionControllers.delete(sessionId);
        this.broadcastControlState(sessionId);
      }
    }, this.controllerReleaseMs);
    timer.unref();
    this.controllerReleaseTimers.set(clientId, timer);
  }

  private touchRuntime(runtime: SecondaryRuntime): void {
    runtime.lastUsedAt = this.now();
  }

  private markSessionViewed(clientId: string, sessionId: string): void {
    // A one-off HTTP request must not pin a worker forever. Presence is backed
    // by the browser window's live SSE lease and disappears after disconnect.
    if (clientId && sessionId && this.connectedClients.has(clientId)) this.viewedSessionsByClient.set(clientId, sessionId);
  }

  private isSessionViewed(sessionId: string): boolean {
    for (const viewedId of this.viewedSessionsByClient.values()) {
      if (viewedId === sessionId) return true;
    }
    return false;
  }

  private isIdleRuntime(runtime: SecondaryRuntime): boolean {
    return !runtime.running && !runtime.dispatching && !runtime.queuePaused && runtime.promptQueue.length === 0 && !runtime.extensionUiPending;
  }

  private canReclaimRuntime(runtime: SecondaryRuntime): boolean {
    // A browser may keep displaying JSONL history after its idle worker is
    // reclaimed. Viewing history is not a runtime pin; the hard warm-pool cap
    // must hold even when many windows inspect different cold Sessions.
    return this.isIdleRuntime(runtime);
  }

  private async cleanupEmptyDraft(runtime: SecondaryRuntime): Promise<void> {
    if (!runtime.draftSessionPath) return;
    let messages: PiMessage[];
    try {
      messages = await readSessionMessages(runtime.draftSessionPath);
    } catch (error) {
      // A sharing violation, permission error, or malformed read must never turn
      // into permission to delete a Session whose contents we could not verify.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[Pi Chat] 无法确认草稿为空，保留文件：${runtime.draftSessionPath}`, error);
      }
      return;
    }
    if (messages.some((message) => message.role === "user")) return;
    await unlink(runtime.draftSessionPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async reclaimRuntime(id: string, reason: "idle" | "capacity"): Promise<boolean> {
    const runtime = this.runtimes.get(id);
    if (!runtime || !this.canReclaimRuntime(runtime)) return false;
    // Remove it from routing before shutdown, and make a concurrent reopen wait for the old
    // process to exit so two Pi processes never write the same Session JSONL simultaneously.
    this.runtimes.delete(id);
    runtime.unsubscribe();
    const stopping = runtime.rpc.stop();
    this.runtimeStops.set(id, stopping);
    try {
      await stopping;
    } finally {
      if (this.runtimeStops.get(id) === stopping) this.runtimeStops.delete(id);
    }
    // A blank New draft is only a temporary composer backing process. It must
    // never accumulate as a recoverable conversation or Session JSONL.
    await this.cleanupEmptyDraft(runtime);
    this.broadcast({ type: "pi_chat_active_session_changed", sessionId: id, activeSessionIds: this.activeSessionIds(), reclaimed: true, reason });
    return true;
  }

  private async withRuntimeCapacity<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.runtimeCapacityTail;
    let release!: () => void;
    this.runtimeCapacityTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async makeRoomForSecondaryRuntime(): Promise<void> {
    const idleCount = [...this.runtimes.values()].filter((runtime) => this.isIdleRuntime(runtime)).length;
    const reclaimable = [...this.runtimes.values()].filter((runtime) => this.canReclaimRuntime(runtime)).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const excess = Math.max(0, idleCount - this.maxIdleSecondaryRuntimes + 1);
    for (const runtime of reclaimable.slice(0, excess)) await this.reclaimRuntime(runtime.id, "capacity");
  }

  private async sweepSecondaryRuntimes(): Promise<void> {
    if (this.closed || this.applicationLifecycle !== "idle") return;
    const now = this.now();
    const allIdle = [...this.runtimes.values()].filter((runtime) => this.isIdleRuntime(runtime));
    const reclaimable = allIdle.filter((runtime) => this.canReclaimRuntime(runtime)).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const expired = reclaimable.filter((runtime) => now - runtime.lastUsedAt >= this.secondaryRuntimeIdleMs);
    const reclaim = new Map<string, "idle" | "capacity">(expired.map((runtime) => [runtime.id, "idle"]));
    const retainedIdleCount = allIdle.length - expired.length;
    const excess = Math.max(0, retainedIdleCount - this.maxIdleSecondaryRuntimes);
    for (const runtime of reclaimable.filter((runtime) => !reclaim.has(runtime.id)).slice(0, excess)) reclaim.set(runtime.id, "capacity");
    for (const [id, reason] of reclaim) await this.reclaimRuntime(id, reason);
  }

  private pendingRequestForSession(sessionId: string): ExtensionUiRequest | undefined {
    return sessionId === this.activeSessionId ? this.pendingExtensionRequest : this.runtimes.get(sessionId)?.pendingExtensionRequest;
  }

  private trackPendingRequest(sessionId: string, request: ExtensionUiRequest): void {
    const previous = this.pendingExtensionTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.pendingExtensionTimers.delete(sessionId);
      const current = this.pendingRequestForSession(sessionId);
      if (!current || current.id !== request.id) return;
      const runtime = this.runtimes.get(sessionId);
      const targetRpc = runtime?.rpc || (sessionId === this.activeSessionId ? this.options.rpc : null);
      if (this.clearPendingRequest(sessionId, request.id) && targetRpc && targetRpc.isRunning?.() !== false) {
        try {
          targetRpc.sendRaw({ type: "extension_ui_response", id: request.id, cancelled: true });
          this.broadcast({ type: "pi_chat_extension_request_timeout", piChatSessionId: sessionId, id: request.id });
        } catch (error) {
          this.broadcast({ type: "pi_chat_process_error", piChatSessionId: sessionId, error: `权限确认超时清理失败：${error instanceof Error ? error.message : String(error)}` });
        }
      }
    }, this.gateRequestTimeoutMs);
    timer.unref();
    this.pendingExtensionTimers.set(sessionId, timer);
  }

  private clearPendingRequest(sessionId: string, requestId?: string): boolean {
    const current = this.pendingRequestForSession(sessionId);
    if (!current || (requestId && current.id !== requestId)) return false;
    const timer = this.pendingExtensionTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.pendingExtensionTimers.delete(sessionId);
    if (sessionId === this.activeSessionId) this.pendingExtensionRequest = undefined;
    else {
      const runtime = this.runtimes.get(sessionId);
      if (runtime) {
        runtime.pendingExtensionRequest = undefined;
        runtime.extensionUiPending = false;
      }
    }
    this.broadcast({ type: "pi_chat_extension_request_resolved", piChatSessionId: sessionId, id: current.id });
    return true;
  }

  private handleSecondaryEvent(runtime: SecondaryRuntime, event: Record<string, unknown>): void {
    const type = String(event.type || "");
    this.touchRuntime(runtime);
    if (type === "agent_start") {
      runtime.running = true;
      runtime.toolStatus = "Pi 正在思考…";
      this.beginContextUsageRefreshTurn(runtime.id);
    }
    if (type === "compaction_end" && event.aborted === false) this.markContextUsagePendingRefresh(runtime.id);
    if ((type === "message_start" || type === "message_update") && event.message && typeof event.message === "object" && (event.message as PiMessage).role === "assistant") {
      runtime.liveMessage = event.message as PiMessage;
    }
    if (type === "message_end" && event.message && typeof event.message === "object" && (event.message as PiMessage).role === "assistant") runtime.liveMessage = undefined;
    if (type === "tool_execution_start") runtime.toolStatus = `正在运行工具：${String(event.toolName || "unknown")}`;
    if (type === "tool_execution_end") runtime.toolStatus = `${String(event.toolName || "工具")} ${event.isError ? "执行失败" : "已完成"}`;
    if (type === "extension_ui_request") {
      const method = String(event.method || "");
      runtime.extensionUiPending = ["select", "confirm", "input", "editor"].includes(method);
      if (runtime.extensionUiPending && typeof event.id === "string") {
        runtime.pendingExtensionRequest = { ...(event as unknown as ExtensionUiRequest), piChatSessionId: runtime.id };
        this.trackPendingRequest(runtime.id, runtime.pendingExtensionRequest);
      }
    }
    if (type === "extension_error") this.clearPendingRequest(runtime.id);
    if (type === "pi_chat_process_error") {
      runtime.running = false;
      runtime.dispatching = false;
      runtime.toolStatus = "";
      runtime.failed = true;
      runtime.queuePaused = runtime.promptQueue.length > 0;
      this.clearPendingRequest(runtime.id);
      this.broadcastQueue(runtime.id);
      this.broadcast({ type: "pi_chat_sessions_changed", action: "status", sessionId: runtime.id });
    }
    this.broadcast({ ...event, piChatSessionId: runtime.id });
    if (type === "agent_start" || type === "message_start") this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: runtime.id });
    if (type === "agent_settled") {
      this.completeContextUsageRefreshTurn(runtime.id);
      runtime.running = false;
      runtime.dispatching = false;
      runtime.liveMessage = undefined;
      runtime.toolStatus = "";
      this.broadcast({ type: "pi_chat_session_status", sessionId: runtime.id, running: false });
      setTimeout(() => {
        void this.dispatchRuntimeNext(runtime);
        void this.sweepSecondaryRuntimes();
      }, 0);
    } else if (type === "agent_start") {
      this.broadcast({ type: "pi_chat_session_status", sessionId: runtime.id, running: true });
    }
  }

  private async ensureRuntime(id: string): Promise<SecondaryRuntime> {
    const stopping = this.runtimeStops.get(id);
    if (stopping) {
      await stopping;
      return this.ensureRuntime(id);
    }
    const existing = this.runtimes.get(id);
    if (existing) {
      this.touchRuntime(existing);
      if (existing.failed || existing.rpc.isRunning?.() === false) await this.recoverRuntime(existing);
      return existing;
    }
    const starting = this.runtimeStarts.get(id);
    if (starting) return starting;
    if (!this.options.createRpc) throw new Error("当前服务未启用多会话运行");
    const start = this.withRuntimeCapacity(async () => {
      await this.options.sessions.list(undefined, this.currentCwd);
      const path = this.options.sessions.pathForId(id);
      if (!path) throw new Error("会话不存在");
      await this.makeRoomForSecondaryRuntime();
      const rpc = this.options.createRpc!(this.currentCwd);
      const runtime: SecondaryRuntime = { id, rpc, sessionPath: path, running: false, queuePaused: false, dispatching: false, promptQueue: [], toolStatus: "", extensionUiPending: false, lastUsedAt: this.now(), unsubscribe: () => {}, pendingTurnSettings: {} };
      runtime.unsubscribe = rpc.onEvent((event) => this.handleSecondaryEvent(runtime, event));
      try {
        await rpc.start(["--session", path]);
        const state = asState(await rpc.send({ type: "get_state" }));
        runtime.running = state.isStreaming;
        this.runtimes.set(id, runtime);
        this.broadcast({ type: "pi_chat_active_session_changed", sessionId: id, activeSessionIds: this.activeSessionIds() });
        return runtime;
      } catch (error) {
        runtime.unsubscribe();
        await rpc.stop();
        throw error;
      }
    });
    this.runtimeStarts.set(id, start);
    try {
      return await start;
    } finally {
      if (this.runtimeStarts.get(id) === start) this.runtimeStarts.delete(id);
    }
  }

  private async recoverRuntime(runtime: SecondaryRuntime): Promise<void> {
    if (runtime.recovery) return runtime.recovery;
    if (!runtime.sessionPath) throw new Error("Pi RPC 已退出，且会话路径不可用");
    const recovery = (async () => {
      try {
        await runtime.rpc.restart(runtime.sessionPath, this.currentCwd);
        const state = asState(await runtime.rpc.send({ type: "get_state" }));
        runtime.running = state.isStreaming;
        runtime.failed = false;
        runtime.toolStatus = "";
        this.broadcast({ type: "pi_chat_process_recovered", piChatSessionId: runtime.id });
      } catch (error) {
        runtime.failed = true;
        throw new Error(`Pi RPC 恢复失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    runtime.recovery = recovery;
    try {
      await recovery;
    } finally {
      if (runtime.recovery === recovery) runtime.recovery = undefined;
    }
  }

  private async createDraftRuntime(): Promise<SecondaryRuntime> {
    if (!this.options.createRpc) throw new Error("当前服务未启用多会话运行");
    return this.withRuntimeCapacity(async () => {
      // Starting another New replaces any abandoned blank draft immediately.
      for (const draft of [...this.runtimes.values()].filter((runtime) => Boolean(runtime.draftSession))) await this.reclaimRuntime(draft.id, "capacity");
      await this.makeRoomForSecondaryRuntime();
      const rpc = this.options.createRpc!(this.currentCwd);
      const runtime: SecondaryRuntime = { id: "", rpc, running: false, queuePaused: false, dispatching: false, promptQueue: [], toolStatus: "", extensionUiPending: false, lastUsedAt: this.now(), unsubscribe: () => {}, pendingTurnSettings: {} };
      runtime.unsubscribe = rpc.onEvent((event) => this.handleSecondaryEvent(runtime, event));
      try {
        // Starting an RPC without --session creates an independent empty Pi Session.
        // This must not use the primary RPC: it may be busy with another conversation.
        await rpc.start();
        const state = asState(await rpc.send({ type: "get_state" }));
        if (!state.sessionFile) throw new Error("Pi 未返回新会话文件");
        runtime.id = idForPath(state.sessionFile);
        runtime.sessionPath = state.sessionFile;
        runtime.draftSessionPath = state.sessionFile;
        runtime.draftSession = {
          id: runtime.id,
          sessionId: state.sessionId || runtime.id,
          name: "新对话",
          preview: "尚未发送消息",
          cwd: this.currentCwd,
          updatedAt: this.now(),
          messageCount: 0,
          turnCount: 0,
          active: false,
        };
        this.runtimes.set(runtime.id, runtime);
        this.broadcast({ type: "pi_chat_active_session_changed", sessionId: runtime.id, activeSessionIds: this.activeSessionIds() });
        return runtime;
      } catch (error) {
        runtime.unsubscribe();
        await rpc.stop();
        throw error;
      }
    });
  }

  private handleRpcEvent(event: Record<string, unknown>): void {
    const type = String(event.type || "");
    if (type === "agent_start") {
      this.running = true;
      this.toolStatus = "Pi 正在思考…";
      this.beginContextUsageRefreshTurn(this.activeSessionId);
    }
    if (type === "compaction_end" && event.aborted === false) this.markContextUsagePendingRefresh(this.activeSessionId);
    if ((type === "message_start" || type === "message_update") && event.message && typeof event.message === "object" && (event.message as PiMessage).role === "assistant") {
      this.liveMessage = event.message as PiMessage;
    }
    if (type === "message_end" && event.message && typeof event.message === "object" && (event.message as PiMessage).role === "assistant") {
      this.liveMessage = undefined;
    }
    if (type === "tool_execution_start") this.toolStatus = `正在运行工具：${String(event.toolName || "unknown")}`;
    if (type === "tool_execution_end") this.toolStatus = `${String(event.toolName || "工具")} ${event.isError ? "执行失败" : "已完成"}`;
    if (type === "extension_ui_request") {
      const method = String(event.method || "");
      if (["select", "confirm", "input", "editor"].includes(method) && typeof event.id === "string") {
        this.pendingExtensionRequest = { ...(event as unknown as ExtensionUiRequest), piChatSessionId: this.activeSessionId };
        this.trackPendingRequest(this.activeSessionId, this.pendingExtensionRequest);
      }
    }
    if (type === "extension_error" || type === "pi_chat_process_error") this.clearPendingRequest(this.activeSessionId);
    if (type === "pi_chat_process_error") {
      this.running = false;
      this.dispatching = false;
      this.toolStatus = "";
      this.liveMessage = undefined;
      this.primaryFailed = true;
      this.queuePaused = this.promptQueue.length > 0;
      this.broadcastQueue();
      this.broadcast({ type: "pi_chat_sessions_changed", action: "status", sessionId: this.activeSessionId });
    }
    const taggedEvent = { ...event, piChatSessionId: this.activeSessionId };
    this.broadcast(taggedEvent);
    if (type === "agent_start" || type === "message_start") this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: this.activeSessionId });
    if (type === "agent_settled") {
      this.completeContextUsageRefreshTurn(this.activeSessionId);
      this.running = false;
      this.dispatching = false;
      this.liveMessage = undefined;
      this.toolStatus = "";
      this.broadcast({ type: "pi_chat_session_status", sessionId: this.activeSessionId, running: false });
      setTimeout(() => void this.dispatchNext(), 0);
    } else if (type === "agent_start") {
      this.broadcast({ type: "pi_chat_session_status", sessionId: this.activeSessionId, running: true });
    }
  }

  private async ensurePrimaryRuntime(): Promise<void> {
    if (!this.primaryFailed && this.options.rpc.isRunning?.() !== false) return;
    if (this.primaryRecovery) return this.primaryRecovery;
    const recovery = (async () => {
      try {
        await this.options.rpc.restart(this.activeSessionPath, this.currentCwd);
        const state = asState(await this.options.rpc.send({ type: "get_state" }));
        this.activeSessionId = state.sessionFile ? idForPath(state.sessionFile) : state.sessionId || this.activeSessionId;
        this.activeSessionPath = state.sessionFile || this.activeSessionPath;
        this.running = state.isStreaming;
        this.primaryFailed = false;
        this.toolStatus = "";
        this.broadcast({ type: "pi_chat_process_recovered", piChatSessionId: this.activeSessionId });
      } catch (error) {
        this.primaryFailed = true;
        throw new Error(`主 Pi RPC 恢复失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    this.primaryRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.primaryRecovery === recovery) this.primaryRecovery = null;
    }
  }

  private async extensionCommand(message: string, rpc = this.options.rpc): Promise<SlashCommand | null> {
    const match = /^\/([^\s/]+)/.exec(message);
    if (!match) return null;
    const response = await rpc.send({ type: "get_commands" });
    const command = asCommands(response).find((item) => item.name === match[1]);
    return command?.source === "extension" ? command : null;
  }

  private async applyPendingTurnSettings(rpc: PiRpcClient, pending: PendingTurnSettings): Promise<void> {
    if (pending.model) await rpc.send({ type: "set_model", provider: pending.model.provider, modelId: pending.model.modelId });
    if (pending.thinkingLevel) await rpc.send({ type: "set_thinking_level", level: pending.thinkingLevel });
    delete pending.model;
    delete pending.thinkingLevel;
  }

  private async sendPrompt(message: string, images: PromptImage[]): Promise<void> {
    await this.ensurePrimaryRuntime();
    await this.applyPendingTurnSettings(this.options.rpc, this.pendingTurnSettings);
    this.running = true;
    try {
      await this.options.rpc.send({ type: "prompt", message: message || "请查看这些图片。", ...(images.length ? { images } : {}) }, PROMPT_PREPARE_TIMEOUT_MS);
      // Pi persists the user message before prompt resolves. Refresh sidebar metadata so
      // this formerly empty composer immediately becomes a normal saved conversation.
      this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: this.activeSessionId });
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  private async dispatchRuntimeNext(runtime: SecondaryRuntime): Promise<void> {
    this.touchRuntime(runtime);
    if (this.closed || this.applicationLifecycle !== "idle" || runtime.running || runtime.dispatching || runtime.queuePaused || !runtime.promptQueue.length) return;
    if (runtime.failed || runtime.rpc.isRunning?.() === false) {
      try {
        await this.recoverRuntime(runtime);
      } catch (error) {
        runtime.queuePaused = true;
        this.broadcastQueue(runtime.id);
        this.broadcast({ type: "pi_chat_queue_error", error: error instanceof Error ? error.message : String(error), piChatSessionId: runtime.id });
        return;
      }
    }
    const next = runtime.promptQueue.shift();
    if (!next) return;
    runtime.dispatching = true;
    this.broadcastQueue(runtime.id);
    this.broadcast({ type: "pi_chat_queue_dispatch", id: next.id, message: next.message, imageCount: next.imageCount, piChatSessionId: runtime.id });
    try {
      await this.applyPendingTurnSettings(runtime.rpc, runtime.pendingTurnSettings);
      runtime.running = true;
      await runtime.rpc.send({ type: "prompt", message: next.message || "请查看这些图片。", ...(next.images.length ? { images: next.images } : {}) }, PROMPT_PREPARE_TIMEOUT_MS);
    } catch (error) {
      runtime.running = false;
      runtime.dispatching = false;
      runtime.queuePaused = true;
      runtime.promptQueue.unshift(next);
      this.broadcastQueue(runtime.id);
      this.broadcast({ type: "pi_chat_queue_error", error: error instanceof Error ? error.message : String(error), piChatSessionId: runtime.id });
    }
  }

  private async dispatchNext(): Promise<void> {
    if (this.closed || this.applicationLifecycle !== "idle" || this.running || this.dispatching || this.queuePaused || !this.promptQueue.length) return;
    const next = this.promptQueue.shift();
    if (!next) return;
    this.dispatching = true;
    this.broadcastQueue();
    this.broadcast({ type: "pi_chat_queue_dispatch", id: next.id, message: next.message, imageCount: next.imageCount, piChatSessionId: this.activeSessionId });
    try {
      await this.sendPrompt(next.message, next.images);
    } catch (error) {
      this.dispatching = false;
      this.queuePaused = true;
      this.promptQueue.unshift(next);
      this.broadcastQueue();
      this.broadcast({ type: "pi_chat_queue_error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private sessionSummaries(sessions: BootstrapData["sessions"], _state: PiState, clientId = ""): BootstrapData["sessions"] {
    // Drafts are intentionally absent: the sidebar contains only conversations
    // with at least one persisted user message.
    return sessions.map((session) => ({
      ...session,
      writable: this.activeSessionIds().includes(session.id),
      running: (this.running && session.id === this.activeSessionId) || this.runtimes.get(session.id)?.running === true,
      queued: session.id === this.activeSessionId ? this.promptQueue.length > 0 : (this.runtimes.get(session.id)?.promptQueue.length || 0) > 0,
      pendingConfirmation: Boolean(this.pendingRequestForSession(session.id)),
      ...this.controlState(session.id, clientId),
    })).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async reloadRpc(knownState?: PiState): Promise<void> {
    this.assertApplicationQuiescent("修改资源配置");
    const state = knownState || asState(await this.options.rpc.send({ type: "get_state" }));
    if (state.isStreaming) throw new Error("请先停止所有并行生成，再修改资源配置");
    for (const runtime of this.runtimes.values()) {
      runtime.unsubscribe();
      await runtime.rpc.stop();
    }
    this.runtimes.clear();
    await this.options.rpc.restart(state.sessionFile);
    this.broadcast({ type: "pi_chat_reloaded" });
  }

  private async applyResourceFileTransaction<T>(snapshots: FileSnapshot[], mutation: () => Promise<T>): Promise<T> {
    const state = asState(await this.options.rpc.send({ type: "get_state" }));
    if (state.isStreaming) throw new Error("请先停止所有并行生成，再修改资源配置");
    let changed = false;
    try {
      const result = await mutation();
      changed = true;
      await this.reloadRpc(state);
      return result;
    } catch (error) {
      if (!changed) throw error;
      const original = error instanceof Error ? error.message : String(error);
      try {
        await restoreSnapshots(snapshots);
        await this.options.rpc.restart(state.sessionFile);
        this.broadcast({ type: "pi_chat_reloaded" });
      } catch (rollbackError) {
        throw new Error(`资源修改失败，自动恢复也失败：${original}；恢复错误：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      throw new Error(`资源修改失败，原配置已自动恢复：${original}`);
    }
  }

  private async changeWorkspace(selected: string): Promise<{ workspaceName: string; data: BootstrapData }> {
    this.assertApplicationQuiescent("切换工作目录");
    const selectedCwd = resolve(selected);
    if (!(await stat(selectedCwd)).isDirectory()) throw new Error("所选工作目录不存在或不是文件夹");
    const previousCwd = this.currentCwd;
    const state = asState(await this.options.rpc.send({ type: "get_state" }));
    for (const runtime of this.runtimes.values()) {
      runtime.unsubscribe();
      await runtime.rpc.stop();
    }
    this.runtimes.clear();
    if (selectedCwd.toLowerCase() !== previousCwd.toLowerCase()) {
      try {
        await this.options.rpc.restart(undefined, selectedCwd);
        await saveWorkspace(selectedCwd);
      } catch (error) {
        const original = error instanceof Error ? error.message : String(error);
        try { await this.options.rpc.restart(state.sessionFile, previousCwd); }
        catch (rollbackError) {
          throw new Error(`工作目录切换失败，恢复旧 Runtime 也失败：${original}；恢复错误：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
        throw new Error(`工作目录切换失败，已恢复原工作目录：${original}`);
      }
      this.currentCwd = selectedCwd;
      this.broadcast({ type: "pi_chat_workspace_changed", cwd: selectedCwd });
    } else {
      await saveWorkspace(selectedCwd);
    }
    return { workspaceName: basename(selectedCwd), data: await this.bootstrap() };
  }

  private async renameSession(id: string, name: string): Promise<BootstrapData> {
    await this.options.sessions.list(undefined, this.currentCwd);
    const isPrimary = id === this.activeSessionId;
    const draft = this.runtimes.get(id)?.draftSession;
    if (draft) throw new Error("空白新对话会在发送第一条消息后保存，届时才能重命名");
    const path = this.options.sessions.pathForId(id);
    if (!isPrimary && !path) throw new Error("会话不存在");
    const wasOpen = isPrimary || this.runtimes.has(id);
    const runtime = isPrimary ? null : await this.ensureRuntime(id);
    await (runtime?.rpc || this.options.rpc).send({ type: "set_session_name", name });
    if (!wasOpen && runtime && !runtime.running) {
      runtime.unsubscribe();
      await runtime.rpc.stop();
      this.runtimes.delete(id);
    }
    this.broadcast({ type: "pi_chat_sessions_changed", action: "renamed", sessionId: id });
    return this.bootstrap();
  }

  private async deleteSession(id: string): Promise<BootstrapData> {
    await this.options.sessions.list(undefined, this.currentCwd);
    const isPrimary = id === this.activeSessionId;
    const state = isPrimary ? asState(await this.options.rpc.send({ type: "get_state" })) : null;
    // Empty New sessions stay out of the sidebar and SessionIndex. The runtime
    // still owns the authoritative draft path if cleanup is requested directly.
    const runtime = this.runtimes.get(id);
    const path = isPrimary ? state?.sessionFile : this.options.sessions.pathForId(id) || runtime?.draftSessionPath;
    if (!isPrimary && !path) throw new Error("会话不存在");
    if (isPrimary) {
      if (this.running || this.promptQueue.length || this.pendingExtensionRequest) throw new Error("请先停止当前生成、处理权限确认并清空队列，再删除此会话");
      const result = rpcData<{ cancelled: boolean }>(await this.options.rpc.send({ type: "new_session" }));
      if (result.cancelled) throw new Error("扩展取消了新建会话，无法删除当前会话");
      await this.bootstrap();
    } else {
      if (runtime?.running || runtime?.promptQueue.length || runtime?.extensionUiPending) throw new Error("请先停止该会话的生成、处理权限确认并清空队列，再删除对话");
      if (runtime) {
        runtime.unsubscribe();
        await runtime.rpc.stop();
        this.runtimes.delete(id);
      }
    }
    if (path && existsSync(path)) await unlink(path);
    this.sessionControllers.delete(id);
    for (const [clientId, viewedId] of this.viewedSessionsByClient) {
      if (viewedId === id) this.viewedSessionsByClient.delete(clientId);
    }
    this.broadcast({ type: "pi_chat_sessions_changed", action: "deleted", sessionId: id });
    return this.bootstrap();
  }

  private async coldSessionView(id: string, session: SessionSummary, turnLimit: number, clientId: string): Promise<SessionViewData | null> {
    const snapshot = await this.options.sessions.snapshotForId?.(id);
    const messages = snapshot?.messages ?? await this.options.sessions.messagesForId(id);
    if (!messages) return null;
    const windowed = messageWindow(messages, turnLimit);
    return {
      session: { ...session, active: false, writable: false, running: false, queued: false },
      state: { ...this.lastPrimaryState, isStreaming: false, isCompacting: false },
      messages: windowed.messages,
      messageTotal: windowed.total,
      turnTotal: windowed.turns,
      visibleTurnCount: windowed.visibleTurns,
      messagesTruncated: windowed.truncated,
      isActive: false,
      runtimeStatus: "view-only",
      isStreaming: false,
      stats: await this.offlineStatsForId(id, snapshot?.usage),
      gateAvailable: await this.gateExtensionEnabled(),
      commands: [],
      pendingExtensionRequest: this.pendingRequestForSession(id),
      ...this.controlState(id, clientId),
    };
  }

  private async sessionView(id: string, turnLimit = RECENT_TURN_WINDOW_SIZE, clientId = ""): Promise<SessionViewData | null> {
    const knownRuntime = this.runtimes.get(id);
    // Cold history is a pure JSONL read. Avoid waking or querying the Primary RPC
    // and avoid rescanning every Session when the index already knows this ID.
    if (id !== this.activeSessionId && !knownRuntime) {
      const knownSession = this.options.sessions.summaryForId?.(id);
      if (knownSession) return this.coldSessionView(id, knownSession, turnLimit, clientId);
    }
    const primaryAvailable = this.applicationLifecycle === "idle" && !this.primaryFailed && this.options.rpc.isRunning?.() !== false;
    const state = primaryAvailable
      ? asState(await this.options.rpc.send({ type: "get_state" }))
      : { model: null, isStreaming: false } satisfies PiState;
    if (primaryAvailable) {
      this.lastPrimaryState = state;
      this.running = state.isStreaming;
      this.activeSessionId = state.sessionFile ? idForPath(state.sessionFile) : state.sessionId || this.activeSessionId;
      this.activeSessionPath = state.sessionFile || this.activeSessionPath;
    }
    const sessions = this.sessionSummaries(await this.options.sessions.list(this.activeSessionPath, this.currentCwd), state, clientId);
    const secondaryRuntime = knownRuntime;
    // A fresh New view is valid even though it is deliberately absent from the
    // sidebar until its first user message is persisted.
    const session = sessions.find((item) => item.id === id) || secondaryRuntime?.draftSession;
    if (!session) return null;
    const secondaryReadable = this.applicationLifecycle === "idle" && secondaryRuntime && !secondaryRuntime.failed && secondaryRuntime.rpc.isRunning?.() !== false ? secondaryRuntime : null;
    const runtime = id === this.activeSessionId && primaryAvailable
      ? { rpc: this.options.rpc, running: this.running, liveMessage: this.liveMessage, toolStatus: this.toolStatus }
      : secondaryReadable;
    if (runtime) {
      if (id !== this.activeSessionId) this.touchRuntime(runtime as SecondaryRuntime);
      const [stateResponse, statsResponse, commandsResponse] = await Promise.all([
        runtime.rpc.send({ type: "get_state" }),
        runtime.rpc.send({ type: "get_session_stats" }),
        runtime.rpc.send({ type: "get_commands" }).catch(() => null),
      ]);
      // A secondary RPC only knows changes made through that process. Once it is idle,
      // the JSONL is the shared source of truth: another Pi window may have continued
      // the same Session after this runtime was opened. Keep RPC messages only while
      // streaming so the UI can show the not-yet-persisted live answer.
      const persistedMessages = runtime.running ? null : await this.options.sessions.messagesForId(id);
      const messages = persistedMessages || asMessages(await runtime.rpc.send({ type: "get_messages" }));
      const windowed = messageWindow(messages, turnLimit);
      return {
        session,
        state: asState(stateResponse),
        messages: windowed.messages,
        messageTotal: windowed.total,
        turnTotal: windowed.turns,
        visibleTurnCount: windowed.visibleTurns,
        messagesTruncated: windowed.truncated,
        isActive: true,
        runtimeStatus: "active",
        isStreaming: runtime.running,
        liveMessage: runtime.liveMessage,
        toolStatus: runtime.toolStatus,
        stats: await this.statsForSession(id, statsResponse),
        queue: id === this.activeSessionId ? this.publicQueue() : this.publicQueue((runtime as SecondaryRuntime).promptQueue),
        queuePaused: id === this.activeSessionId ? this.queuePaused : (runtime as SecondaryRuntime).queuePaused,
        commands: commandsResponse ? [...BUILTIN_COMMANDS, ...asCommands(commandsResponse)] : undefined,
        pendingExtensionRequest: this.pendingRequestForSession(id),
        ...this.controlState(id, clientId),
      };
    }
    return this.coldSessionView(id, session, turnLimit, clientId);
  }

  /**
   * Token stats for a cold session, derived from its JSONL instead of waking
   * a Pi process. The context window comes from the model catalogue; when the
   * model is unknown the percentage stays unavailable rather than guessed.
   */
  private markContextUsagePendingRefresh(id: string): void {
    if (id) this.contextUsagePendingRefresh.add(id);
  }

  private beginContextUsageRefreshTurn(id: string): void {
    if (this.contextUsagePendingRefresh.has(id)) this.contextUsageRefreshTurn.add(id);
  }

  private completeContextUsageRefreshTurn(id: string): void {
    if (!this.contextUsageRefreshTurn.delete(id)) return;
    this.contextUsagePendingRefresh.delete(id);
  }

  private rememberModelContextWindows(models: ModelInfo[]): void {
    for (const model of models) {
      if (typeof model.contextWindow === "number" && model.contextWindow > 0) this.modelContextWindows.set(`${model.provider}\u0000${model.id}`, model.contextWindow);
    }
  }

  private async offlineStatsForId(id: string, knownUsage?: SessionUsageSnapshot): Promise<SessionStats | undefined> {
    // Optional-chained: test doubles and older indexes may not implement usageForId.
    const usage = knownUsage ?? await Promise.resolve(this.options.sessions.usageForId?.(id)).catch(() => null);
    if (!usage) return undefined;
    const stats: SessionStats = { tokens: usage.tokens };
    if (usage.context) {
      const contextWindow = this.modelContextWindows.get(`${usage.context.provider || ""}\u0000${usage.context.model || ""}`) || 0;
      if (!contextWindow) console.warn(`[Pi Chat] 冷会话上下文用量：未找到模型 ${usage.context.provider}/${usage.context.model} 的 contextWindow`);
      if (contextWindow > 0) {
        const pendingRefresh = this.contextUsagePendingRefresh.has(id);
        stats.contextUsage = pendingRefresh
          ? { tokens: null, contextWindow, percent: null }
          : { tokens: usage.context.tokens, contextWindow, percent: Math.min(100, (usage.context.tokens / contextWindow) * 100) };
        if (pendingRefresh) stats.contextUsagePendingRefresh = true;
      }
    }
    return stats;
  }

  /** Prefer Pi's live counters, but use persisted usage whenever it omits occupancy. */
  private async statsForSession(id: string, response: Record<string, unknown>): Promise<SessionStats> {
    const live = asSessionStats(response);
    const fallback = await this.offlineStatsForId(id);
    const contextUsage = live.contextUsage || fallback?.contextUsage;
    return {
      ...live,
      ...(contextUsage ? { contextUsage } : {}),
      ...(fallback?.contextUsagePendingRefresh ? { contextUsagePendingRefresh: true } : {}),
    };
  }

  /** The Gate UI belongs to Pi Chat; its tiny Pi hook is a verified system component. */
  private async gateExtensionEnabled(): Promise<boolean> {
    try {
      const manager = this.options.resources as ResourceManager & { systemGateEnabled?: () => Promise<boolean> };
      return manager.systemGateEnabled ? await manager.systemGateEnabled() : true;
    } catch {
      return false;
    }
  }

  private async bootstrap(clientId = ""): Promise<BootstrapData> {
    if (this.applicationLifecycle !== "idle" && (this.primaryFailed || this.options.rpc.isRunning?.() === false)) {
      throw new ApplicationLifecycleConflictError(this.applicationLifecycle, this.lifecycleMessage());
    }
    await this.ensurePrimaryRuntime();
    const [stateResponse, messagesResponse, modelsResponse, commandsResponse, statsResponse] = await Promise.all([
      this.options.rpc.send({ type: "get_state" }),
      this.options.rpc.send({ type: "get_messages" }),
      this.options.rpc.send({ type: "get_available_models" }),
      this.options.rpc.send({ type: "get_commands" }),
      this.options.rpc.send({ type: "get_session_stats" }),
    ]);
    const state = asState(stateResponse);
    this.lastPrimaryState = state;
    const availableModels = this.options.modelManager ? await this.options.modelManager.annotate(asModels(modelsResponse)) : asModels(modelsResponse);
    this.rememberModelContextWindows(availableModels);
    const windowedMessages = messageWindow(asMessages(messagesResponse));
    this.running = state.isStreaming;
    this.activeSessionId = state.sessionFile ? idForPath(state.sessionFile) : state.sessionId || "";
    this.activeSessionPath = state.sessionFile;
    const sessions = this.sessionSummaries(await this.options.sessions.list(state.sessionFile, this.currentCwd), state, clientId);
    return {
      state,
      messages: windowedMessages.messages,
      messageTotal: windowedMessages.total,
      turnTotal: windowedMessages.turns,
      visibleTurnCount: windowedMessages.visibleTurns,
      messagesTruncated: windowedMessages.truncated,
      activeSessionId: this.activeSessionId,
      activeSessionIds: this.activeSessionIds(),
      liveMessage: this.liveMessage,
      toolStatus: this.toolStatus,
      stats: await this.statsForSession(this.activeSessionId, statsResponse),
      models: availableModels,
      commands: [...BUILTIN_COMMANDS, ...asCommands(commandsResponse)],
      queue: this.publicQueue(),
      queuePaused: this.queuePaused,
      pendingExtensionRequest: this.pendingRequestForSession(this.activeSessionId),
      ...this.controlState(this.activeSessionId, clientId),
      workspaceCwd: this.currentCwd,
      sessions,
      applicationLifecycle: this.applicationLifecycle,
    };
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const requestError = requestGuardError(request, { allowedHosts: this.allowedHosts, token: this.requestToken });
      if (requestError) return json(response, 403, { error: requestError });
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        await this.handleApi(request, response, url);
        return;
      }
      if (this.options.devMiddleware) {
        this.options.devMiddleware(request, response, () => {
          if (!response.writableEnded) json(response, 404, { error: "Not found" });
        });
        return;
      }
      await this.serveStatic(response, url.pathname);
    } catch (error) {
      if (error instanceof ApplicationLifecycleConflictError) {
        response.setHeader("retry-after", "2");
        const isBootstrap = new URL(request.url || "/", "http://127.0.0.1").pathname === "/api/bootstrap";
        return json(response, 503, { error: error.message, code: "APPLICATION_LIFECYCLE_BLOCKED", lifecycle: error.lifecycle, retryable: true, ...(isBootstrap ? { requestToken: this.requestToken } : {}) });
      }
      if (error instanceof ApplicationBusyError) return json(response, 409, { error: error.message, code: "APPLICATION_BUSY" });
      if (error instanceof SessionControlConflictError) return json(response, 409, { error: error.message });
      if (response.headersSent) {
        response.end();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      json(response, 500, { error: message });
    }
  }

  private async handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const releaseMutation = this.isOrdinaryMutation(request, url) ? this.beginMutation() : null;
    try {
      await this.handleApiCore(request, response, url);
    } finally {
      releaseMutation?.();
    }
  }

  private async handleApiCore(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const clientId = requestClientId(request);
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") return methodNotAllowed(response);
      json(response, 200, { ok: true, service: "pi-chat", lifecycle: this.applicationLifecycle });
      return;
    }

    if (url.pathname === "/api/events") {
      if (request.method !== "GET") return methodNotAllowed(response);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.write(`event: ready\ndata: ${JSON.stringify({ ok: true, lifecycle: this.applicationLifecycle })}\n\n`);
      this.sseClients.set(response, clientId);
      this.clientConnected(clientId);
      const timer = setInterval(() => response.write(": ping\n\n"), 20_000);
      request.once("close", () => {
        clearInterval(timer);
        this.sseClients.delete(response);
        this.clientDisconnected(clientId);
      });
      return;
    }

    if (url.pathname === "/api/bootstrap") {
      if (request.method !== "GET") return methodNotAllowed(response);
      if (this.applicationLifecycle !== "idle") throw new ApplicationLifecycleConflictError(this.applicationLifecycle, this.lifecycleMessage());
      json(response, 200, { ...await this.bootstrap(clientId), requestToken: this.requestToken });
      return;
    }

    if (url.pathname === "/api/window/close") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (!clientId) return json(response, 400, { error: "缺少窗口标识，无法安全关闭" });
      if (this.applicationLifecycle !== "idle") throw new ApplicationLifecycleConflictError(this.applicationLifecycle, this.lifecycleMessage());
      const otherWindowCount = [...this.connectedClients.keys()].filter((id) => id !== clientId).length;
      if (otherWindowCount > 0) {
        const viewedSessionId = this.releaseClient(clientId);
        // A Prompt may already hold an admission lease while its request body is
        // still arriving. Do not stop any Runtime until all admitted mutations finish.
        const rested = this.activeMutationRequests === 0 && this.runtimeStarts.size === 0
          ? await this.restSessionAfterWindowClose(viewedSessionId)
          : false;
        json(response, 200, { shuttingDown: false, closeWindow: true, sessionId: viewedSessionId, rested, remainingWindows: otherWindowCount });
        return;
      }
      if (!this.options.applicationShutdown) return json(response, 501, { error: "当前启动方式不支持从网页关闭 Pi Chat；请关闭服务进程。" });
      this.beginLifecycle("shutting-down");
      try {
        await this.verifyApplicationQuiescent("关闭 Pi Chat");
        this.releaseClient(clientId);
        this.broadcast({ type: "pi_chat_application_closing" });
        json(response, 202, { shuttingDown: true, closeWindow: true, remainingWindows: 0 });
        setTimeout(() => this.options.applicationShutdown?.(), 0);
      } catch (error) {
        this.endLifecycle("shutting-down");
        throw error;
      }
      return;
    }

    if (url.pathname === "/api/restart" || url.pathname === "/api/shutdown") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const shuttingDown = url.pathname === "/api/shutdown";
      const lifecycle = shuttingDown ? "shutting-down" : "restarting";
      if (shuttingDown && !this.options.applicationShutdown) return json(response, 501, { error: "当前启动方式不支持从网页关闭 Pi Chat；请关闭服务进程。" });
      if (!shuttingDown && !this.options.applicationRestart) return json(response, 501, { error: "当前启动方式不支持应用更新并重启；请在 Pi Chat 项目目录运行 npm run build 后重启服务。" });
      this.beginLifecycle(lifecycle);
      try {
        await this.verifyApplicationQuiescent(shuttingDown ? "关闭 Pi Chat" : "应用更新并重启");
        if (shuttingDown) {
          this.broadcast({ type: "pi_chat_application_closing" });
          json(response, 202, { shuttingDown: true });
          this.options.applicationShutdown?.();
          return;
        }
        const prepared = await this.options.applicationRestart!();
        try {
          // Defense in depth: no request admitted after the barrier may have made
          // the application busy, but internal runtime work must also be quiescent.
          await this.verifyApplicationQuiescent("完成重启");
          // Promotion is still reversible on failure and happens before the HTTP
          // response. The irreversible process handoff begins only after 202.
          await prepared.promote();
        } catch (error) {
          await prepared.discard();
          throw error;
        }
        json(response, 202, { restarting: true });
        prepared.handoff();
        return;
      } catch (error) {
        this.endLifecycle(lifecycle);
        throw error;
      }
    }

    if (url.pathname === "/api/chat/prompt") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request, 45_000_000);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const images = promptImages(body.images);
      if (!message && !images.length) return json(response, 400, { error: "消息或图片不能为空" });
      this.requireSessionControl(requestedSessionId || this.activeSessionId, clientId);
      // A browser tab can outlive a Pi Chat restart. Restore its requested Session on demand
      // instead of rejecting the prompt because the old in-memory worker map was lost.
      if (requestedSessionId && !this.activeSessionIds().includes(requestedSessionId)) await this.ensureRuntime(requestedSessionId);
      const secondaryRuntime = requestedSessionId ? this.runtimes.get(requestedSessionId) || null : null;
      if (secondaryRuntime) {
        this.touchRuntime(secondaryRuntime);
        if (secondaryRuntime.failed || secondaryRuntime.rpc.isRunning?.() === false) await this.recoverRuntime(secondaryRuntime);
      } else {
        await this.ensurePrimaryRuntime();
      }
      const targetRpc = secondaryRuntime?.rpc || this.options.rpc;
      const extensionCommand = message ? await this.extensionCommand(message, targetRpc) : null;
      if (extensionCommand) {
        if (images.length) return json(response, 400, { error: "Extension 指令不能同时附加图片" });
        await targetRpc.send({ type: "prompt", message }, PROMPT_PREPARE_TIMEOUT_MS);
        const state = asState(await targetRpc.send({ type: "get_state" }));
        if (secondaryRuntime) secondaryRuntime.running = state.isStreaming;
        else this.running = state.isStreaming;
        json(response, 202, { accepted: true, queued: false, extension: true, command: extensionCommand.name, description: extensionCommand.description, isStreaming: state.isStreaming });
        return;
      }
      if (secondaryRuntime) {
        if (secondaryRuntime.running || secondaryRuntime.dispatching || secondaryRuntime.promptQueue.length || secondaryRuntime.queuePaused) {
          if (secondaryRuntime.promptQueue.length >= 20) return json(response, 409, { error: "队列已满，最多保留 20 条" });
          const queuedImageChars = secondaryRuntime.promptQueue.reduce((total, item) => total + item.images.reduce((sum, image) => sum + image.data.length, 0), 0);
          const incomingImageChars = images.reduce((total, image) => total + image.data.length, 0);
          if (queuedImageChars + incomingImageChars > 45_000_000) return json(response, 409, { error: "队列中的图片总量超过约 32 MB，请先等待或撤销部分消息" });
          const queued: InternalQueuedPrompt = { id: randomUUID(), message, images, imageCount: images.length, createdAt: Date.now() };
          secondaryRuntime.promptQueue.push(queued);
          this.broadcastQueue(secondaryRuntime.id);
          return json(response, 202, { accepted: true, queued: true, id: queued.id, queue: this.publicQueue(secondaryRuntime.promptQueue) });
        }
        try {
          await this.applyPendingTurnSettings(secondaryRuntime.rpc, secondaryRuntime.pendingTurnSettings);
          secondaryRuntime.running = true;
          await secondaryRuntime.rpc.send({ type: "prompt", message: message || "请查看这些图片。", ...(images.length ? { images } : {}) }, PROMPT_PREPARE_TIMEOUT_MS);
          secondaryRuntime.draftSession = undefined;
          secondaryRuntime.draftSessionPath = undefined;
          this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: secondaryRuntime.id });
          json(response, 202, { accepted: true, queued: false });
        } catch (error) {
          secondaryRuntime.running = false;
          throw error;
        }
        return;
      }
      if (this.running || this.dispatching || this.promptQueue.length || this.queuePaused) {
        if (this.promptQueue.length >= 20) return json(response, 409, { error: "队列已满，最多保留 20 条" });
        const queuedImageChars = this.promptQueue.reduce((total, item) => total + item.images.reduce((sum, image) => sum + image.data.length, 0), 0);
        const incomingImageChars = images.reduce((total, image) => total + image.data.length, 0);
        if (queuedImageChars + incomingImageChars > 45_000_000) return json(response, 409, { error: "队列中的图片总量超过约 32 MB，请先等待或撤销部分消息" });
        const queued: InternalQueuedPrompt = { id: randomUUID(), message, images, imageCount: images.length, createdAt: Date.now() };
        this.promptQueue.push(queued);
        this.broadcastQueue();
        json(response, 202, { accepted: true, queued: true, id: queued.id, queue: this.publicQueue() });
        return;
      }
      await this.sendPrompt(message, images);
      json(response, 202, { accepted: true, queued: false });
      return;
    }

    const queueCancelMatch = /^\/api\/chat\/queue\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (queueCancelMatch) {
      if (request.method !== "DELETE") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      this.requireSessionControl(sessionId, clientId);
      const runtime = this.runtimes.get(sessionId);
      if (!runtime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未恢复运行，请刷新页面后重试" });
      if (runtime) this.touchRuntime(runtime);
      const queue = runtime?.promptQueue || this.promptQueue;
      const index = queue.findIndex((item) => item.id === queueCancelMatch[1]);
      if (index < 0) return json(response, 404, { error: "队列消息不存在或已经开始执行" });
      queue.splice(index, 1);
      if (runtime) {
        if (!queue.length) runtime.queuePaused = false;
      } else if (!queue.length) this.queuePaused = false;
      this.broadcastQueue(sessionId);
      json(response, 200, { queue: this.publicQueue(queue), paused: runtime?.queuePaused ?? this.queuePaused });
      return;
    }

    if (url.pathname === "/api/chat/queue/resume") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      this.requireSessionControl(sessionId, clientId);
      const runtime = this.runtimes.get(sessionId);
      if (!runtime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未恢复运行，请刷新页面后重试" });
      if (runtime) {
        this.touchRuntime(runtime);
        if (runtime.failed || runtime.rpc.isRunning?.() === false) await this.recoverRuntime(runtime);
        runtime.queuePaused = false;
        this.broadcastQueue(sessionId);
        void this.dispatchRuntimeNext(runtime);
        return json(response, 200, { queue: this.publicQueue(runtime.promptQueue), paused: false });
      }
      this.queuePaused = false;
      this.broadcastQueue();
      void this.dispatchNext();
      json(response, 200, { queue: this.publicQueue(), paused: false });
      return;
    }

    if (url.pathname === "/api/local-files/pick") {
      if (request.method !== "POST") return methodNotAllowed(response);
      json(response, 200, { paths: await pickLocalFiles() });
      return;
    }

    if (url.pathname === "/api/local-files/clipboard") {
      if (request.method !== "POST") return methodNotAllowed(response);
      json(response, 200, { paths: await readClipboardFiles() });
      return;
    }

    if (url.pathname === "/api/workspace/pick") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (this.applicationLifecycle !== "idle") throw new ApplicationLifecycleConflictError(this.applicationLifecycle, this.lifecycleMessage());
      if (this.busyConversationCount()) return json(response, 409, { error: "请先停止所有并行生成并清空队列" });
      // Do not lock chat while the native picker is merely open. Acquire the
      // exclusive barrier only after the user has selected a directory.
      const selected = await pickWorkspaceFolder(this.currentCwd);
      if (!selected) return json(response, 200, { cancelled: true });
      const result = await this.withLifecycle("workspace-changing", "切换工作目录", () => this.changeWorkspace(selected));
      json(response, 200, { cancelled: false, ...result });
      return;
    }

    if (url.pathname === "/api/workspace/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const selected = typeof body.path === "string" ? body.path.trim() : "";
      if (!selected) return json(response, 400, { error: "path 必填" });
      const result = await this.withLifecycle("workspace-changing", "切换工作目录", () => this.changeWorkspace(selected));
      json(response, 200, { cancelled: false, ...result });
      return;
    }

    if (url.pathname === "/api/chat/compact") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      this.requireSessionControl(sessionId, clientId);
      const secondaryRuntime = this.runtimes.get(sessionId) || null;
      if (secondaryRuntime?.failed || secondaryRuntime?.rpc.isRunning?.() === false) await this.recoverRuntime(secondaryRuntime);
      else if (!secondaryRuntime) await this.ensurePrimaryRuntime();
      if ((!secondaryRuntime && (this.running || this.promptQueue.length)) || secondaryRuntime?.running) return json(response, 409, { error: "请先停止该会话的生成并清空队列" });
      if (!secondaryRuntime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未启用" });
      const customInstructions = typeof body.customInstructions === "string" ? body.customInstructions.trim() : "";
      const result = rpcData<Record<string, unknown>>(await (secondaryRuntime?.rpc || this.options.rpc).send({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }, PROMPT_PREPARE_TIMEOUT_MS));
      json(response, 200, { result });
      return;
    }

    if (url.pathname === "/api/chat/abort") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      this.requireSessionControl(sessionId, clientId);
      const runtime = this.runtimes.get(sessionId);
      if (runtime) {
        this.touchRuntime(runtime);
        if (runtime.failed || runtime.rpc.isRunning?.() === false) return json(response, 200, { ok: true, isStreaming: false, queuePaused: runtime.queuePaused });
        if (runtime.promptQueue.length) runtime.queuePaused = true;
        await runtime.rpc.send({ type: "abort" }, 10_000);
        const state = asState(await runtime.rpc.send({ type: "get_state" }));
        runtime.running = state.isStreaming;
        this.broadcastQueue(sessionId);
        return json(response, 200, { ok: true, isStreaming: state.isStreaming, queuePaused: runtime.queuePaused });
      }
      if (sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话不是活动运行会话" });
      if (this.primaryFailed || this.options.rpc.isRunning?.() === false) return json(response, 200, { ok: true, isStreaming: false, queuePaused: this.queuePaused });
      if (this.promptQueue.length) this.queuePaused = true;
      await this.options.rpc.send({ type: "abort" }, 10_000);
      this.broadcastQueue();
      const state = asState(await this.options.rpc.send({ type: "get_state" }));
      this.running = state.isStreaming;
      json(response, 200, { ok: true, isStreaming: state.isStreaming, queuePaused: this.queuePaused });
      return;
    }

    if (url.pathname === "/api/sessions") {
      if (request.method !== "GET") return methodNotAllowed(response);
      if (this.applicationLifecycle !== "idle") {
        const state: PiState = { model: null, isStreaming: false };
        const sessions = this.sessionSummaries(await this.options.sessions.list(this.activeSessionPath, this.currentCwd), state, clientId);
        json(response, 200, { sessions, applicationLifecycle: this.applicationLifecycle });
        return;
      }
      await this.ensurePrimaryRuntime();
      const state = asState(await this.options.rpc.send({ type: "get_state" }));
      const sessions = this.sessionSummaries(await this.options.sessions.list(state.sessionFile, this.currentCwd), state, clientId);
      json(response, 200, { sessions, applicationLifecycle: this.applicationLifecycle });
      return;
    }

    const manageSessionMatch = /^\/api\/sessions\/([a-f0-9]{20})$/.exec(url.pathname);
    if (manageSessionMatch) {
      if (request.method === "PATCH") {
        this.requireSessionControl(manageSessionMatch[1], clientId);
        const body = await bodyJson(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) return json(response, 400, { error: "名称必须为 1 到 120 个有效字符" });
        json(response, 200, await this.renameSession(manageSessionMatch[1], name));
        return;
      }
      if (request.method === "DELETE") {
        this.requireSessionControl(manageSessionMatch[1], clientId);
        json(response, 200, await this.deleteSession(manageSessionMatch[1]));
        return;
      }
      return methodNotAllowed(response);
    }

    const viewingMatch = /^\/api\/sessions\/([a-f0-9]{20})\/viewing$/.exec(url.pathname);
    if (viewingMatch) {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (!clientId) return json(response, 400, { error: "浏览器窗口标识无效" });
      const id = viewingMatch[1];
      const summaries = await this.options.sessions.list(undefined, this.currentCwd);
      if (!summaries.some((session) => session.id === id) && !this.runtimes.has(id) && id !== this.activeSessionId) return json(response, 404, { error: "会话不存在" });
      this.markSessionViewed(clientId, id);
      const runtime = this.runtimes.get(id);
      if (runtime) this.touchRuntime(runtime);
      json(response, 200, { viewing: id });
      return;
    }

    const viewMatch = /^\/api\/sessions\/([a-f0-9]{20})\/view$/.exec(url.pathname);
    if (viewMatch) {
      if (request.method !== "GET") return methodNotAllowed(response);
      // Reading a cold history is deliberately view-only: do not wake a Pi process
      // just because the user is inspecting its JSONL. Runtime creation is explicit
      // on /activate (send, model/thinking changes, compaction, or taking control).
      const rawTurns = url.searchParams.get("turns");
      const turnLimit = rawTurns === null ? RECENT_TURN_WINDOW_SIZE : Number(rawTurns);
      if (!Number.isInteger(turnLimit) || turnLimit < RECENT_TURN_WINDOW_SIZE || turnLimit > MAX_TURN_WINDOW_SIZE || (turnLimit - RECENT_TURN_WINDOW_SIZE) % TURN_WINDOW_INCREMENT !== 0) {
        return json(response, 400, { error: `turns 必须从 ${RECENT_TURN_WINDOW_SIZE} 开始，并每次增加 ${TURN_WINDOW_INCREMENT}` });
      }
      this.markSessionViewed(clientId, viewMatch[1]);
      const view = await this.sessionView(viewMatch[1], turnLimit, clientId);
      if (!view) return json(response, 404, { error: "会话不存在" });
      json(response, 200, view);
      return;
    }

    const controlMatch = /^\/api\/sessions\/([a-f0-9]{20})\/control$/.exec(url.pathname);
    if (controlMatch) {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (!clientId) return json(response, 400, { error: "浏览器窗口标识无效" });
      const summaries = await this.options.sessions.list(undefined, this.currentCwd);
      if (!summaries.some((session) => session.id === controlMatch[1]) && !this.runtimes.has(controlMatch[1])) return json(response, 404, { error: "会话不存在" });
      this.setController(controlMatch[1], clientId);
      json(response, 200, this.controlState(controlMatch[1], clientId));
      return;
    }

    const activateMatch = /^\/api\/sessions\/([a-f0-9]{20})\/activate$/.exec(url.pathname);
    if (activateMatch) {
      if (request.method !== "POST") return methodNotAllowed(response);
      const id = activateMatch[1];
      if (!this.activeSessionId) {
        const state = asState(await this.options.rpc.send({ type: "get_state" }));
        this.running = state.isStreaming;
        this.activeSessionId = state.sessionFile ? idForPath(state.sessionFile) : state.sessionId || "";
        this.activeSessionPath = state.sessionFile;
      }
      if (id !== this.activeSessionId) await this.ensureRuntime(id);
      const view = await this.sessionView(id, RECENT_TURN_WINDOW_SIZE, clientId);
      if (!view) return json(response, 404, { error: "会话不存在" });
      json(response, 200, view);
      return;
    }

    if (url.pathname === "/api/sessions/new") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const runtime = await this.createDraftRuntime();
      const view = await this.sessionView(runtime.id, RECENT_TURN_WINDOW_SIZE, clientId);
      if (!view) throw new Error("新会话创建后无法读取");
      json(response, 200, view);
      return;
    }

    const customModelMatch = /^\/api\/models\/([A-Za-z0-9._-]{1,80})\/([^/]{1,200})$/.exec(url.pathname);
    if (customModelMatch) {
      if (!this.options.modelManager) return json(response, 501, { error: "模型管理不可用" });
      const provider = decodeURIComponent(customModelMatch[1]);
      const modelId = decodeURIComponent(customModelMatch[2]);
      if (request.method === "GET") {
        json(response, 200, { model: await this.options.modelManager.getCustomConfig(provider, modelId) });
        return;
      }
      if (request.method === "PUT") {
        const result = await this.withLifecycle("resources-reloading", "更新模型配置", async () => {
          const body = await bodyJson(request);
          const state = asState(await this.options.rpc.send({ type: "get_state" }));
          const wasActive = state.model?.provider === provider && state.model?.id === modelId;
          const snapshot = await snapshotFile(this.options.modelManager!.path);
          const updated = await this.applyResourceFileTransaction([snapshot], () => this.options.modelManager!.update(provider, modelId, body));
          // A rename invalidates the session's model reference; reselect the new
          // key so the UI never points at a model that no longer exists.
          if (wasActive && (updated.provider !== provider || updated.id !== modelId)) {
            try {
              await this.options.rpc.send({ type: "set_model", provider: updated.provider, modelId: updated.id });
            } catch {
              // The renamed model may be unreachable (auth/network); the user can
              // reselect it from the refreshed model list.
            }
          }
          return this.bootstrap();
        });
        json(response, 200, result);
        return;
      }
      return methodNotAllowed(response);
    }

    if (url.pathname === "/api/models") {
      if (!this.options.modelManager) return json(response, 501, { error: "模型管理不可用" });
      if (request.method !== "POST" && request.method !== "DELETE") return methodNotAllowed(response);
      const result = await this.withLifecycle("resources-reloading", "更新模型配置", async () => {
        const body = await bodyJson(request);
        const snapshot = await snapshotFile(this.options.modelManager!.path);
        if (request.method === "POST") {
          await this.applyResourceFileTransaction([snapshot], () => this.options.modelManager!.add(body));
        } else {
          const state = asState(await this.options.rpc.send({ type: "get_state" }));
          if (state.model?.provider === body.provider && state.model?.id === body.modelId) throw new Error("请先切换到其他模型，再删除当前模型");
          await this.applyResourceFileTransaction([snapshot], () => this.options.modelManager!.remove(body.provider, body.modelId));
        }
        return this.bootstrap();
      });
      json(response, 200, result);
      return;
    }

    if (url.pathname === "/api/models/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const provider = typeof body.provider === "string" ? body.provider : "";
      const modelId = typeof body.modelId === "string" ? body.modelId : "";
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      // Model selection does not claim control, but an observing window must not
      // silently overwrite settings owned by another active controller.
      this.assertNoForeignController(sessionId, clientId);
      const secondaryRuntime = this.runtimes.get(sessionId) || null;
      if (!provider || !modelId) return json(response, 400, { error: "provider 和 modelId 必填" });
      if (!secondaryRuntime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未启用" });
      if (secondaryRuntime) {
        this.touchRuntime(secondaryRuntime);
        if (secondaryRuntime.failed || secondaryRuntime.rpc.isRunning?.() === false) await this.recoverRuntime(secondaryRuntime);
      } else {
        await this.ensurePrimaryRuntime();
      }
      const targetRpc = secondaryRuntime?.rpc || this.options.rpc;
      const targetRunning = secondaryRuntime?.running || (!secondaryRuntime && this.running);
      if (targetRunning) {
        const model = asModels(await targetRpc.send({ type: "get_available_models" })).find((item) => item.provider === provider && item.id === modelId);
        if (!model) return json(response, 404, { error: "所选模型不可用" });
        (secondaryRuntime?.pendingTurnSettings || this.pendingTurnSettings).model = { provider, modelId };
        json(response, 200, { model, pending: true });
        return;
      }
      const model = rpcData<ModelInfo>(await targetRpc.send({ type: "set_model", provider, modelId }));
      json(response, 200, { model, pending: false });
      return;
    }

    if (url.pathname === "/api/thinking/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const allowed: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      const level = typeof body.level === "string" && allowed.includes(body.level as ThinkingLevel) ? body.level as ThinkingLevel : null;
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      // Thinking level does not claim control, but an observing window must not
      // silently overwrite settings owned by another active controller.
      this.assertNoForeignController(sessionId, clientId);
      const secondaryRuntime = this.runtimes.get(sessionId) || null;
      if (!level) return json(response, 400, { error: "无效的 Thinking 强度" });
      if (!secondaryRuntime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未启用" });
      if (secondaryRuntime) {
        this.touchRuntime(secondaryRuntime);
        if (secondaryRuntime.failed || secondaryRuntime.rpc.isRunning?.() === false) await this.recoverRuntime(secondaryRuntime);
      } else {
        await this.ensurePrimaryRuntime();
      }
      const targetRpc = secondaryRuntime?.rpc || this.options.rpc;
      const targetRunning = secondaryRuntime?.running || (!secondaryRuntime && this.running);
      if (targetRunning) {
        (secondaryRuntime?.pendingTurnSettings || this.pendingTurnSettings).thinkingLevel = level;
        json(response, 200, { level, pending: true });
        return;
      }
      await targetRpc.send({ type: "set_thinking_level", level });
      const state = asState(await targetRpc.send({ type: "get_state" }));
      json(response, 200, { level: state.thinkingLevel, pending: false });
      return;
    }

    if (url.pathname === "/api/resources/skills") {
      if (request.method === "GET") return json(response, 200, await this.options.resources.listSkills(this.currentCwd));
      if (!["POST", "PATCH", "DELETE"].includes(request.method || "")) return methodNotAllowed(response);
      const result = await this.withLifecycle("resources-reloading", "更新 Skills", async () => {
        const body = await bodyJson(request);
        if (request.method === "POST") {
          const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
          if (!sourcePath) throw new Error("sourcePath 必填");
          await this.options.resources.installSkill(sourcePath);
        } else if (request.method === "PATCH") {
          if (typeof body.id !== "string" || typeof body.enabled !== "boolean") throw new Error("id 和 enabled 必填");
          const snapshot = await this.options.resources.snapshotSkill(body.id, this.currentCwd);
          await this.applyResourceFileTransaction([snapshot], () => this.options.resources.setSkillEnabled(body.id as string, body.enabled as boolean, this.currentCwd));
        } else {
          if (typeof body.id !== "string") throw new Error("id 必填");
          await this.options.resources.removeSkill(body.id, this.currentCwd);
        }
        if (request.method !== "PATCH") await this.reloadRpc();
        return this.options.resources.listSkills(this.currentCwd);
      });
      json(response, 200, { ...result, reloaded: true });
      return;
    }

    if (url.pathname === "/api/resources/extensions") {
      if (request.method === "GET") return json(response, 200, await this.options.resources.listExtensions(this.currentCwd));
      if (request.method !== "PATCH" && request.method !== "DELETE") return methodNotAllowed(response);
      const result = await this.withLifecycle("resources-reloading", "更新 Extensions", async () => {
        const body = await bodyJson(request);
        if (request.method === "PATCH") {
          if (typeof body.id !== "string" || typeof body.enabled !== "boolean") throw new Error("id 和 enabled 必填");
          const snapshot = await this.options.resources.snapshotSettings();
          await this.applyResourceFileTransaction([snapshot], () => this.options.resources.setExtensionEnabled(body.id as string, body.enabled as boolean, this.currentCwd));
        } else {
          if (typeof body.id !== "string") throw new Error("id 必填");
          await this.options.resources.removeExtension(body.id, this.currentCwd);
        }
        if (request.method !== "PATCH") await this.reloadRpc();
        return this.options.resources.listExtensions(this.currentCwd);
      });
      json(response, 200, { ...result, reloaded: true });
      return;
    }

    if (url.pathname === "/api/resources/packages") {
      if (request.method === "GET") return json(response, 200, await this.options.resources.listPackages(this.currentCwd));
      if (!["POST", "PATCH", "DELETE"].includes(request.method || "")) return methodNotAllowed(response);
      const result = await this.withLifecycle("resources-reloading", "更新 Packages", async () => {
        const body = await bodyJson(request);
        if (request.method === "POST") {
          const source = typeof body.source === "string" ? body.source.trim() : "";
          if (!source) throw new Error("source 必填");
          await this.options.resources.installPackage(source);
        } else if (request.method === "PATCH") {
          if (typeof body.id !== "string" || typeof body.enabled !== "boolean") throw new Error("id 和 enabled 必填");
          const snapshot = await this.options.resources.snapshotSettings();
          await this.applyResourceFileTransaction([snapshot], () => this.options.resources.setPackageEnabled(body.id as string, body.enabled as boolean, this.currentCwd));
        } else {
          if (typeof body.id !== "string") throw new Error("id 必填");
          await this.options.resources.removePackage(body.id, this.currentCwd);
        }
        if (request.method !== "PATCH") await this.reloadRpc();
        return this.options.resources.listPackages(this.currentCwd);
      });
      json(response, 200, { ...result, reloaded: true });
      return;
    }

    if (url.pathname === "/api/extension-ui/respond") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      if (typeof body.id !== "string") return json(response, 400, { error: "id 必填" });
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      this.requireSessionControl(sessionId, clientId);
      const runtime = this.runtimes.get(sessionId);
      const targetRpc = runtime?.rpc || (sessionId === this.activeSessionId ? this.options.rpc : null);
      if (!targetRpc) return json(response, 409, { error: "Extension 对应的会话已经关闭" });
      // Claim the request synchronously before forwarding it. A second browser tab
      // cannot turn an already accepted Allow into Block (or the reverse).
      if (!this.clearPendingRequest(sessionId, body.id)) return json(response, 409, { error: "该确认已在另一窗口处理，或已失效" });
      if (runtime) this.touchRuntime(runtime);
      const command: Record<string, unknown> = { type: "extension_ui_response", id: body.id };
      if (body.cancelled === true) command.cancelled = true;
      else if (typeof body.confirmed === "boolean") command.confirmed = body.confirmed;
      else if (typeof body.value === "string") command.value = body.value;
      else command.cancelled = true;
      targetRpc.sendRaw(command);
      json(response, 200, { ok: true });
      return;
    }

    json(response, 404, { error: "API not found" });
  }

  private async serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    const root = resolve(this.options.webRoot);
    const requestPath = pathname === "/" ? "index.html" : normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
    let filePath = resolve(root, requestPath);
    if (!filePath.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`) && filePath !== root) {
      return json(response, 403, { error: "Forbidden" });
    }
    if (!existsSync(filePath) || !(await stat(filePath)).isFile()) filePath = join(root, "index.html");
    if (!existsSync(filePath)) return json(response, 404, { error: "前端尚未构建，请先运行 npm run build" });
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      "cache-control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    createReadStream(filePath).pipe(response);
  }
}
