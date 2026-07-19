import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, normalize, resolve } from "node:path";
import type { BootstrapData, ModelInfo, PiMessage, PiState, PromptImage, QueuedPrompt, SessionStats, SessionViewData, SlashCommand, ThinkingLevel } from "../shared/types.js";
import { pickLocalFiles, pickWorkspaceFolder, readClipboardFiles } from "./file-picker.js";
import { ModelManager } from "./model-manager.js";
import { ResourceManager } from "./resource-manager.js";
import { PiRpcClient, rpcData } from "./rpc-client.js";
import { idForPath, SessionIndex } from "./session-index.js";
import { saveWorkspace } from "./workspace-state.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MESSAGE_WINDOW_SIZE = 400;
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "new", description: "新建会话", source: "builtin" },
  { name: "compact", description: "压缩当前会话上下文，可附加指令", source: "builtin" },
  { name: "abort", description: "停止当前生成", source: "builtin" },
];
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
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

export function messageWindow(messages: PiMessage[]): { messages: PiMessage[]; total: number; truncated: boolean } {
  const total = messages.length;
  return {
    messages: total > MESSAGE_WINDOW_SIZE ? messages.slice(-MESSAGE_WINDOW_SIZE) : messages,
    total,
    truncated: total > MESSAGE_WINDOW_SIZE,
  };
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

export interface PiChatAppOptions {
  rpc: PiRpcClient;
  sessions: SessionIndex;
  webRoot: string;
  cwd: string;
  resources: ResourceManager;
  modelManager?: ModelManager;
  devMiddleware?: (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
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
  private liveMessage: PiMessage | undefined;
  private toolStatus = "";

  constructor(private readonly options: PiChatAppOptions) {
    this.currentCwd = resolve(options.cwd);
    this.unsubscribe = options.rpc.onEvent((event) => this.handleRpcEvent(event));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
  }

  private broadcast(event: Record<string, unknown>): void {
    const frame = `event: pi\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) client.write(frame);
  }

  private publicQueue(): QueuedPrompt[] {
    return this.promptQueue.map(({ id, message, imageCount, createdAt }) => ({ id, message, imageCount, createdAt }));
  }

  private broadcastQueue(): void {
    this.broadcast({ type: "pi_chat_queue_update", queue: this.publicQueue(), paused: this.queuePaused });
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
    this.broadcast(taggedEvent);
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

  private async extensionCommand(message: string): Promise<SlashCommand | null> {
    const match = /^\/([^\s/]+)/.exec(message);
    if (!match) return null;
    const response = await this.options.rpc.send({ type: "get_commands" });
    const command = asCommands(response).find((item) => item.name === match[1]);
    return command?.source === "extension" ? command : null;
  }

  private async sendPrompt(message: string, images: PromptImage[]): Promise<void> {
    this.running = true;
    try {
      await this.options.rpc.send({ type: "prompt", message: message || "请查看这些图片。", ...(images.length ? { images } : {}) });
    } catch (error) {
      this.running = false;
      throw error;
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

  private withActiveSession(sessions: BootstrapData["sessions"], state: PiState): BootstrapData["sessions"] {
    const withStatus = sessions.map((session) => ({ ...session, running: this.running && session.id === this.activeSessionId }));
    if (!state.sessionFile || withStatus.some((session) => session.active)) return withStatus;
    return [{
      id: idForPath(state.sessionFile),
      sessionId: state.sessionId || "new",
      name: state.sessionName || "新会话",
      preview: "尚无消息",
      cwd: this.currentCwd,
      updatedAt: Date.now(),
      messageCount: 0,
      active: true,
      running: this.running,
    }, ...withStatus];
  }

  private async reloadRpc(): Promise<void> {
    if (this.promptQueue.length) throw new Error("请先清空消息队列，再修改资源配置");
    const state = asState(await this.options.rpc.send({ type: "get_state" }));
    if (state.isStreaming) throw new Error("请先停止当前生成，再修改资源配置");
    await this.options.rpc.restart(state.sessionFile);
    this.broadcast({ type: "pi_chat_reloaded" });
  }

  private async changeWorkspace(selected: string): Promise<{ workspaceName: string; data: BootstrapData }> {
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

  private async sessionView(id: string): Promise<SessionViewData | null> {
    const state = asState(await this.options.rpc.send({ type: "get_state" }));
    this.running = state.isStreaming;
    this.activeSessionId = state.sessionFile ? idForPath(state.sessionFile) : state.sessionId || "";
    const sessions = this.withActiveSession(await this.options.sessions.list(state.sessionFile, this.currentCwd), state);
    const session = sessions.find((item) => item.id === id);
    if (!session) return null;
    if (id === this.activeSessionId) {
      const [messagesResponse, statsResponse] = await Promise.all([
        this.options.rpc.send({ type: "get_messages" }),
        this.options.rpc.send({ type: "get_session_stats" }),
      ]);
      const windowed = messageWindow(asMessages(messagesResponse));
      return {
        session,
        messages: windowed.messages,
        messageTotal: windowed.total,
        messagesTruncated: windowed.truncated,
        isActive: true,
        isStreaming: this.running,
        liveMessage: this.liveMessage,
        toolStatus: this.toolStatus,
        stats: asSessionStats(statsResponse),
      };
    }
    const messages = await this.options.sessions.messagesForId(id);
    if (!messages) return null;
    const windowed = messageWindow(messages);
    return {
      session,
      messages: windowed.messages,
      messageTotal: windowed.total,
      messagesTruncated: windowed.truncated,
      isActive: false,
      isStreaming: false,
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
    const sessions = this.withActiveSession(await this.options.sessions.list(state.sessionFile, this.currentCwd), state);
    return {
      state,
      messages: windowedMessages.messages,
      messageTotal: windowedMessages.total,
      messagesTruncated: windowedMessages.truncated,
      activeSessionId: this.activeSessionId,
      liveMessage: this.liveMessage,
      toolStatus: this.toolStatus,
      stats: asSessionStats(statsResponse),
      models: this.options.modelManager ? await this.options.modelManager.annotate(asModels(modelsResponse)) : asModels(modelsResponse),
      commands: [...BUILTIN_COMMANDS, ...asCommands(commandsResponse)],
      queue: this.publicQueue(),
      queuePaused: this.queuePaused,
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

    if (url.pathname === "/api/chat/prompt") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request, 45_000_000);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const images = promptImages(body.images);
      if (!message && !images.length) return json(response, 400, { error: "消息或图片不能为空" });
      if (requestedSessionId && requestedSessionId !== this.activeSessionId) {
        return json(response, 409, { error: "活动会话已在另一个窗口中改变，请刷新后重试" });
      }
      const extensionCommand = message ? await this.extensionCommand(message) : null;
      if (extensionCommand) {
        if (images.length) return json(response, 400, { error: "Extension 指令不能同时附加图片" });
        await this.options.rpc.send({ type: "prompt", message });
        const state = asState(await this.options.rpc.send({ type: "get_state" }));
        this.running = state.isStreaming;
        json(response, 202, { accepted: true, queued: false, extension: true, command: extensionCommand.name, description: extensionCommand.description, isStreaming: state.isStreaming });
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
      const index = this.promptQueue.findIndex((item) => item.id === queueCancelMatch[1]);
      if (index < 0) return json(response, 404, { error: "队列消息不存在或已经开始执行" });
      this.promptQueue.splice(index, 1);
      if (!this.promptQueue.length) this.queuePaused = false;
      this.broadcastQueue();
      json(response, 200, { queue: this.publicQueue(), paused: this.queuePaused });
      return;
    }

    if (url.pathname === "/api/chat/queue/resume") {
      if (request.method !== "POST") return methodNotAllowed(response);
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
      if (this.running || this.promptQueue.length) return json(response, 409, { error: "请先停止生成并清空队列" });
      const selected = await pickWorkspaceFolder(this.currentCwd);
      if (!selected) return json(response, 200, { cancelled: true });
      json(response, 200, { cancelled: false, ...await this.changeWorkspace(selected) });
      return;
    }

    if (url.pathname === "/api/workspace/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (this.running || this.promptQueue.length) return json(response, 409, { error: "请先停止生成并清空队列" });
      const body = await bodyJson(request);
      const selected = typeof body.path === "string" ? body.path.trim() : "";
      if (!selected) return json(response, 400, { error: "path 必填" });
      json(response, 200, { cancelled: false, ...await this.changeWorkspace(selected) });
      return;
    }

    if (url.pathname === "/api/chat/compact") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (this.running || this.promptQueue.length) return json(response, 409, { error: "请先停止生成并清空队列" });
      const body = await bodyJson(request);
      const customInstructions = typeof body.customInstructions === "string" ? body.customInstructions.trim() : "";
      const result = rpcData<Record<string, unknown>>(await this.options.rpc.send({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }, 180_000));
      json(response, 200, { result });
      return;
    }

    if (url.pathname === "/api/chat/abort") {
      if (request.method !== "POST") return methodNotAllowed(response);
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

    const viewMatch = /^\/api\/sessions\/([a-f0-9]{20})\/view$/.exec(url.pathname);
    if (viewMatch) {
      if (request.method !== "GET") return methodNotAllowed(response);
      const view = await this.sessionView(viewMatch[1]);
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

    if (url.pathname === "/api/models") {
      if (!this.options.modelManager) return json(response, 501, { error: "模型管理不可用" });
      if (this.running || this.promptQueue.length) return json(response, 409, { error: "请先停止生成并清空队列" });
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
      if (this.running || this.promptQueue.length) return json(response, 409, { error: "请先停止生成并清空队列" });
      const body = await bodyJson(request);
      const provider = typeof body.provider === "string" ? body.provider : "";
      const modelId = typeof body.modelId === "string" ? body.modelId : "";
      if (!provider || !modelId) return json(response, 400, { error: "provider 和 modelId 必填" });
      const model = rpcData<ModelInfo>(await this.options.rpc.send({ type: "set_model", provider, modelId }));
      json(response, 200, { model });
      return;
    }

    if (url.pathname === "/api/thinking/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (this.running || this.promptQueue.length) return json(response, 409, { error: "请先停止生成并清空队列" });
      const body = await bodyJson(request);
      const allowed: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      const level = typeof body.level === "string" && allowed.includes(body.level as ThinkingLevel) ? body.level as ThinkingLevel : null;
      if (!level) return json(response, 400, { error: "无效的 Thinking 强度" });
      await this.options.rpc.send({ type: "set_thinking_level", level });
      const state = asState(await this.options.rpc.send({ type: "get_state" }));
      json(response, 200, { level: state.thinkingLevel });
      return;
    }

    if (url.pathname === "/api/resources/skills") {
      if (request.method === "GET") return json(response, 200, await this.options.resources.listSkills(this.currentCwd));
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

    if (url.pathname === "/api/resources/plugins") {
      if (request.method === "GET") return json(response, 200, await this.options.resources.listPlugins(this.currentCwd));
      const body = await bodyJson(request);
      if (request.method === "POST") {
        const source = typeof body.source === "string" ? body.source.trim() : "";
        if (!source) return json(response, 400, { error: "source 必填" });
        await this.options.resources.installPlugin(source);
      } else if (request.method === "PATCH") {
        if (typeof body.id !== "string" || typeof body.enabled !== "boolean") return json(response, 400, { error: "id 和 enabled 必填" });
        await this.options.resources.setPluginEnabled(body.id, body.enabled, this.currentCwd);
      } else if (request.method === "DELETE") {
        if (typeof body.id !== "string") return json(response, 400, { error: "id 必填" });
        await this.options.resources.removePlugin(body.id, this.currentCwd);
      } else return methodNotAllowed(response);
      await this.reloadRpc();
      const result = await this.options.resources.listPlugins(this.currentCwd);
      json(response, 200, { ...result, reloaded: true });
      return;
    }

    if (url.pathname === "/api/extension-ui/respond") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      if (typeof body.id !== "string") return json(response, 400, { error: "id 必填" });
      const command: Record<string, unknown> = { type: "extension_ui_response", id: body.id };
      if (body.cancelled === true) command.cancelled = true;
      else if (typeof body.confirmed === "boolean") command.confirmed = body.confirmed;
      else if (typeof body.value === "string") command.value = body.value;
      else command.cancelled = true;
      this.options.rpc.sendRaw(command);
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
