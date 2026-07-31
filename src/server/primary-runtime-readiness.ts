import type { PrimaryRuntimeReadiness } from "../shared/types.js";
import type { PiRpcClient } from "./rpc-client.js";

export class PrimaryRuntimeUnavailableError extends Error {
  constructor(readonly readiness: PrimaryRuntimeReadiness) {
    super(readiness.status === "failed"
      ? `Pi Runtime 不可用：${readiness.error || "启动或兼容性检查失败"}`
      : "Pi Runtime 正在准备，请稍后重试");
    this.name = "PrimaryRuntimeUnavailableError";
  }
}

export interface PrimaryRuntimeReadinessBridge {
  snapshot(): PrimaryRuntimeReadiness;
  waitUntilReady(): Promise<void>;
  recover(sessionFile?: string, cwd?: string): Promise<void>;
  subscribe(listener: (readiness: PrimaryRuntimeReadiness) => void): () => void;
}

/**
 * Sole owner of Primary spawn/restart + protocol verification. A running child
 * is not writable until compatibility has passed; every recovery repeats probe.
 */
export class PrimaryRuntimeReadinessController implements PrimaryRuntimeReadinessBridge {
  private readiness: PrimaryRuntimeReadiness = { status: "starting", generation: 0 };
  private operation: Promise<void> | null = null;
  private readonly listeners = new Set<(readiness: PrimaryRuntimeReadiness) => void>();

  constructor(private readonly rpc: Pick<PiRpcClient, "start" | "restart" | "stop" | "probeCompatibility">) {}

  snapshot(): PrimaryRuntimeReadiness { return this.readiness; }

  subscribe(listener: (readiness: PrimaryRuntimeReadiness) => void): () => void {
    this.listeners.add(listener);
    listener(this.readiness);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<void> { return this.begin(false); }
  recover(sessionFile?: string, cwd?: string): Promise<void> { return this.begin(true, sessionFile, cwd); }

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
    this.publish({ status: "starting", generation });
    const operation = (async () => {
      try {
        if (restart) await this.rpc.restart(sessionFile, cwd);
        else await this.rpc.start();
        const compatibility = await this.rpc.probeCompatibility();
        if (!compatibility.compatible) {
          await this.rpc.stop().catch(() => undefined);
          throw new Error(`当前 Pi RPC 协议不兼容 Pi Chat：${compatibility.diagnostics.join("；")}`);
        }
        this.publish({ status: "ready", generation });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        this.publish({ status: "failed", error, generation });
        throw new PrimaryRuntimeUnavailableError(this.readiness);
      }
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
