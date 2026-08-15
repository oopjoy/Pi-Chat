import { useCallback, useEffect, useRef } from "react";
import type { LiveMessageSchedulerOutcome } from "../lib/stream-observability";

/**
 * Throttle a coordinator-validated payload. The hook deliberately knows
 * nothing about Sessions; callers attach the authority token they need.
 */
export function useLiveMessageScheduler<T>(
  commitMessage: (message: T) => boolean | void,
  intervalMs = 50,
  observer?: (outcome: LiveMessageSchedulerOutcome, message: T) => void,
) {
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<T | null>(null);
  const lastCommitRef = useRef(0);
  const observerRef = useRef(observer);
  observerRef.current = observer;

  const observe = useCallback((outcome: LiveMessageSchedulerOutcome, message: T) => {
    try { observerRef.current?.(outcome, message); }
    catch { /* Diagnostics cannot perturb render scheduling. */ }
  }, []);

  const clear = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    const latest = pendingRef.current;
    timerRef.current = null;
    pendingRef.current = null;
    if (latest) observe("cleared", latest);
  }, [observe]);

  /**
   * Terminal events can arrive inside the 50 ms render throttle. Preserve the
   * newest cumulative snapshot instead of clearing the only thinking/tool-call
   * payload before it was painted.
   */
  const drain = useCallback((): T | null => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const latest = pendingRef.current;
    pendingRef.current = null;
    if (latest) {
      lastCommitRef.current = performance.now();
      observe("drained", latest);
    }
    return latest;
  }, [observe]);

  const schedule = useCallback((message: T) => {
    pendingRef.current = message;
    if (timerRef.current !== null) {
      observe("replaced", message);
      return;
    }
    const elapsed = performance.now() - lastCommitRef.current;
    const commit = () => {
      timerRef.current = null;
      const latest = pendingRef.current;
      pendingRef.current = null;
      if (!latest) return;
      lastCommitRef.current = performance.now();
      const accepted = commitMessage(latest);
      if (accepted !== false) observe("committed", latest);
    };
    if (elapsed >= intervalMs) commit();
    else {
      timerRef.current = window.setTimeout(commit, intervalMs - elapsed);
      observe("scheduled", message);
    }
  }, [commitMessage, intervalMs, observe]);

  useEffect(() => clear, [clear]);
  return { clearPendingLiveMessage: clear, drainPendingLiveMessage: drain, scheduleLiveMessage: schedule };
}
