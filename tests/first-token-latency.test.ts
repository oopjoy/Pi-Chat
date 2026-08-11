import assert from "node:assert/strict";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import type { PiRpcClient } from "../src/server/rpc-client";
import { idForPath, type SessionIndex } from "../src/server/session-index";
import type { ResourceManager } from "../src/server/resource-manager";
import type { SessionSummary } from "../src/shared/types";

/**
 * First-token latency regression guard.
 *
 * Pi Chat cannot control how long Pi or the model takes before the first
 * token, but it must not add meaningful delay of its own: prompt admission,
 * queue dispatch, Gate synchronization, and SSE forwarding are all in the
 * critical path. This fake RPC injects a known Pi-side first-delta delay and
 * asserts that Pi Chat's own overhead stays bounded (generous bound so the
 * test is CI-stable while still catching gross stalls such as accidental
 * serialization behind a barrier or a stuck dispatch flag).
 */

class LatencyFakeRpc {
  readonly commands: Record<string, unknown>[] = [];
  private listeners = new Set<(event: Record<string, unknown>) => void>();
  streaming = false;
  alive = true;
  promptAcceptCount = 0;

  constructor(
    readonly path: string,
    readonly sessionId: string,
    /** Injected Pi-side delay between prompt acceptance and first assistant delta. */
    readonly firstDeltaMs: number,
  ) {}

  onEvent(listener: (event: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: Record<string, unknown>) {
    for (const listener of this.listeners) listener(event);
  }
  async start() {
    this.alive = true;
  }
  async stop() {
    this.alive = false;
  }
  isRunning() {
    return this.alive;
  }

  private assistantDelta(content: string) {
    return {
      type: "message_update",
      message: {
        role: "assistant",
        provider: "latency",
        model: "fake-first-token",
        content,
        timestamp: Date.now(),
      },
    };
  }

  async send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.commands.push(command);
    if (command.type === "get_state")
      return {
        type: "response",
        success: true,
        data: {
          model: { provider: "latency", id: "fake-first-token", name: "Fake", input: ["text"] },
          sessionFile: this.path,
          sessionId: this.sessionId,
          isStreaming: this.streaming,
        },
      };
    if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
    if (command.type === "get_available_models")
      return { type: "response", success: true, data: { models: [{ provider: "latency", id: "fake-first-token", name: "Fake", input: ["text"] }] } };
    if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
    if (command.type === "get_session_stats")
      return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (command.type === "prompt") {
      this.promptAcceptCount += 1;
      this.streaming = true;
      this.emit({ type: "agent_start" });
      setTimeout(() => {
        this.emit(this.assistantDelta("He"));
        this.emit(this.assistantDelta("Hello from Pi"));
      }, this.firstDeltaMs);
      setTimeout(() => {
        this.streaming = false;
        this.emit({
          type: "message_end",
          message: { role: "assistant", provider: "latency", model: "fake-first-token", content: "Hello from Pi", timestamp: Date.now() },
        });
        this.emit({ type: "agent_settled" });
      }, this.firstDeltaMs + 40);
      return { type: "response", success: true };
    }
    if (command.type === "abort") {
      this.streaming = false;
      this.emit({ type: "agent_settled" });
      return { type: "response", success: true };
    }
    return { type: "response", success: true, data: {} };
  }
}

async function bootApp(firstDeltaMs: number) {
  const path = `C:\\sessions\\first-token-${firstDeltaMs}.jsonl`;
  const id = idForPath(path);
  const primary = new LatencyFakeRpc(path, `first-token-${firstDeltaMs}`, firstDeltaMs);
  const summaries: SessionSummary[] = [
    { id, sessionId: id, name: "First token", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => (candidate === id ? path : null),
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { app, server, origin: `http://127.0.0.1:${address.port}`, primary };
}

async function* readSseFrames(response: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        try {
          yield JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
        } catch {
          // Non-JSON frames (e.g. heartbeat notes) are skipped.
        }
      }
    }
  }
}

function isAssistantContentFrame(frame: Record<string, unknown>): boolean {
  if (frame.type !== "message_update" && frame.type !== "message_start") return false;
  const message = frame.message as { role?: string; content?: unknown } | undefined;
  return message?.role === "assistant" && typeof message.content === "string" && message.content.length > 0;
}

function isSettledFrame(frame: Record<string, unknown>): boolean {
  return frame.type === "agent_settled";
}

test("warm idle first-token: Pi Chat adds only bounded overhead", { timeout: 30_000 }, async () => {
  const injected = 100;
  const { app, server, origin, primary } = await bootApp(injected);
  const owner = "11111111-1111-4111-8111-111111111111";
  const controller = new AbortController();
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { "x-pi-chat-client": owner } })).status, 200);
    const events = fetch(`${origin}/api/events`, { headers: { "x-pi-chat-client": owner }, signal: controller.signal }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const startedAt = performance.now();
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-chat-client": owner },
      body: JSON.stringify({ message: "hello", sessionId: idForPath(`C:\\sessions\\first-token-${injected}.jsonl`) }),
    });
    assert.equal(response.status, 202);
    const acceptedAt = performance.now();

    let firstFrameAt = 0;
    let settledAt = 0;
    for await (const frame of readSseFrames(await events)) {
      if (!firstFrameAt && isAssistantContentFrame(frame)) firstFrameAt = performance.now();
      if (isSettledFrame(frame)) {
        settledAt = performance.now();
        break;
      }
    }

    assert.ok(firstFrameAt > 0, "expected an assistant content SSE frame before settlement");
    const acceptMs = acceptedAt - startedAt;
    const firstFrameMs = firstFrameAt - startedAt;
    const overheadMs = firstFrameMs - injected;
    console.log(
      `[first-token] warm idle: accept=${acceptMs.toFixed(1)}ms firstFrame=${firstFrameMs.toFixed(1)}ms injectedPiDelay=${injected}ms overhead=${overheadMs.toFixed(1)}ms`,
    );
    // The client can never see the first token before Pi emits it.
    assert.ok(firstFrameMs >= injected - 25, `first frame arrived before Pi could emit it: ${firstFrameMs.toFixed(1)}ms`);
    // Pi Chat's own contribution (admission, dispatch, SSE fanout) must be small.
    assert.ok(overheadMs < 1_000, `Pi Chat added ${overheadMs.toFixed(1)}ms of overhead`);
    assert.ok(settledAt > firstFrameAt, "assistant content must precede settlement");
    assert.equal(primary.promptAcceptCount, 1);
  } finally {
    controller.abort();
    server.close();
    await app.close();
  }
});

test("queued follow-up first-token is dispatched promptly after settlement", { timeout: 30_000 }, async () => {
  const injected = 100;
  const { app, server, origin, primary } = await bootApp(injected);
  const owner = "11111111-1111-4111-8111-111111111111";
  const controller = new AbortController();
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { "x-pi-chat-client": owner } })).status, 200);
    const events = fetch(`${origin}/api/events`, { headers: { "x-pi-chat-client": owner }, signal: controller.signal }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sessionId = idForPath(`C:\\sessions\\first-token-${injected}.jsonl`);

    // First prompt starts a turn.
    const first = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-chat-client": owner },
      body: JSON.stringify({ message: "first", sessionId }),
    });
    assert.equal(first.status, 202);

    // Second prompt while streaming must be queued, not dispatched.
    const queued = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-chat-client": owner },
      body: JSON.stringify({ message: "follow-up", sessionId }),
    });
    assert.equal(queued.status, 202);
    const queuedBody = (await queued.json()) as { accepted?: boolean; queued?: boolean };
    assert.equal(queuedBody.queued, true);

    let startedCount = 0;
    let settleObservedAt = 0;
    let followUpFirstFrameAt = 0;
    for await (const frame of readSseFrames(await events)) {
      if (frame.type === "agent_start") startedCount += 1;
      if (isSettledFrame(frame)) settleObservedAt = performance.now();
      if (startedCount >= 2 && isAssistantContentFrame(frame)) {
        followUpFirstFrameAt = performance.now();
        break;
      }
    }

    assert.ok(settleObservedAt > 0, "expected a settlement frame");
    assert.ok(followUpFirstFrameAt > 0, "expected the follow-up assistant frame");
    const afterSettleMs = followUpFirstFrameAt - settleObservedAt;
    const overheadMs = afterSettleMs - injected;
    console.log(
      `[first-token] queued follow-up: settle→firstFrame=${afterSettleMs.toFixed(1)}ms injectedPiDelay=${injected}ms overhead=${overheadMs.toFixed(1)}ms`,
    );
    assert.equal(primary.promptAcceptCount, 2, "both prompts must reach Pi");
    assert.ok(overheadMs < 1_000, `follow-up dispatch after settlement added ${overheadMs.toFixed(1)}ms`);
  } finally {
    controller.abort();
    server.close();
    await app.close();
  }
});
