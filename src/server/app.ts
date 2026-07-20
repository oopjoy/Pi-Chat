import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, normalize, resolve } from "node:path";
import type { BootstrapData, ModelInfo, PiMessage, PiState, PromptImage, QueuedPrompt, SessionStats, SessionViewData, SlashCommand, ThinkingLevel, TodoItem } from "../shared/types.js";
import { pickLocalFiles, pickWorkspaceFolder, readClipboardFiles } from "./file-picker.js";
import { ModelManager } from "./model-manager.js";
import { ResourceManager } from "./resource-manager.js";
import { PiRpcClient, rpcData } from "./rpc-client.js";
import { idForPath, readSessionTodos, SessionIndex } from "./session-index.js";
import { saveWorkspace } from "./workspace-state.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
export const RECENT_TURN_WINDOW_SIZE = 20;
const DEFAULT_SECONDARY_RUNTIME_IDLE_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_IDLE_SECONDARY_RUNTIMES = 3;
const DEFAULT_SECONDARY_RUNTIME_SWEEP_MS = 60 * 1_000;
export const DEFAULT_RECENT_SESSION_PREHEAT_COUNT = 3;
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "new", description: "新建会话", source: "builtin" },
  { name: "compact", description: "压缩当前会话上下文，可附加指令", source: "builtin" },
  { name: "abort", description: "停止当前生成", source: "builtin" },
];
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

function methodNotAllowed(response: ServerResponse): void {
  json(response, 405, { error: "Method not allowed" });
}

async function bodyJson(request: IncomingMessage, maximumBytes = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error(`请求内容超过 ${Math.round(maximumBytes / 1_000_000)} MB`);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求必须是 JSON 对象");
  return value as Record<string, unknown>;
}

export function promptImages(value: unknown): PromptImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new Error("一次最多发送 4 张图片");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("图片数据无效");
    const image = entry as Record<string, unknown>;
    const mimeType = typeof image.mimeType === "string" ? image.mimeType.toLowerCase() : "";
    const data = typeof image.data === "string" ? image.data : "";
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) throw new Error("仅支持 PNG、JPEG、WebP 和 GIF 图片");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("图片 Base64 数据无效");
    const approximateBytes = Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (approximateBytes <= 0 || approximateBytes > 8 * 1024 * 1024) throw new Error("单张图片必须小于 8 MB");
    return { type: "image", data, mimeType };
  });
}

function asState(response: Record<string, unknown>): PiState {
  return rpcData<PiState>(response);
}

function asMessages(response: Record<string, unknown>): PiMessage[] {
  return rpcData<{ messages: PiMessage[] }>(response).messages;
}

/**
 * A conversation turn starts at a user message and includes every following Pi
 * message/tool result up to the next user message. Keep the newest twenty user
 * initiated turns, rather than an arbitrary number of raw Pi message entries.
 */
export function messageWindow(messages: PiMessage[]): { messages: PiMessage[]; total: number; turns: number; truncated: boolean } {
  const total = messages.length;
  const userStarts = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  const turns = userStarts.length;
  const start = turns > RECENT_TURN_WINDOW_SIZE ? userStarts.at(-RECENT_TURN_WINDOW_SIZE) || 0 : 0;
  return { messages: start ? messages.slice(start) : messages, total, turns, truncated: start > 0 };
}

function asModels(response: Record<string, unknown>): ModelInfo[] {
  return rpcData<{ models: ModelInfo[] }>(response).models;
}

function asCommands(response: Record<string, unknown>): SlashCommand[] {
  return rpcData<{ commands: SlashCommand[] }>(response).commands;
}

function asSessionStats(response: Record<string, unknown>): SessionStats {
  return rpcData<SessionStats>(response);
}

interface InternalQueuedPrompt extends QueuedPrompt {
  images: PromptImage[];
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
  now?: () => number;
}

export class PiChatApp {
  private readonly sseClients = new Set<ServerResponse>();
  private readonly unsubscribe: () => void;
  private readonly promptQueue: InternalQueuedPrompt[] = [];
  private running = false;
  private queuePaused = false;
  private dispatching = false;
  private closed = false;
  private currentCwd: string;
  private activeSessionId = "";
  private activeSessionPath: string | undefined;
  private readonly runtimes = new Map<string, SecondaryRuntime>();
  private readonly runtimeStarts = new Map<string, Promise<SecondaryRuntime>>();
  private readonly runtimeStops = new Map<string, Promise<void>>();
  private preheatPromise: Promise<string[]> | null = null;
  private readonly now: () => number;
  private readonly secondaryRuntimeIdleMs: number;
  private readonly maxIdleSecondaryRuntimes: number;
  private readonly secondaryRuntimeSweepTimer: NodeJS.Timeout;
  private liveMessage: PiMessage | undefined;
  private toolStatus = "";

  constructor(private readonly options: PiChatAppOptions) {
    this.currentCwd = resolve(options.cwd);
    this.now = options.now || Date.now;
    this.secondaryRuntimeIdleMs = Math.max(0, options.secondaryRuntimeIdleMs ?? DEFAULT_SECONDARY_RUNTIME_IDLE_MS);
    this.maxIdleSecondaryRuntimes = Math.max(0, Math.floor(options.maxIdleSecondaryRuntimes ?? DEFAULT_MAX_IDLE_SECONDARY_RUNTIMES));
    const sweepMs = Math.max(100, options.secondaryRuntimeSweepMs ?? DEFAULT_SECONDARY_RUNTIME_SWEEP_MS);
    this.secondaryRuntimeSweepTimer = setInterval(() => void this.sweepSecondaryRuntimes(), sweepMs);
    this.secondaryRuntimeSweepTimer.unref();
    this.unsubscribe = options.rpc.onEvent((event) => this.handleRpcEvent(event));
  }

  /**
   * Sequentially starts the most recently updated saved Sessions in the background.
   * The primary Session is deliberately excluded; `ensureRuntime` deduplicates an
   * overlapping user click so preheating never creates two writers for one JSONL.
   */
  async preheatRecentSessions(limit = DEFAULT_RECENT_SESSION_PREHEAT_COUNT): Promise<string[]> {
    const count = Math.min(Math.max(0, Math.floor(limit)), this.maxIdleSecondaryRuntimes);
    if (!count || this.closed || !this.options.createRpc) return [];
    if (this.preheatPromise) return this.preheatPromise;
    const run = (async () => {
      const state = asState(await this.options.rpc.send({ type: "get_state" }));
      this.running = state.isStreaming;
      this.activeSessionId = state.sessionFile ? idForPath(state.sessionFile) : state.sessionId || "";
      this.activeSessionPath = state.sessionFile;
      const recent = await this.options.sessions.list(state.sessionFile, this.currentCwd);
      const started: string[] = [];
      for (const session of recent) {
        if (this.closed || started.length >= count) break;
        if (session.id === this.activeSessionId) continue;
        try {
          await this.ensureRuntime(session.id);
          started.push(session.id);
        } catch (error) {
          // A deleted/corrupt historical Session must not prevent newer candidates
          // from warming. It remains available for an explicit user retry later.
          this.broadcast({ type: "pi_chat_preheat_error", sessionId: session.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return started;
    })();
    this.preheatPromise = run;
    try {
      return await run;
    } finally {
      if (this.preheatPromise === run) this.preheatPromise = null;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.secondaryRuntimeSweepTimer);
    this.unsubscribe();
    await Promise.allSettled(this.runtimeStarts.values());
    for (const runtime of this.runtimes.values()) {
      runtime.unsubscribe();
      await runtime.rpc.stop();
    }
    this.runtimes.clear();
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
  }

  private broadcast(event: Record<string, unknown>): void {
    const frame = `event: pi\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) client.write(frame);
  }

  private publicQueue(queue = this.promptQueue): QueuedPrompt[] {
    return queue.map(({ id, message, imageCount, createdAt }) => ({ id, message, imageCount, createdAt }));
  }

  private broadcastQueue(sessionId = this.activeSessionId): void {
    const runtime = this.runtimes.get(sessionId);
    this.broadcast({ type: "pi_chat_queue_update", queue: this.publicQueue(runtime?.promptQueue || this.promptQueue), paused: runtime?.queuePaused ?? this.queuePaused, piChatSessionId: sessionId });
  }

  private activeSessionIds(): string[] {
    return [this.activeSessionId, ...this.runtimes.keys()].filter((id): id is string => Boolean(id));
  }

  private touchRuntime(runtime: SecondaryRuntime): void {
    runtime.lastUsedAt = this.now();
  }

  private canReclaimRuntime(runtime: SecondaryRuntime): boolean {
    return !runtime.running && !runtime.dispatching && !runtime.queuePaused && runtime.promptQueue.length === 0 && !runtime.extensionUiPending;
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
    this.broadcast({ type: "pi_chat_active_session_changed", sessionId: id, activeSessionIds: this.activeSessionIds(), reclaimed: true, reason });
    return true;
  }

  private async makeRoomForSecondaryRuntime(): Promise<void> {
    const idle = [...this.runtimes.values()].filter((runtime) => this.canReclaimRuntime(runtime)).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const excess = Math.max(0, idle.length - this.maxIdleSecondaryRuntimes + 1);
    for (const runtime of idle.slice(0, excess)) await this.reclaimRuntime(runtime.id, "capacity");
  }

  private async sweepSecondaryRuntimes(): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    const idle = [...this.runtimes.values()].filter((runtime) => this.canReclaimRuntime(runtime)).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const expired = idle.filter((runtime) => now - runtime.lastUsedAt >= this.secondaryRuntimeIdleMs);
    const reclaim = new Map<string, "idle" | "capacity">(expired.map((runtime) => [runtime.id, "idle"]));
    const retainedIdle = idle.filter((runtime) => !reclaim.has(runtime.id));
    const excess = Math.max(0, retainedIdle.length - this.maxIdleSecondaryRuntimes);
    for (const runtime of retainedIdle.slice(0, excess)) reclaim.set(runtime.id, "capacity");
    for (const [id, reason] of reclaim) await this.reclaimRuntime(id, reason);
  }

  private async todosForSession(sessionId: string, primaryPath?: string): Promise<TodoItem[]> {
    const path = sessionId === this.activeSessionId ? primaryPath || this.activeSessionPath : this.options.sessions.pathForId(sessionId);
    return path ? readSessionTodos(path).catch(() => []) : [];
  }

  private scheduleTodoSync(sessionId: string, primaryPath?: string): void {
    setTimeout(() => void this.todosForSession(sessionId, primaryPath).then((todos) => {
      this.broadcast({ type: "pi_chat_todos_update", todos, piChatSessionId: sessionId });
    }), 80);
  }

  private handleSecondaryEvent(runtime: SecondaryRuntime, event: Record<string, unknown>): void {
    const type = String(event.type || "");
    this.touchRuntime(runtime);
    if (type === "agent_start") {
      runtime.running = true;
      runtime.toolStatus = "Pi 正在思考…";
    }
    if ((type === "message_start" || type === "message_update") && event.message && typeof event.message === "object" && (event.message as PiMessage).role === "assistant") {
      runtime.liveMessage = event.message as PiMessage;
    }
    if (type === "message_end" && event.message && typeof event.message === "object" && (event.message as PiMessage).role === "assistant") runtime.liveMessage = undefined;
    if (type === "tool_execution_start") runtime.toolStatus = `正在运行工具：${String(event.toolName || "unknown")}`;
    if (type === "tool_execution_end") runtime.toolStatus = `${String(event.toolName || "工具")} ${event.isError ? "执行失败" : "已完成"}`;
    if (type === "extension_ui_request") {
      const method = String(event.method || "");
      runtime.extensionUiPending = ["select", "confirm", "input", "editor"].includes(method);
    }
    if (type === "extension_error") runtime.extensionUiPending = false;
    if (type === "pi_chat_process_error") {
      runtime.running = false;
      runtime.dispatching = false;
      runtime.extensionUiPending = false;
    }
    this.broadcast({ ...event, piChatSessionId: runtime.id });
    if (type === "tool_execution_end" && event.toolName === "todo") this.scheduleTodoSync(runtime.id);
    if (type === "agent_start" || type === "message_start") this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: runtime.id });
    if (type === "agent_settled") {
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
      return existing;
    }
    const starting = this.runtimeStarts.get(id);
    if (starting) return starting;
    if (!this.options.createRpc) throw new Error("当前服务未启用多会话运行");
    const start = (async () => {
      await this.options.sessions.list(undefined, this.currentCwd);
      const path = this.options.sessions.pathForId(id);
      if (!path) throw new Error("会话不存在");
      await this.makeRoomForSecondaryRuntime();
      const rpc = this.options.createRpc!(this.currentCwd);
      const runtime: SecondaryRuntime = { id, rpc, running: false, queuePaused: false, dispatching: false, promptQueue: [], toolStatus: "", extensionUiPending: false, lastUsedAt: this.now(), unsubscribe: () => {} };
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
    })();
    this.runtimeStarts.set(id, start);
    try {
      return await start;
    } finally {
      if (this.runtimeStarts.get(id) === start) this.runtimeStarts.delete(id);
    }
  }

  private handleRpcEvent(event: Record<string, unknown>): void {
    const type = String(event.type || "");
    if (type === "agent_start") {
      this.running = true;
      this.toolStatus = "Pi 正在思考…";
    }
    if ((type === "message_start" || type === "message_update") && event.message && typeof event.message === "object" && (event.message as PiMessage).role === "assistant") {
      this.liveMessage = event.message as PiMessage;
    }
    if (type === "message_end" && event.message && typeof event.message === "object" && (event.message as PiMessage).role === "assistant") {
      this.liveMessage = undefined;
    }
    if (type === "tool_execution_start") this.toolStatus = `正在运行工具：${String(event.toolName || "unknown")}`;
    if (type === "tool_execution_end") this.toolStatus = `${String(event.toolName || "工具")} ${event.isError ? "执行失败" : "已完成"}`;
    const taggedEvent = { ...event, piChatSessionId: this.activeSessionId };
    if (type === "tool_execution_end" && event.toolName === "todo") this.scheduleTodoSync(this.activeSessionId);
    this.broadcast(taggedEvent);
    if (type === "agent_start" || type === "message_start") this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: this.activeSessionId });
    if (type === "agent_settled") {
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

  private async extensionCommand(message: string, rpc = this.options.rpc): Promise<SlashCommand | null> {
    const match = /^\/([^\s/]+)/.exec(message);
    if (!match) return null;
    const response = await rpc.send({ type: "get_commands" });
    const command = asCommands(response).find((item) => item.name === match[1]);
    return command?.source === "extension" ? command : null;
  }

  private async sendPrompt(message: string, images: PromptImage[]): Promise<void> {
    this.running = true;
    try {
      await this.options.rpc.send({ type: "prompt", message: message || "请查看这些图片。", ...(images.length ? { images } : {}) });
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
    if (this.closed || runtime.running || runtime.dispatching || runtime.queuePaused || !runtime.promptQueue.length) return;
    const next = runtime.promptQueue.shift();
    if (!next) return;
    runtime.dispatching = true;
    this.broadcastQueue(runtime.id);
    this.broadcast({ type: "pi_chat_queue_dispatch", id: next.id, message: next.message, imageCount: next.imageCount, piChatSessionId: runtime.id });
    try {
      runtime.running = true;
      await runtime.rpc.send({ type: "prompt", message: next.message || "请查看这些图片。", ...(next.images.length ? { images: next.images } : {}) });
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
    if (this.closed || this.running || this.dispatching || this.queuePaused || !this.promptQueue.length) return;
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

  private withActiveSession(sessions: BootstrapData["sessions"], _state: PiState): BootstrapData["sessions"] {
    // The active Pi process can have an empty, not-yet-persisted draft Session. It belongs
    // in the main composer only; the sidebar deliberately contains saved conversations only.
    return sessions.map((session) => ({
      ...session,
      writable: this.activeSessionIds().includes(session.id),
      running: (this.running && session.id === this.activeSessionId) || this.runtimes.get(session.id)?.running === true,
    }));
  }

  private async reloadRpc(): Promise<void> {
    if (this.promptQueue.length) throw new Error("请先清空消息队列，再修改资源配置");
    await Promise.allSettled(this.runtimeStarts.values());
    const state = asState(await this.options.rpc.send({ type: "get_state" }));
    if (state.isStreaming || [...this.runtimes.values()].some((runtime) => runtime.running)) throw new Error("请先停止所有并行生成，再修改资源配置");
    for (const runtime of this.runtimes.values()) {
      runtime.unsubscribe();
      await runtime.rpc.stop();
    }
    this.runtimes.clear();
    await this.options.rpc.restart(state.sessionFile);
    this.broadcast({ type: "pi_chat_reloaded" });
  }

  private async changeWorkspace(selected: string): Promise<{ workspaceName: string; data: BootstrapData }> {
    await Promise.allSettled(this.runtimeStarts.values());
    if ([...this.runtimes.values()].some((runtime) => runtime.running)) throw new Error("请先停止所有并行会话，再切换工作目录");
    for (const runtime of this.runtimes.values()) {
      runtime.unsubscribe();
      await runtime.rpc.stop();
    }
    this.runtimes.clear();
    const selectedCwd = resolve(selected);
    if (!(await stat(selectedCwd)).isDirectory()) throw new Error("所选工作目录不存在或不是文件夹");
    if (selectedCwd.toLowerCase() !== this.currentCwd.toLowerCase()) {
      await this.options.rpc.restart(undefined, selectedCwd);
      this.currentCwd = selectedCwd;
      this.broadcast({ type: "pi_chat_workspace_changed", cwd: selectedCwd });
    }
    await saveWorkspace(selectedCwd);
    return { workspaceName: basename(selectedCwd), data: await this.bootstrap() };
  }

  private async renameSession(id: string, name: string): Promise<BootstrapData> {
    await this.options.sessions.list(undefined, this.currentCwd);
    const isPrimary = id === this.activeSessionId;
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
    const path = isPrimary ? state?.sessionFile : this.options.sessions.pathForId(id);
    if (!isPrimary && !path) throw new Error("会话不存在");
    if (isPrimary) {
      if (this.running || this.promptQueue.length) throw new Error("请先停止当前生成并清空队列，再删除此会话");
      const result = rpcData<{ cancelled: boolean }>(await this.options.rpc.send({ type: "new_session" }));
      if (result.cancelled) throw new Error("扩展取消了新建会话，无法删除当前会话");
      await this.bootstrap();
    } else {
      const runtime = this.runtimes.get(id);
      if (runtime?.running) throw new Error("请先停止该会话的生成，再删除对话");
      if (runtime) {
        runtime.unsubscribe();
        await runtime.rpc.stop();
        this.runtimes.delete(id);
      }
    }
    if (path && existsSync(path)) await unlink(path);
    this.broadcast({ type: "pi_chat_sessions_changed", action: "deleted", sessionId: id });
    return this.bootstrap();
  }

  private async sessionView(id: string): Promise<SessionViewData | null> {
    const state = asState(await this.options.rpc.send({ type: "get_state" }));
    this.running = state.isStreaming;
    this.activeSessionId = state.sessionFile ? idForPath(state.sessionFile) : state.sessionId || "";
    this.activeSessionPath = state.sessionFile;
    const sessions = this.withActiveSession(await this.options.sessions.list(state.sessionFile, this.currentCwd), state);
    const session = sessions.find((item) => item.id === id);
    if (!session) return null;
    const runtime = id === this.activeSessionId
      ? { rpc: this.options.rpc, running: this.running, liveMessage: this.liveMessage, toolStatus: this.toolStatus }
      : this.runtimes.get(id) || null;
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
      const windowed = messageWindow(messages);
      return {
        session,
        state: asState(stateResponse),
        messages: windowed.messages,
        messageTotal: windowed.total,
        turnTotal: windowed.turns,
        messagesTruncated: windowed.truncated,
        isActive: true,
        isStreaming: runtime.running,
        liveMessage: runtime.liveMessage,
        toolStatus: runtime.toolStatus,
        stats: asSessionStats(statsResponse),
        queue: id === this.activeSessionId ? this.publicQueue() : this.publicQueue((runtime as SecondaryRuntime).promptQueue),
        queuePaused: id === this.activeSessionId ? this.queuePaused : (runtime as SecondaryRuntime).queuePaused,
        todos: await this.todosForSession(id, asState(stateResponse).sessionFile),
        commands: commandsResponse ? [...BUILTIN_COMMANDS, ...asCommands(commandsResponse)] : undefined,
      };
    }
    const messages = await this.options.sessions.messagesForId(id);
    if (!messages) return null;
    const windowed = messageWindow(messages);
    return {
      session,
      state: { ...state, isStreaming: false },
      messages: windowed.messages,
      messageTotal: windowed.total,
      turnTotal: windowed.turns,
      messagesTruncated: windowed.truncated,
      isActive: false,
      isStreaming: false,
      todos: await this.todosForSession(id),
      commands: [],
    };
  }

  private async bootstrap(): Promise<BootstrapData> {
    const [stateResponse, messagesResponse, modelsResponse, commandsResponse, statsResponse] = await Promise.all([
      this.options.rpc.send({ type: "get_state" }),
      this.options.rpc.send({ type: "get_messages" }),
      this.options.rpc.send({ type: "get_available_models" }),
      this.options.rpc.send({ type: "get_commands" }),
      this.options.rpc.send({ type: "get_session_stats" }),
    ]);
    const state = asState(stateResponse);
    const windowedMessages = messageWindow(asMessages(messagesResponse));
    this.running = state.isStreaming;
    this.activeSessionId = state.sessionFile ? idForPath(state.sessionFile) : state.sessionId || "";
    this.activeSessionPath = state.sessionFile;
    const sessions = this.withActiveSession(await this.options.sessions.list(state.sessionFile, this.currentCwd), state);
    return {
      state,
      messages: windowedMessages.messages,
      messageTotal: windowedMessages.total,
      turnTotal: windowedMessages.turns,
      messagesTruncated: windowedMessages.truncated,
      activeSessionId: this.activeSessionId,
      activeSessionIds: this.activeSessionIds(),
      liveMessage: this.liveMessage,
      toolStatus: this.toolStatus,
      stats: asSessionStats(statsResponse),
      models: this.options.modelManager ? await this.options.modelManager.annotate(asModels(modelsResponse)) : asModels(modelsResponse),
      commands: [...BUILTIN_COMMANDS, ...asCommands(commandsResponse)],
      queue: this.publicQueue(),
      queuePaused: this.queuePaused,
      todos: await this.todosForSession(this.activeSessionId, state.sessionFile),
      workspaceCwd: this.currentCwd,
      sessions,
    };
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
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
      if (response.headersSent) {
        response.end();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      json(response, 500, { error: message });
    }
  }

  private async handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") return methodNotAllowed(response);
      json(response, 200, { ok: true });
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
      response.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      this.sseClients.add(response);
      const timer = setInterval(() => response.write(": ping\n\n"), 20_000);
      request.once("close", () => {
        clearInterval(timer);
        this.sseClients.delete(response);
      });
      return;
    }

    if (url.pathname === "/api/bootstrap") {
      if (request.method !== "GET") return methodNotAllowed(response);
      json(response, 200, await this.bootstrap());
      return;
    }

    if (url.pathname === "/api/restart") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (this.running || this.promptQueue.length || [...this.runtimes.values()].some((runtime) => runtime.running || runtime.promptQueue.length || runtime.extensionUiPending)) {
        return json(response, 409, { error: "请先停止所有生成、处理权限确认并清空队列，再重启 Pi" });
      }
      await this.reloadRpc();
      json(response, 200, await this.bootstrap());
      return;
    }

    if (url.pathname === "/api/chat/prompt") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request, 45_000_000);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const images = promptImages(body.images);
      if (!message && !images.length) return json(response, 400, { error: "消息或图片不能为空" });
      // A browser tab can outlive a Pi Chat restart. Restore its requested Session on demand
      // instead of rejecting the prompt because the old in-memory worker map was lost.
      if (requestedSessionId && !this.activeSessionIds().includes(requestedSessionId)) await this.ensureRuntime(requestedSessionId);
      const secondaryRuntime = requestedSessionId ? this.runtimes.get(requestedSessionId) || null : null;
      if (secondaryRuntime) this.touchRuntime(secondaryRuntime);
      const targetRpc = secondaryRuntime?.rpc || this.options.rpc;
      const extensionCommand = message ? await this.extensionCommand(message, targetRpc) : null;
      if (extensionCommand) {
        if (images.length) return json(response, 400, { error: "Extension 指令不能同时附加图片" });
        await targetRpc.send({ type: "prompt", message });
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
        secondaryRuntime.running = true;
        try {
          await secondaryRuntime.rpc.send({ type: "prompt", message: message || "请查看这些图片。", ...(images.length ? { images } : {}) });
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
      const runtime = this.runtimes.get(sessionId);
      if (!runtime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未恢复运行，请刷新页面后重试" });
      if (runtime) {
        this.touchRuntime(runtime);
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
      if (this.running || this.promptQueue.length || [...this.runtimes.values()].some((runtime) => runtime.running)) return json(response, 409, { error: "请先停止所有并行生成并清空队列" });
      const selected = await pickWorkspaceFolder(this.currentCwd);
      if (!selected) return json(response, 200, { cancelled: true });
      json(response, 200, { cancelled: false, ...await this.changeWorkspace(selected) });
      return;
    }

    if (url.pathname === "/api/workspace/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (this.running || this.promptQueue.length || [...this.runtimes.values()].some((runtime) => runtime.running)) return json(response, 409, { error: "请先停止所有并行生成并清空队列" });
      const body = await bodyJson(request);
      const selected = typeof body.path === "string" ? body.path.trim() : "";
      if (!selected) return json(response, 400, { error: "path 必填" });
      json(response, 200, { cancelled: false, ...await this.changeWorkspace(selected) });
      return;
    }

    if (url.pathname === "/api/chat/compact") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      const secondaryRuntime = this.runtimes.get(sessionId) || null;
      if ((!secondaryRuntime && (this.running || this.promptQueue.length)) || secondaryRuntime?.running) return json(response, 409, { error: "请先停止该会话的生成并清空队列" });
      if (!secondaryRuntime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未启用" });
      const customInstructions = typeof body.customInstructions === "string" ? body.customInstructions.trim() : "";
      const result = rpcData<Record<string, unknown>>(await (secondaryRuntime?.rpc || this.options.rpc).send({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }, 180_000));
      json(response, 200, { result });
      return;
    }

    if (url.pathname === "/api/chat/abort") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      const runtime = this.runtimes.get(sessionId);
      if (runtime) {
        this.touchRuntime(runtime);
        if (runtime.promptQueue.length) runtime.queuePaused = true;
        await runtime.rpc.send({ type: "abort" }, 10_000);
        const state = asState(await runtime.rpc.send({ type: "get_state" }));
        runtime.running = state.isStreaming;
        this.broadcastQueue(sessionId);
        return json(response, 200, { ok: true, isStreaming: state.isStreaming, queuePaused: runtime.queuePaused });
      }
      if (sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话不是活动运行会话" });
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
      const state = asState(await this.options.rpc.send({ type: "get_state" }));
      const sessions = this.withActiveSession(await this.options.sessions.list(state.sessionFile, this.currentCwd), state);
      json(response, 200, { sessions });
      return;
    }

    const manageSessionMatch = /^\/api\/sessions\/([a-f0-9]{20})$/.exec(url.pathname);
    if (manageSessionMatch) {
      if (request.method === "PATCH") {
        const body = await bodyJson(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) return json(response, 400, { error: "名称必须为 1 到 120 个有效字符" });
        json(response, 200, await this.renameSession(manageSessionMatch[1], name));
        return;
      }
      if (request.method === "DELETE") {
        json(response, 200, await this.deleteSession(manageSessionMatch[1]));
        return;
      }
      return methodNotAllowed(response);
    }

    const viewMatch = /^\/api\/sessions\/([a-f0-9]{20})\/view$/.exec(url.pathname);
    if (viewMatch) {
      if (request.method !== "GET") return methodNotAllowed(response);
      if (!this.activeSessionId) {
        const state = asState(await this.options.rpc.send({ type: "get_state" }));
        this.running = state.isStreaming;
        this.activeSessionId = state.sessionFile ? idForPath(state.sessionFile) : state.sessionId || "";
      }
      if (viewMatch[1] !== this.activeSessionId) await this.ensureRuntime(viewMatch[1]);
      const view = await this.sessionView(viewMatch[1]);
      if (!view) return json(response, 404, { error: "会话不存在" });
      json(response, 200, view);
      return;
    }

    const activateMatch = /^\/api\/sessions\/([a-f0-9]{20})\/activate$/.exec(url.pathname);
    if (activateMatch) {
      if (request.method !== "POST") return methodNotAllowed(response);
      const id = activateMatch[1];
      if (id !== this.activeSessionId) await this.ensureRuntime(id);
      const view = await this.sessionView(id);
      if (!view) return json(response, 404, { error: "会话不存在" });
      json(response, 200, view);
      return;
    }

    if (url.pathname === "/api/sessions/new") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (this.running || this.promptQueue.length) return json(response, 409, { error: "请先停止生成并清空队列" });
      const result = rpcData<{ cancelled: boolean }>(await this.options.rpc.send({ type: "new_session" }));
      if (result.cancelled) return json(response, 409, { error: "扩展取消了新建会话" });
      const data = await this.bootstrap();
      this.broadcast({ type: "pi_chat_active_session_changed", sessionId: this.activeSessionId });
      json(response, 200, data);
      return;
    }

    const switchMatch = /^\/api\/sessions\/([a-f0-9]{20})\/switch$/.exec(url.pathname);
    if (switchMatch) {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (this.running || this.promptQueue.length) return json(response, 409, { error: "请先停止生成并清空队列" });
      await this.options.sessions.list(undefined, this.currentCwd);
      const sessionPath = this.options.sessions.pathForId(switchMatch[1]);
      if (!sessionPath) return json(response, 404, { error: "会话不存在" });
      const result = rpcData<{ cancelled: boolean }>(await this.options.rpc.send({
        type: "switch_session",
        sessionPath,
      }));
      if (result.cancelled) return json(response, 409, { error: "扩展取消了会话切换" });
      const data = await this.bootstrap();
      this.broadcast({ type: "pi_chat_active_session_changed", sessionId: this.activeSessionId });
      json(response, 200, data);
      return;
    }

    const customModelMatch = /^\/api\/models\/([A-Za-z0-9._-]{1,80})\/([^/]{1,200})$/.exec(url.pathname);
    if (customModelMatch) {
      if (request.method !== "GET") return methodNotAllowed(response);
      if (!this.options.modelManager) return json(response, 501, { error: "模型管理不可用" });
      json(response, 200, { model: await this.options.modelManager.getCustomConfig(decodeURIComponent(customModelMatch[1]), decodeURIComponent(customModelMatch[2])) });
      return;
    }

    if (url.pathname === "/api/models") {
      if (!this.options.modelManager) return json(response, 501, { error: "模型管理不可用" });
      if (this.running || this.promptQueue.length || [...this.runtimes.values()].some((runtime) => runtime.running)) return json(response, 409, { error: "请先停止所有并行生成并清空队列" });
      const body = await bodyJson(request);
      if (request.method === "POST") {
        await this.options.modelManager.add(body);
      } else if (request.method === "DELETE") {
        const state = asState(await this.options.rpc.send({ type: "get_state" }));
        if (state.model?.provider === body.provider && state.model?.id === body.modelId) {
          return json(response, 409, { error: "请先切换到其他模型，再删除当前模型" });
        }
        await this.options.modelManager.remove(body.provider, body.modelId);
      } else return methodNotAllowed(response);
      await this.reloadRpc();
      json(response, 200, await this.bootstrap());
      return;
    }

    if (url.pathname === "/api/models/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const provider = typeof body.provider === "string" ? body.provider : "";
      const modelId = typeof body.modelId === "string" ? body.modelId : "";
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      const secondaryRuntime = this.runtimes.get(sessionId) || null;
      if (!provider || !modelId) return json(response, 400, { error: "provider 和 modelId 必填" });
      if (!secondaryRuntime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未启用" });
      if (secondaryRuntime?.running || (!secondaryRuntime && this.running)) return json(response, 409, { error: "请先停止该会话生成" });
      if (secondaryRuntime) this.touchRuntime(secondaryRuntime);
      const model = rpcData<ModelInfo>(await (secondaryRuntime?.rpc || this.options.rpc).send({ type: "set_model", provider, modelId }));
      json(response, 200, { model });
      return;
    }

    if (url.pathname === "/api/thinking/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const allowed: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      const level = typeof body.level === "string" && allowed.includes(body.level as ThinkingLevel) ? body.level as ThinkingLevel : null;
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      const secondaryRuntime = this.runtimes.get(sessionId) || null;
      if (!level) return json(response, 400, { error: "无效的 Thinking 强度" });
      if (!secondaryRuntime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未启用" });
      if (secondaryRuntime?.running || (!secondaryRuntime && this.running)) return json(response, 409, { error: "请先停止该会话生成" });
      if (secondaryRuntime) this.touchRuntime(secondaryRuntime);
      const targetRpc = secondaryRuntime?.rpc || this.options.rpc;
      await targetRpc.send({ type: "set_thinking_level", level });
      const state = asState(await targetRpc.send({ type: "get_state" }));
      json(response, 200, { level: state.thinkingLevel });
      return;
    }

    if (url.pathname === "/api/resources/skills") {
      if (request.method === "GET") return json(response, 200, await this.options.resources.listSkills(this.currentCwd));
      if (this.running || this.promptQueue.length || [...this.runtimes.values()].some((runtime) => runtime.running)) return json(response, 409, { error: "请先停止所有并行生成并清空队列" });
      const body = await bodyJson(request);
      if (request.method === "POST") {
        const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
        if (!sourcePath) return json(response, 400, { error: "sourcePath 必填" });
        await this.options.resources.installSkill(sourcePath);
      } else if (request.method === "PATCH") {
        if (typeof body.id !== "string" || typeof body.enabled !== "boolean") return json(response, 400, { error: "id 和 enabled 必填" });
        await this.options.resources.setSkillEnabled(body.id, body.enabled, this.currentCwd);
      } else if (request.method === "DELETE") {
        if (typeof body.id !== "string") return json(response, 400, { error: "id 必填" });
        await this.options.resources.removeSkill(body.id, this.currentCwd);
      } else return methodNotAllowed(response);
      await this.reloadRpc();
      const result = await this.options.resources.listSkills(this.currentCwd);
      json(response, 200, { ...result, reloaded: true });
      return;
    }

    if (url.pathname === "/api/resources/extensions") {
      if (request.method === "GET") return json(response, 200, await this.options.resources.listExtensions(this.currentCwd));
      if (this.running || this.promptQueue.length || [...this.runtimes.values()].some((runtime) => runtime.running)) return json(response, 409, { error: "请先停止所有并行生成并清空队列" });
      const body = await bodyJson(request);
      if (request.method === "PATCH") {
        if (typeof body.id !== "string" || typeof body.enabled !== "boolean") return json(response, 400, { error: "id 和 enabled 必填" });
        await this.options.resources.setExtensionEnabled(body.id, body.enabled, this.currentCwd);
      } else if (request.method === "DELETE") {
        if (typeof body.id !== "string") return json(response, 400, { error: "id 必填" });
        await this.options.resources.removeExtension(body.id, this.currentCwd);
      } else return methodNotAllowed(response);
      await this.reloadRpc();
      const result = await this.options.resources.listExtensions(this.currentCwd);
      json(response, 200, { ...result, reloaded: true });
      return;
    }

    if (url.pathname === "/api/resources/packages") {
      if (request.method === "GET") return json(response, 200, await this.options.resources.listPackages(this.currentCwd));
      if (this.running || this.promptQueue.length || [...this.runtimes.values()].some((runtime) => runtime.running)) return json(response, 409, { error: "请先停止所有并行生成并清空队列" });
      const body = await bodyJson(request);
      if (request.method === "POST") {
        const source = typeof body.source === "string" ? body.source.trim() : "";
        if (!source) return json(response, 400, { error: "source 必填" });
        await this.options.resources.installPackage(source);
      } else if (request.method === "PATCH") {
        if (typeof body.id !== "string" || typeof body.enabled !== "boolean") return json(response, 400, { error: "id 和 enabled 必填" });
        await this.options.resources.setPackageEnabled(body.id, body.enabled, this.currentCwd);
      } else if (request.method === "DELETE") {
        if (typeof body.id !== "string") return json(response, 400, { error: "id 必填" });
        await this.options.resources.removePackage(body.id, this.currentCwd);
      } else return methodNotAllowed(response);
      await this.reloadRpc();
      const result = await this.options.resources.listPackages(this.currentCwd);
      json(response, 200, { ...result, reloaded: true });
      return;
    }

    if (url.pathname === "/api/extension-ui/respond") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      if (typeof body.id !== "string") return json(response, 400, { error: "id 必填" });
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : this.activeSessionId;
      const runtime = this.runtimes.get(sessionId);
      const targetRpc = runtime?.rpc || (sessionId === this.activeSessionId ? this.options.rpc : null);
      if (!targetRpc) return json(response, 409, { error: "Extension 对应的会话已经关闭" });
      if (runtime) {
        runtime.extensionUiPending = false;
        this.touchRuntime(runtime);
      }
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
      "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      "cache-control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    createReadStream(filePath).pipe(response);
  }
}
