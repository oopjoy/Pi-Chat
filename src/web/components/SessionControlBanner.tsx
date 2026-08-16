import { useEffect, useState } from "react";

/** Ignore sub-second control flaps from SSE reconnect / grace release. */
const OBSERVING_STABLE_MS = 400;

export function SessionControlBanner({ observing }: {
  observing: boolean;
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
    <span>此对话正在另一窗口中查看。</span>
  </div>;
}
