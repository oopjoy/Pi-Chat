import type { IncomingMessage, ServerResponse } from "node:http";
import type { QueuedPrompt } from "../../shared/types.js";
import type { InternalQueuedPrompt } from "../prompt-scheduler.js";
import { bodyJson, json, methodNotAllowed } from "../http-transport.js";
import { requiredSessionId } from "./request-validation.js";

const QUEUE_ID = /^[a-f0-9-]{36}$/;

export interface QueueControlTarget {
  queue: InternalQueuedPrompt[];
  getPaused(): boolean;
  setPaused(paused: boolean): void;
  touch(): void;
  recover?(): Promise<void>;
  dispatch(): void;
}

export interface QueueControlRouteHost {
  target(sessionId: string): QueueControlTarget | null;
  publicQueue(queue: InternalQueuedPrompt[]): QueuedPrompt[];
  traceCancelled(sessionId: string, queueId: string): void;
  broadcastQueue(sessionId: string): void;
}

/** Queue cancellation and resume retain Queue ownership in the selected target. */
export async function handleQueueControlRoute(
  host: QueueControlRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  preparedBody?: Record<string, unknown>,
): Promise<boolean> {
  const cancelMatch = /^\/api\/chat\/queue\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (cancelMatch) {
    if (request.method !== "DELETE") {
      methodNotAllowed(response);
      return true;
    }
    const body = preparedBody || await bodyJson(request);
    const sessionId = requiredSessionId(body);
    if (!QUEUE_ID.test(cancelMatch[1])) {
      json(response, 404, { error: "队列消息不存在或已经开始执行" });
      return true;
    }
    const target = host.target(sessionId);
    if (!target) {
      json(response, 409, { error: "该会话尚未恢复运行，请刷新页面后重试" });
      return true;
    }
    target.touch();
    const index = target.queue.findIndex((item) => item.id === cancelMatch[1]);
    if (index < 0) {
      json(response, 404, { error: "队列消息不存在或已经开始执行" });
      return true;
    }
    host.traceCancelled(sessionId, cancelMatch[1]);
    target.queue.splice(index, 1);
    if (!target.queue.length) target.setPaused(false);
    host.broadcastQueue(sessionId);
    json(response, 200, {
      queue: host.publicQueue(target.queue),
      paused: target.getPaused(),
    });
    return true;
  }

  if (url.pathname === "/api/chat/queue/resume") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const body = preparedBody || await bodyJson(request);
    const sessionId = requiredSessionId(body);
    const target = host.target(sessionId);
    if (!target) {
      json(response, 409, { error: "该会话尚未恢复运行，请刷新页面后重试" });
      return true;
    }
    target.touch();
    if (target.recover) await target.recover();
    target.setPaused(false);
    host.broadcastQueue(sessionId);
    target.dispatch();
    json(response, 200, {
      queue: host.publicQueue(target.queue),
      paused: false,
    });
    return true;
  }

  return false;
}
