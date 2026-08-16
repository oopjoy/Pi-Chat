import { useCallback, useEffect, useRef } from "react";
import type { LiveMessageSchedulerOutcome } from "../lib/stream-observability";

export type LiveMessageSchedulePolicy =
  | number
  | Readonly<{ mode: "animation-frame" }>;

type ScheduledHandle =
  | { kind: "timeout"; id: number }
  | { kind: "animation-frame"; id: number };

/**
 * Throttle a coordinator-validated payload. The hook deliberately knows
 * nothing about Sessions; callers attach the authority token they need.
 */
export function useLiveMessageScheduler<T>(
  commitMessage: (message: T) => boolean | void,
  policy: LiveMessageSchedulePolicy = 50,
  observer?: (outcome: LiveMessageSchedulerOutcome, message: T) => void,
) {
  const handleRef = useRef<ScheduledHandle | null>(null);
  const pendingRef = useRef<T | null>(null);
  const hasPendingRef = useRef(false);
  const lastCommitRef = useRef(0);
  const observerRef = useRef(observer);
  observerRef.current = observer;
  const animationFrameMode = typeof policy !== "number";
  const intervalMs = typeof policy === "number" ? Math.max(0, policy) : 0;

  const observe = useCallback((outcome: LiveMessageSchedulerOutcome, message: T) => {
    try { observerRef.current?.(outcome, message); }
    catch { /* Diagnostics cannot perturb render scheduling. */ }
  }, []);

  const cancelScheduled = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    if (handle.kind === "timeout") window.clearTimeout(handle.id);
    else window.cancelAnimationFrame(handle.id);
    handleRef.current = null;
  }, []);

  const takePending = useCallback((): T | null => {
    if (!hasPendingRef.current) return null;
    const latest = pendingRef.current as T;
    pendingRef.current = null;
    hasPendingRef.current = false;
    return latest;
  }, []);

  const clear = useCallback(() => {
    cancelScheduled();
    const hadPending = hasPendingRef.current;
    const latest = takePending();
    if (hadPending) observe("cleared", latest as T);
  }, [cancelScheduled, observe, takePending]);

  /**
   * Terminal events can arrive inside the render throttle. Preserve the newest
   * cumulative snapshot instead of clearing the only thinking/tool-call payload
   * before it was painted.
   */
  const drain = useCallback((): T | null => {
    cancelScheduled();
    const hadPending = hasPendingRef.current;
    const latest = takePending();
    if (hadPending) {
      lastCommitRef.current = performance.now();
      observe("drained", latest as T);
    }
    return latest;
  }, [cancelScheduled, observe, takePending]);

  const schedule = useCallback((message: T) => {
    pendingRef.current = message;
    hasPendingRef.current = true;
    if (handleRef.current !== null) {
      observe("replaced", message);
      return;
    }

    const commit = () => {
      handleRef.current = null;
      const hadPending = hasPendingRef.current;
      const latest = takePending();
      if (!hadPending) return;
      lastCommitRef.current = performance.now();
      const accepted = commitMessage(latest as T);
      if (accepted !== false) observe("committed", latest as T);
    };

    if (animationFrameMode) {
      handleRef.current = {
        kind: "animation-frame",
        id: window.requestAnimationFrame(commit),
      };
      observe("scheduled", message);
      return;
    }

    const elapsed = performance.now() - lastCommitRef.current;
    if (elapsed >= intervalMs) commit();
    else {
      handleRef.current = {
        kind: "timeout",
        id: window.setTimeout(commit, intervalMs - elapsed),
      };
      observe("scheduled", message);
    }
  }, [animationFrameMode, commitMessage, intervalMs, observe, takePending]);

  useEffect(() => clear, [clear]);
  return {
    clearPendingLiveMessage: clear,
    drainPendingLiveMessage: drain,
    scheduleLiveMessage: schedule,
  };
}
