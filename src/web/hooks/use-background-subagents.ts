import { useEffect, useState } from "react";
import type { BackgroundSubagentSnapshot } from "../../shared/types";
import { api } from "../api";

const EMPTY: BackgroundSubagentSnapshot = {
  total: 0,
  activeCount: 0,
  attentionCount: 0,
  truncated: false,
  steps: [],
};

/** Session-scoped read-only polling; navigation and unmount abort the old request. */
export function useBackgroundSubagents(sessionId: string): BackgroundSubagentSnapshot {
  const [snapshot, setSnapshot] = useState<BackgroundSubagentSnapshot>(EMPTY);

  useEffect(() => {
    setSnapshot(EMPTY);
    if (!/^[a-f0-9]{20}$/.test(sessionId)) return;
    let disposed = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;

    const schedule = () => {
      if (disposed) return;
      if (timer !== null) window.clearTimeout(timer);
      const delay = document.visibilityState === "hidden" ? 10_000 : 2_000;
      timer = window.setTimeout(() => {
        timer = null;
        void poll();
      }, delay);
    };
    const poll = async () => {
      if (disposed) return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const next = await api.backgroundSubagents(sessionId, current.signal);
        if (!disposed) setSnapshot(next);
      } catch (cause) {
        if (!disposed && !(cause instanceof DOMException && cause.name === "AbortError"))
          setSnapshot(EMPTY);
      } finally {
        if (!disposed && controller === current) schedule();
      }
    };
    const visibilityChanged = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.visibilityState !== "hidden") void poll();
      else schedule();
    };

    document.addEventListener("visibilitychange", visibilityChanged);
    schedule();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [sessionId]);

  return snapshot;
}
