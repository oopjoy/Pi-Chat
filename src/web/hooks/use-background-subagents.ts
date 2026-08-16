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

export const SUBAGENT_DISCOVERY_POLL_MS = 500;
export const SUBAGENT_ACTIVE_POLL_MS = 750;
export const SUBAGENT_IDLE_POLL_MS = 2_000;
export const SUBAGENT_HIDDEN_POLL_MS = 10_000;
const FAST_EMPTY_POLLS = 10;

type ScopedSnapshot = {
  sessionId: string;
  value: BackgroundSubagentSnapshot;
};

/** Session-scoped read-only polling; navigation and unmount abort the old request. */
export function useBackgroundSubagents(sessionId: string): BackgroundSubagentSnapshot {
  const [snapshot, setSnapshot] = useState<ScopedSnapshot>({ sessionId: "", value: EMPTY });

  useEffect(() => {
    setSnapshot({ sessionId, value: EMPTY });
    if (!/^[a-f0-9]{20}$/.test(sessionId)) return;
    let disposed = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    let emptyPolls = 0;
    let latest = EMPTY;

    const delay = () => {
      if (document.visibilityState === "hidden") return SUBAGENT_HIDDEN_POLL_MS;
      if (latest.activeCount > 0 || latest.attentionCount > 0)
        return SUBAGENT_ACTIVE_POLL_MS;
      if (latest.total > 0) return SUBAGENT_IDLE_POLL_MS;
      return emptyPolls < FAST_EMPTY_POLLS
        ? SUBAGENT_DISCOVERY_POLL_MS
        : SUBAGENT_IDLE_POLL_MS;
    };
    const schedule = () => {
      if (disposed) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void poll();
      }, delay());
    };
    const poll = async () => {
      if (disposed) return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const next = await api.backgroundSubagents(sessionId, current.signal);
        if (!disposed && controller === current && !current.signal.aborted) {
          latest = next;
          emptyPolls = next.total > 0 ? 0 : emptyPolls + 1;
          setSnapshot({ sessionId, value: next });
        }
      } catch (cause) {
        // Preserve the last authoritative rows through transient transport or
        // filesystem failures; disappearance requires a successful empty pull.
        if (!disposed && cause instanceof DOMException && cause.name === "AbortError")
          return;
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
    void poll();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [sessionId]);

  return snapshot.sessionId === sessionId ? snapshot.value : EMPTY;
}
