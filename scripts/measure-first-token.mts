// First-token latency diagnostic for Pi Chat.
//
// Pi Chat cannot speed up Pi's own agent loop or the model's time-to-first-
// token, but it must not add meaningful delay of its own. This script makes
// the split measurable.
//
// Modes:
//
//   node --import tsx scripts/measure-first-token.mts
//       Real Pi RPC time-to-first-token (default). Spawns one isolated Pi RPC
//       worker with a temporary session file, sends one prompt, and reports
//       how long Pi itself takes from prompt acceptance to the first
//       assistant token and to settlement. Uses the configured default model.
//
//   node --import tsx scripts/measure-first-token.mts --trials 3
//       Repeat the real-Pi measurement N times (each trial uses its own
//       temporary session).
//
//   node --import tsx scripts/measure-first-token.mts --overhead --trials 10
//       Pi Chat server overhead only. Boots an in-process Pi Chat server with
//       a fake RPC that injects a fixed 100 ms Pi-side first-delta delay and
//       reports the overhead Pi Chat adds on top (admission, dispatch, SSE
//       fanout). Deterministic, no model involved.
//
//   node --import tsx scripts/measure-first-token.mts --url http://127.0.0.1:30170 --token <startup-token> --trials 3
//       End-to-end against an already-running Pi Chat instance. Each trial
//       creates a real turn in that instance's active session, so only run
//       this against an instance you are authorized to drive.
//
// Exit code 0 on success; a real-Pi trial that cannot produce a first token
// within the timeout is reported as an error with the captured stderr tail.

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PiChatApp } from "../src/server/app.js";
import { PiRpcClient, type PiRpcClient as PiRpcClientType } from "../src/server/rpc-client.js";
import { idForPath, type SessionIndex } from "../src/server/session-index.js";
import type { ResourceManager } from "../src/server/resource-manager.js";
import type { SessionSummary } from "../src/shared/types.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const trials = Number(flag("--trials") || "1");

function isAssistantContentFrame(frame: Record<string, unknown>): boolean {
  if (frame.type !== "message_update" && frame.type !== "message_start") return false;
  const message = frame.message as { role?: string; content?: unknown } | undefined;
  return message?.role === "assistant" && typeof message.content === "string" && message.content.length > 0;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function report(label: string, values: number[]): void {
  const sorted = [...values].sort((a, b) => a - b);
  const median = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  console.log(`[${label}] trials=${sorted.length} median=${median.toFixed(1)}ms p95=${p95.toFixed(1)}ms min=${min.toFixed(1)}ms max=${max.toFixed(1)}ms`);
}

async function waitForEvent(
  client: PiRpcClientType,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout waiting for event after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = client.onEvent((frame) => {
      if (predicate(frame)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(frame);
      }
    });
  });
}

async function measureRawPi(trialsCount: number): Promise<void> {
  const firstTokens: number[] = [];
  const settlements: number[] = [];
  for (let trial = 0; trial < trialsCount; trial += 1) {
    const root = await mkdtemp(join(tmpdir(), "pi-chat-first-token-"));
    const sessionPath = join(root, "measure.jsonl");
    const client = new PiRpcClient({ cwd: root, args: ["--session", sessionPath] });
    let stderr = "";
    try {
      const firstTokenPromise = waitForEvent(client, isAssistantContentFrame, 120_000);
      const settledPromise = waitForEvent(client, (frame) => frame.type === "agent_settled", 120_000);
      await client.start();
      const startedAt = performance.now();
      const responsePromise = client.send({ type: "prompt", message: "Reply with exactly: OK" }, 60_000);
      const firstToken = await firstTokenPromise;
      const firstTokenAt = performance.now();
      await settledPromise;
      const settledAt = performance.now();
      await responsePromise;
      firstTokens.push(firstTokenAt - startedAt);
      settlements.push(settledAt - startedAt);
      console.log(`trial ${trial + 1}: prompt→firstToken=${(firstTokenAt - startedAt).toFixed(1)}ms prompt→settled=${(settledAt - startedAt).toFixed(1)}ms`);
    } catch (error) {
      stderr = (client as unknown as { stderrTail?: string }).stderrTail || "";
      console.error(`trial ${trial + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (stderr) console.error(`  stderr tail: ${stderr.slice(-800)}`);
    } finally {
      await client.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
  if (firstTokens.length) report("raw Pi prompt→firstToken", firstTokens);
  if (settlements.length) report("raw Pi prompt→settled", settlements);
}

async function measurePiChatOverhead(trialsCount: number): Promise<void> {
  const injected = 100;
  const overheads: number[] = [];
  for (let trial = 0; trial < trialsCount; trial += 1) {
    const path = `C:\\sessions\\overhead-${trial}.jsonl`;
    const id = idForPath(path);
    const rpc = {
      commands: [] as Record<string, unknown>[],
      streaming: false,
      listeners: new Set<(event: Record<string, unknown>) => void>(),
      onEvent: (listener: (event: Record<string, unknown>) => void) => {
        rpc.listeners.add(listener);
        return () => rpc.listeners.delete(listener);
      },
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      send: async (command: Record<string, unknown>) => {
        rpc.commands.push(command);
        if (command.type === "get_state") return { type: "response", success: true, data: { model: { provider: "x", id: "m", name: "M", input: ["text"] }, sessionFile: path, sessionId: id, isStreaming: rpc.streaming } };
        if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
        if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [] } };
        if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
        if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (command.type === "prompt") {
          rpc.streaming = true;
          setTimeout(() => {
            rpc.emit({ type: "message_update", message: { role: "assistant", provider: "x", model: "m", content: "He" } });
            rpc.emit({ type: "message_update", message: { role: "assistant", provider: "x", model: "m", content: "Hello from fake Pi" } });
          }, injected);
          setTimeout(() => {
            rpc.streaming = false;
            rpc.emit({ type: "message_end", message: { role: "assistant", provider: "x", model: "m", content: "Hello from fake Pi" } });
            rpc.emit({ type: "agent_settled" });
          }, injected + 40);
          return { type: "response", success: true };
        }
        return { type: "response", success: true, data: {} };
      },
      emit: (event: Record<string, unknown>) => {
        for (const listener of rpc.listeners) listener(event);
      },
    } as unknown as PiRpcClientType;
    const summaries: SessionSummary[] = [{ id, sessionId: id, name: "M", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }];
    const sessions = { list: async () => summaries, pathForId: () => path, summaryForId: () => summaries[0], messagesForId: async () => [] } as unknown as SessionIndex;
    const app = new PiChatApp({ rpc, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
    const server = createServer((request, response) => void app.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${(address as { port: number }).port}`;
    const client = "11111111-1111-4111-8111-111111111111";
    try {
      await fetch(`${origin}/api/bootstrap`, { headers: { "x-pi-chat-client": client } });
      const events = fetch(`${origin}/api/events`, { headers: { "x-pi-chat-client": client } }).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const startedAt = performance.now();
      await fetch(`${origin}/api/chat/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-chat-client": client },
        body: JSON.stringify({ message: "hello", sessionId: id }),
      });
      const reader = (await events)!.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstFrameAt = 0;
      while (firstFrameAt === 0) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          try {
            if (isAssistantContentFrame(JSON.parse(dataLine.slice(6)) as Record<string, unknown>)) {
              firstFrameAt = performance.now();
              break;
            }
          } catch {
            // skip
          }
        }
      }
      const firstFrameMs = firstFrameAt - startedAt;
      const overheadMs = firstFrameMs - injected;
      overheads.push(overheadMs);
      console.log(`trial ${trial + 1}: POST→firstFrame=${firstFrameMs.toFixed(1)}ms injectedPiDelay=${injected}ms overhead=${overheadMs.toFixed(1)}ms`);
    } finally {
      server.close();
      await app.close();
    }
  }
  if (overheads.length) report("Pi Chat overhead (POST→firstFrame − injected 100ms)", overheads);
}

async function measureLiveUrl(baseUrl: string, token: string | undefined, trialsCount: number): Promise<void> {
  const origin = baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-pi-chat-token"] = token;
  const bootstrap = await fetch(`${origin}/api/bootstrap`, { headers });
  if (!bootstrap.ok) throw new Error(`bootstrap failed: ${bootstrap.status}`);
  const firstTokens: number[] = [];
  for (let trial = 0; trial < trialsCount; trial += 1) {
    const client = `measure-${Date.now()}-${trial}`;
    const events = fetch(`${origin}/api/events`, { headers: { ...headers, "x-pi-chat-client": client } }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const startedAt = performance.now();
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { ...headers, "x-pi-chat-client": client },
      body: JSON.stringify({ message: "Reply with exactly: OK" }),
    });
    const body = await response.text();
    if (response.status !== 202) throw new Error(`prompt failed: ${response.status} ${body}`);
    const reader = (await events)!.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstFrameAt = 0;
    while (firstFrameAt === 0) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        try {
          if (isAssistantContentFrame(JSON.parse(dataLine.slice(6)) as Record<string, unknown>)) {
            firstFrameAt = performance.now();
            break;
          }
        } catch {
          // skip
        }
      }
    }
    firstTokens.push(firstFrameAt - startedAt);
    console.log(`trial ${trial + 1}: POST→firstFrame=${(firstFrameAt - startedAt).toFixed(1)}ms`);
  }
  if (firstTokens.length) report(`live ${origin} POST→firstFrame`, firstTokens);
}

const url = flag("--url");
if (url) {
  await measureLiveUrl(url, flag("--token"), trials);
} else if (has("--overhead")) {
  await measurePiChatOverhead(trials);
} else {
  await measureRawPi(trials);
}
