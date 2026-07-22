import { useCallback, useEffect, useRef } from "react";
import type { PiMessage } from "../../shared/types";

export function useLiveMessageScheduler(commitMessage: (message: PiMessage) => void, intervalMs = 50) {
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<PiMessage | null>(null);
  const lastCommitRef = useRef(0);

  const clear = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
  }, []);

  const schedule = useCallback((message: PiMessage) => {
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
  return { clearPendingLiveMessage: clear, scheduleLiveMessage: schedule };
}
