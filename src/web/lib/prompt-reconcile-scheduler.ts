export interface PromptReconcileScheduler {
  set(callback: () => void, delayMs: number): number;
  clear(handle: number): void;
}

export const windowPromptReconcileScheduler: PromptReconcileScheduler = {
  set: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clear: (handle) => window.clearTimeout(handle),
};
