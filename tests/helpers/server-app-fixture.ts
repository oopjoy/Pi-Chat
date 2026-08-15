import type { RpcEventSource, RpcRequestObserver } from "../../src/server/rpc-client";
export class FakeRpc {
  readonly commands: Record<string, unknown>[] = [];
  readonly requestTimeouts: Array<{
    type: unknown;
    timeoutMs: number | undefined;
    independentRead: boolean;
  }> = [];
  private listeners = new Set<(
    event: Record<string, unknown>,
    source?: RpcEventSource,
  ) => void>();
  /** Captures callbacks once registered so a test can model an already-buffered old-child frame after unsubscribe. */
  private readonly historicalListeners = new Set<(
    event: Record<string, unknown>,
    source?: RpcEventSource,
  ) => void>();
  streaming = false;
  stopCount = 0;
  restartCount = 0;
  restartFailures = 0;
  alive = true;
  /** Faithful Pi steering queue: queue_update carries the whole backlog, and consumption removes one message before message_start. */
  readonly steeringQueue: string[] = [];
  private requestId = 0;
  generation = 0;

  constructor(
    readonly path: string,
    readonly sessionId: string,
  ) {}

  onEvent(listener: (
    event: Record<string, unknown>,
    source?: RpcEventSource,
  ) => void) {
    this.listeners.add(listener);
    this.historicalListeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: Record<string, unknown>, generation = this.generation) {
    const source = { generation };
    for (const listener of this.listeners) listener(event, source);
  }

  /** A stopped child can already have a stdout callback queued when unsubscribe runs. */
  emitLate(event: Record<string, unknown>, generation = this.generation) {
    const source = { generation };
    for (const listener of this.historicalListeners) listener(event, source);
  }

  async start() {
    this.alive = true;
  }

  async stop() {
    this.stopCount += 1;
    this.alive = false;
  }

  isRunning() {
    return this.alive;
  }

  currentGeneration() {
    return this.generation;
  }

  async restart() {
    this.restartCount += 1;
    if (this.restartFailures > 0) {
      this.restartFailures -= 1;
      this.alive = false;
      throw new Error("simulated restart failure");
    }
    this.alive = true;
    this.streaming = false;
  }

  sendRaw(command: Record<string, unknown>) {
    this.commands.push(command);
  }

  crash() {
    this.alive = false;
    this.emit({ type: "pi_chat_process_error", error: "worker crashed" });
  }

  async send(
    command: Record<string, unknown>,
    timeoutMs?: number,
    options?: { independentRead?: boolean; observe?: RpcRequestObserver },
  ) {
    const requestId = `fake-${++this.requestId}`;
    const startedAt = Date.now();
    const observe = (phase: "allocated" | "written" | "response", outcome: "allocated" | "written" | "response-success") => {
      try {
        options?.observe?.({
          requestId,
          requestType: typeof command.type === "string" ? command.type : "unknown",
          generation: this.generation,
          phase,
          outcome,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // Mirrors PiRpcClient's fail-open observation boundary.
      }
    };
    observe("allocated", "allocated");
    observe("written", "written");
    this.commands.push(command);
    this.requestTimeouts.push({
      type: command.type,
      timeoutMs,
      independentRead: options?.independentRead === true,
    });
    if (command.type === "get_state")
      return {
        type: "response",
        success: true,
        data: {
          model: null,
          sessionFile: this.path,
          sessionId: this.sessionId,
          isStreaming: this.streaming,
        },
      };
    if (command.type === "get_messages")
      return { type: "response", success: true, data: { messages: [] } };
    if (command.type === "get_available_models")
      return {
        type: "response",
        success: true,
        data: {
          models: [
            {
              provider: "test",
              id: "next",
              name: "Next",
              reasoning: true,
            },
          ],
        },
      };
    if (command.type === "get_commands")
      return { type: "response", success: true, data: { commands: [] } };
    if (command.type === "get_session_stats")
      return {
        type: "response",
        success: true,
        data: {
          tokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
      };
    if (command.type === "prompt") {
      this.streaming = true;
      this.emit({ type: "agent_start" });
      observe("response", "response-success");
      return { type: "response", success: true };
    }
    if (command.type === "steer") {
      this.steeringQueue.push(String(command.message));
      this.emit({
        type: "queue_update",
        steering: [...this.steeringQueue],
        followUp: [],
      });
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

export class PersistedDraftRpc extends FakeRpc {
  private hasPrompt = false;

  override async send(command: Record<string, unknown>) {
    if (command.type === "prompt") this.hasPrompt = true;
    if (command.type === "get_messages" && this.hasPrompt) {
      this.commands.push(command);
      return {
        type: "response",
        success: true,
        data: { messages: [{ role: "user", content: "hello" }] },
      };
    }
    return super.send(command);
  }
}

export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export class GateFakeRpc extends FakeRpc {
  override async send(command: Record<string, unknown>) {
    if (command.type === "get_commands") {
      this.commands.push(command);
      return {
        type: "response",
        success: true,
        data: { commands: [{ name: "gate", source: "extension" }] },
      };
    }
    if (
      command.type === "prompt" &&
      typeof command.message === "string" &&
      command.message.startsWith("/gate ")
    ) {
      this.commands.push(command);
      return { type: "response", success: true };
    }
    return super.send(command);
  }
}
