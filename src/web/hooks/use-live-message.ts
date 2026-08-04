import { useCallback, useEffect, useRef } from "react";

/**
 * Throttle a coordinator-validated payload. The hook deliberately knows
 * nothing about Sessions; callers attach the authority token they need.
 */
export function useLiveMessageScheduler<T>(commitMessage: (message: T) => void, intervalMs = 50) {
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<T | null>(null);
  const lastCommitRef = useRef(0);

  const clear = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
  }, []);

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
    if (latest) lastCommitRef.current = performance.now();
    return latest;
  }, []);

  const schedule = useCallback((message: T) => {
    pendingRef.current = message;
    if (timerRef.current !== null) return;
    const elapsed = performance.now() - lastCommitRef.current;
    const commit = () => {
      timerRef.current = null;
      const latest = pendingRef.current;
      pendingRef.current = null;
      if (!latest) return;
      lastCommitRef.current = performance.now();
      commitMessage(latest);
    };
    if (elapsed >= intervalMs) commit();
    else timerRef.current = window.setTimeout(commit, intervalMs - elapsed);
  }, [commitMessage, intervalMs]);

  useEffect(() => clear, [clear]);
  return { clearPendingLiveMessage: clear, drainPendingLiveMessage: drain, scheduleLiveMessage: schedule };
}
