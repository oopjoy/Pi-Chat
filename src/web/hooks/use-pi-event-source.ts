import { useEffect } from "react";

interface PiEventSourceHandlers {
  enabled: boolean;
  url: () => string;
  onReady(event: Event, source: EventSource): void;
  onPi(event: Event, source: EventSource): void;
  onError(source: EventSource): void;
}

export function usePiEventSource({ enabled, url, onReady, onPi, onError }: PiEventSourceHandlers): void {
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
  }, [enabled, onError, onPi, onReady, url]);
}
