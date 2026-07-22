import { useEffect, useState } from "react";

/** Ignore sub-second control flaps from SSE reconnect / grace release. */
const OBSERVING_STABLE_MS = 400;

export function SessionControlBanner({ observing, disabled = false, onTakeOver }: {
  observing: boolean;
  disabled?: boolean;
  onTakeOver: () => void;
}) {
  const [stableObserving, setStableObserving] = useState(false);

  useEffect(() => {
    if (!observing) {
      setStableObserving(false);
      return;
    }
    const timer = window.setTimeout(() => setStableObserving(true), OBSERVING_STABLE_MS);
    return () => window.clearTimeout(timer);
  }, [observing]);

  if (!stableObserving) return null;
  return <div className="session-control-banner" role="status">
    <span>此对话正在另一窗口中控制；当前为只读观察。</span>
    <button type="button" disabled={disabled} onClick={onTakeOver}>接管控制</button>
  </div>;
}
