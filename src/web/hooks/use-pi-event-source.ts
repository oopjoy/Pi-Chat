import { useEffect } from "react";

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
}

export function usePiEventSource({ enabled, generation = 0, url, onReady, onPi, onError }: PiEventSourceHandlers): void {
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(url());
    const ready = (event: Event) => onReady(event, source);
    const pi = (event: Event) => onPi(event, source);
    source.addEventListener("ready", ready);
    source.addEventListener("pi", pi);
    source.onerror = () => onError(source);
    return () => {
      source.removeEventListener("ready", ready);
      source.removeEventListener("pi", pi);
      source.close();
    };
  }, [enabled, generation, onError, onPi, onReady, url]);
}
