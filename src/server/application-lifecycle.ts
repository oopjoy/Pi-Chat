import type { ApplicationLifecycle } from "../shared/types.js";

export class ApplicationBusyError extends Error {}
export class ApplicationLifecycleConflictError extends Error {
  constructor(readonly lifecycle: ApplicationLifecycle, message: string) { super(message); }
}

export function lifecycleMessage(lifecycle: ApplicationLifecycle): string {
  if (lifecycle === "restarting") return "Pi Chat 正在构建并重启，暂时不能提交新操作";
  if (lifecycle === "shutting-down") return "Pi Chat 正在关闭，暂时不能提交新操作";
  if (lifecycle === "workspace-changing") return "Pi Chat 正在切换工作目录，暂时不能提交新操作";
  if (lifecycle === "resources-reloading") return "Pi Chat 正在更新配置并重载 Runtime，暂时不能提交新操作";
  return "Pi Chat 当前不能提交新操作";
}

export class ApplicationLifecycleCoordinator {
  private lifecycleValue: ApplicationLifecycle = "idle";
  private mutationCount = 0;

  constructor(private readonly onChange: (lifecycle: ApplicationLifecycle) => void = () => undefined) {}

  get lifecycle(): ApplicationLifecycle { return this.lifecycleValue; }
  get activeMutations(): number { return this.mutationCount; }
  get idle(): boolean { return this.lifecycleValue === "idle"; }

  assertIdle(): void {
    if (!this.idle) throw new ApplicationLifecycleConflictError(this.lifecycleValue, lifecycleMessage(this.lifecycleValue));
  }

  begin(lifecycle: Exclude<ApplicationLifecycle, "idle">): void {
    this.assertIdle();
    if (this.mutationCount > 0) throw new ApplicationBusyError(`仍有 ${this.mutationCount} 个写操作正在完成，请稍后重试`);
    this.lifecycleValue = lifecycle;
    this.onChange(this.lifecycleValue);
  }

  end(lifecycle: Exclude<ApplicationLifecycle, "idle">): void {
    if (this.lifecycleValue !== lifecycle) return;
    this.lifecycleValue = "idle";
    this.onChange(this.lifecycleValue);
  }

  beginMutation(): () => void {
    this.assertIdle();
    this.mutationCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.mutationCount = Math.max(0, this.mutationCount - 1);
    };
  }

  async run<T>(lifecycle: Exclude<ApplicationLifecycle, "idle">, operation: () => Promise<T>): Promise<T> {
    this.begin(lifecycle);
    try { return await operation(); }
    finally { this.end(lifecycle); }
  }
}
