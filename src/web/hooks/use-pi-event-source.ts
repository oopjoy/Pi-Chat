import { useEffect } from "react";

export function isIgnoredEventSourceFrame(data: unknown): boolean {
  if (typeof data !== "string") return false;
  // Pi tool updates carry cumulative partialResult snapshots. The UI only uses
  // start/end status, so parsing these frames is pure main-thread overhead.
  return /"type"\s*:\s*"([^"]+)"/.exec(data.slice(0, 256))?.[1] === "tool_execution_update";
}

export function isOversizedEventSourceFrame(data: unknown): data is string {
  return typeof data === "string" && data.length > 1_000_000;
}

export function shouldReconnectEventSource(eventType: string | undefined, visibilityState: DocumentVisibilityState, lastFrameAt: number, now: number): boolean {
  if (visibilityState === "hidden") return false;
  if (eventType === "visibilitychange" || eventType === "pageshow") return true;
  return now - lastFrameAt >= 45_000;
}

interface PiEventSourceHandlers {
  enabled: boolean;
  generation?: number;
  url: () => string;
  onReady(event: Event, source: EventSource): void;
  onPi(event: Event, source: EventSource): void;
  onError(source: EventSource): void;
  onOversized(source: EventSource, size: number): void;
}

export function usePiEventSource({ enabled, generation = 0, url, onReady, onPi, onError, onOversized }: PiEventSourceHandlers): void {
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(url());
    const ready = (event: Event) => onReady(event, source);
    const pi = (event: Event) => {
      const data = (event as MessageEvent<unknown>).data;
      if (isIgnoredEventSourceFrame(data)) return;
      if (isOversizedEventSourceFrame(data)) onOversized(source, data.length);
      else onPi(event, source);
    };
    source.addEventListener("ready", ready);
    source.addEventListener("pi", pi);
    source.onerror = () => onError(source);
    return () => {
      source.removeEventListener("ready", ready);
      source.removeEventListener("pi", pi);
      source.close();
    };
  }, [enabled, generation, onError, onOversized, onPi, onReady, url]);
}
