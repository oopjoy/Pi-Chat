import { useEffect } from "react";
import { isHighFrequencyStateDiagnosticEventType } from "../../shared/state-diagnostics";
import { recordBrowserStateDiagnostic } from "../lib/state-diagnostics";

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

export function diagnosticFrame(data: unknown): {
  eventType: string;
  sessionId?: string;
  runGeneration?: number;
  size: number;
} {
  if (typeof data !== "string") return { eventType: "unknown", size: 0 };
  const prefix = data.slice(0, 2_048);
  const eventType = /"type"\s*:\s*"([^"]{1,80})"/.exec(prefix)?.[1] || "unknown";
  if (isHighFrequencyStateDiagnosticEventType(eventType))
    return { eventType, size: data.length };
  const metadata = data.length > 2_048 ? `${prefix}\n${data.slice(-2_048)}` : prefix;
  const sessionId = [...metadata.matchAll(/"piChatSessionId"\s*:\s*"([a-f0-9]{20})"/g)].at(-1)?.[1];
  const runGenerationText = [...metadata.matchAll(/"piChatRunGeneration"\s*:\s*(\d{1,12})/g)].at(-1)?.[1];
  return {
    eventType,
    ...(sessionId ? { sessionId } : null),
    ...(runGenerationText ? { runGeneration: Number(runGenerationText) } : null),
    size: data.length,
  };
}

export function usePiEventSource({ enabled, generation = 0, url, onReady, onPi, onError, onOversized }: PiEventSourceHandlers): void {
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(url());
    const ready = (event: Event) => {
      const frame = diagnosticFrame((event as MessageEvent<unknown>).data);
      recordBrowserStateDiagnostic("sse", "received", {
        sessionId: frame.sessionId,
        runGeneration: frame.runGeneration,
        details: { channel: "ready", eventType: frame.eventType, size: frame.size },
      });
      onReady(event, source);
    };
    const pi = (event: Event) => {
      const data = (event as MessageEvent<unknown>).data;
      const frame = diagnosticFrame(data);
      if (!isHighFrequencyStateDiagnosticEventType(frame.eventType))
        recordBrowserStateDiagnostic("sse", "received", {
          sessionId: frame.sessionId,
          runGeneration: frame.runGeneration,
          details: { channel: "pi", eventType: frame.eventType, size: frame.size },
        });
      if (frame.eventType === "tool_execution_update") return;
      if (isOversizedEventSourceFrame(data)) onOversized(source, data.length);
      else onPi(event, source);
    };
    source.addEventListener("ready", ready);
    source.addEventListener("pi", pi);
    source.onerror = () => {
      recordBrowserStateDiagnostic("sse", "error", {
        details: { readyState: source.readyState },
      });
      onError(source);
    };
    return () => {
      source.removeEventListener("ready", ready);
      source.removeEventListener("pi", pi);
      source.close();
    };
  }, [enabled, generation, onError, onOversized, onPi, onReady, url]);
}
