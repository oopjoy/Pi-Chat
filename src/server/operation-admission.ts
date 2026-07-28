export class OperationAdmissionClosedError extends Error {}

/**
 * Small single-threaded admission gate for one Runtime lifecycle.
 * Closing is synchronous, so no new operation can enter between the idle check
 * and the awaited drain of operations that were already admitted.
 */
export class OperationAdmission {
  private closed = false;
  private active = 0;
  private generationValue = 0;
  private drainWaiters = new Set<() => void>();

  get activeCount(): number { return this.active; }
  get generation(): number { return this.generationValue; }
  get isClosed(): boolean { return this.closed; }

  acquire(): { generation: number; release: () => void } {
    if (this.closed) throw new OperationAdmissionClosedError("会话正在进入休眠，请重试");
    this.active += 1;
    const generation = this.generationValue;
    let released = false;
    return {
      generation,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        if (this.active === 0) {
          for (const resolve of this.drainWaiters) resolve();
          this.drainWaiters.clear();
        }
      },
    };
  }

  async closeAndDrain(): Promise<number | null> {
    if (this.closed) return null;
    this.closed = true;
    this.generationValue += 1;
    const generation = this.generationValue;
    if (this.active > 0) await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
    return generation;
  }

  reopen(generation: number): void {
    if (!this.closed || generation !== this.generationValue) return;
    this.closed = false;
  }
}
