import type { PiState, PrimaryRuntimeReadiness } from "../shared/types.js";
import { RpcRequestTimeoutError, rpcData, type PiRpcClient } from "./rpc-client.js";
import {
  attachIncidentReference,
  incidentErrorCode,
  incidentReference,
  recordIncident,
  type IncidentDiagnostics,
} from "./incident-diagnostics.js";

export class PrimaryRuntimeUnavailableError extends Error {
  constructor(readonly readiness: PrimaryRuntimeReadiness) {
    super(readiness.status === "failed"
      ? `Pi Runtime 不可用：${readiness.error || "启动或兼容性检查失败"}`
      : "Pi Runtime 正在准备，请稍后重试");
    this.name = "PrimaryRuntimeUnavailableError";
  }
}

export interface PrimaryRuntimeAdoptionContext {
  generation: number;
  restart: boolean;
  sessionFile?: string;
  cwd?: string;
}

export type PrimaryRuntimeAdopter = (
  response: Record<string, unknown>,
  context: PrimaryRuntimeAdoptionContext,
) => void | Promise<void>;

export interface PrimaryRuntimeReadinessBridge {
  snapshot(): PrimaryRuntimeReadiness;
  waitUntilReady(): Promise<void>;
  recover(sessionFile?: string, cwd?: string): Promise<void>;
  /**
   * Install the host-side adoption barrier. A controller that supports this
   * never publishes ready until the App has bound the child generation,
   * Session identity, state, Gate mode, and selected-model capability.
   */
  setAdopter?(adopter: PrimaryRuntimeAdopter): void;
  /** Propagate an unexpected live child failure into the readiness projection. */
  markFailed(error: unknown): void;
  subscribe(listener: (readiness: PrimaryRuntimeReadiness) => void): () => void;
}

/**
 * Sole owner of Primary spawn/restart + protocol verification. A running child
 * is not writable until compatibility has passed; every recovery repeats probe.
 */
export interface PrimaryRuntimeReadinessOptions {
  diagnostics?: IncidentDiagnostics;
  lifecycle?: () => import("../shared/types.js").ApplicationLifecycle;
}

export class PrimaryRuntimeReadinessController implements PrimaryRuntimeReadinessBridge {
  private readiness: PrimaryRuntimeReadiness = { status: "starting", generation: 0 };
  private operation: Promise<void> | null = null;
  private operationFailure: unknown = null;
  private adopter: PrimaryRuntimeAdopter | null = null;
  private readonly listeners = new Set<(readiness: PrimaryRuntimeReadiness) => void>();

  constructor(
    private readonly rpc: Pick<PiRpcClient, "start" | "restart" | "stop" | "probeCompatibility">
      & Partial<Pick<PiRpcClient, "currentGeneration" | "currentPid">>,
    private readonly options: PrimaryRuntimeReadinessOptions = {},
  ) {}

  setAdopter(adopter: PrimaryRuntimeAdopter): void {
    if (this.operation) throw new Error("Primary Runtime 启动期间不能更换采用器");
    this.adopter = adopter;
  }

  snapshot(): PrimaryRuntimeReadiness { return this.readiness; }

  subscribe(listener: (readiness: PrimaryRuntimeReadiness) => void): () => void {
    this.listeners.add(listener);
    listener(this.readiness);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<void> { return this.begin(false); }
  recover(sessionFile?: string, cwd?: string): Promise<void> { return this.begin(true, sessionFile, cwd); }

  markFailed(cause: unknown): void {
    const error = cause instanceof Error
      ? cause.message
      : cause && typeof cause === "object" && typeof (cause as Record<string, unknown>).error === "string"
        ? String((cause as Record<string, unknown>).error)
        : String(cause);
    const errorCode = incidentErrorCode(cause) || "PRIMARY_RUNTIME_UNAVAILABLE";
    const incident = incidentReference(cause) || recordIncident(
      this.options.diagnostics,
      cause,
      {
        runtimeKind: "primary",
        rpcGeneration: this.rpc.currentGeneration?.() || undefined,
        childPid: this.rpc.currentPid?.() || undefined,
        operation: "runtime.recovery",
        lifecycle: this.options.lifecycle?.() || "idle",
        outcome: "failed",
        errorCode,
      },
    );
    // App source-generation filtering guarantees this is the current child. If
    // adoption is still blocking, latch the transport failure onto this exact
    // operation so releasing the barrier can never publish ready afterward.
    if (this.readiness.status === "starting") this.operationFailure = cause;
    const failed: PrimaryRuntimeReadiness = {
      status: "failed",
      error,
      incidentId: incident.incidentId,
      generation: this.readiness.status === "starting"
        ? this.readiness.generation
        : this.readiness.generation + 1,
    };
    attachIncidentReference(failed, incident, errorCode);
    this.publish(failed);
  }

  async waitUntilReady(): Promise<void> {
    if (this.readiness.status === "ready") return;
    if (this.readiness.status === "failed") throw new PrimaryRuntimeUnavailableError(this.readiness);
    try {
      await (this.operation || this.start());
    } catch {
      // State below owns the stable, user-facing error.
    }
    if (this.snapshot().status !== "ready") throw new PrimaryRuntimeUnavailableError(this.snapshot());
  }

  private begin(restart: boolean, sessionFile?: string, cwd?: string): Promise<void> {
    if (this.operation) return this.operation;
    const generation = this.readiness.generation + 1;
    this.operationFailure = null;
    this.publish({ status: "starting", generation });
    const operation = (async () => {
      let lastCause: unknown;
      // Pi RPC has no request cancellation. Retrying get_state inside one child
      // would only queue behind the stuck command, so the sole safe transient
      // retry boundary is the entire process. One replacement is enough to
      // escape an intermittent extension/startup deadlock without creating an
      // unbounded respawn loop for deterministic configuration failures.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const initialState = restart || attempt > 0
            ? await this.rpc.restart(sessionFile, cwd)
            : await this.rpc.start();
          // PiRpcClient.start()/restart() already perform and return the
          // readiness get_state probe. Reuse it so Primary does not immediately
          // enqueue a second identical query. Legacy test/embedding doubles may
          // return void, in which case probeCompatibility performs the fallback.
          const compatibility = await this.rpc.probeCompatibility(initialState || undefined);
          if (!compatibility.compatible)
            throw new Error(`当前 Pi RPC 协议不兼容 Pi Chat：${compatibility.diagnostics.join("；")}`);
          // This is the atomic ownership handoff. Keep readiness at `starting`
          // until the host has consumed the exact startup response and completed
          // every invariant required for browser mutations.
          if (initialState && this.adopter)
            await this.adopter(initialState, {
              generation,
              restart: restart || attempt > 0,
              sessionFile,
              cwd,
            });
          if (this.operationFailure) throw this.operationFailure;
          const state = initialState ? rpcData<PiState>(initialState) : undefined;
          this.publish({
            status: "ready",
            generation,
            ...(state?.model !== undefined ? { model: state.model } : null),
            ...(state?.thinkingLevel !== undefined
              ? { thinkingLevel: state.thinkingLevel }
              : null),
            ...(state?.sessionId ? { sessionId: state.sessionId } : null),
          });
          return;
        } catch (cause) {
          lastCause = cause;
          await this.rpc.stop().catch(() => undefined);
          const transient =
            cause instanceof RpcRequestTimeoutError ||
            /Pi RPC (?:已退出|启动失败|在初始化期间退出|请求超时)/.test(
              cause instanceof Error ? cause.message : String(cause),
            );
          if (!transient || attempt === 1) break;
        }
      }
      const error = lastCause instanceof Error ? lastCause.message : String(lastCause);
      const errorCode = incidentErrorCode(lastCause) || "PRIMARY_RUNTIME_UNAVAILABLE";
      const incident = incidentReference(lastCause) || recordIncident(
        this.options.diagnostics,
        lastCause,
        {
          runtimeKind: "primary",
          rpcGeneration: this.rpc.currentGeneration?.() || undefined,
          childPid: this.rpc.currentPid?.() || undefined,
          operation: "runtime.start",
          lifecycle: this.options.lifecycle?.() || "idle",
          outcome: "failed",
          errorCode,
        },
      );
      const failed: PrimaryRuntimeReadiness = {
        status: "failed",
        error,
        incidentId: incident.incidentId,
        generation,
      };
      attachIncidentReference(failed, incident, errorCode);
      this.publish(failed);
      throw new PrimaryRuntimeUnavailableError(this.readiness);
    })();
    this.operation = operation;
    void operation.finally(() => { if (this.operation === operation) this.operation = null; }).catch(() => undefined);
    return operation;
  }

  private publish(readiness: PrimaryRuntimeReadiness): void {
    this.readiness = readiness;
    for (const listener of this.listeners) listener(readiness);
  }
}
