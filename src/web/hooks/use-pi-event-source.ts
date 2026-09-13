import { useEffect, useRef } from "react";
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
  // App event handlers intentionally depend on pane/application state and may
  // change on every streamed frame. Keep the transport listener stable so a
  // React commit cannot close/reopen EventSource between two adjacent frames.
  // The generation/enabled/url effect below remains the only reconnection
  // authority; handler refs only select the newest callback.
  const handlersRef = useRef({ onReady, onPi, onError, onOversized });
  handlersRef.current = { onReady, onPi, onError, onOversized };

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(url());
    let active = true;
    // Browsers may deliver several error tasks while one EventSource is
    // transitioning to CLOSED. The App replaces the source once; duplicate
    // callbacks otherwise repeat the visible "connection lost" error and can
    // start redundant recovery work.
    let errorHandled = false;
    const ready = (event: Event) => {
      if (!active) return;
      const frame = diagnosticFrame((event as MessageEvent<unknown>).data);
      recordBrowserStateDiagnostic("sse", "received", {
        sessionId: frame.sessionId,
        runGeneration: frame.runGeneration,
        details: { channel: "ready", eventType: frame.eventType, size: frame.size },
      });
      handlersRef.current.onReady(event, source);
    };
    const pi = (event: Event) => {
      if (!active) return;
      const data = (event as MessageEvent<unknown>).data;
      const frame = diagnosticFrame(data);
      if (!isHighFrequencyStateDiagnosticEventType(frame.eventType))
        recordBrowserStateDiagnostic("sse", "received", {
          sessionId: frame.sessionId,
          runGeneration: frame.runGeneration,
          details: { channel: "pi", eventType: frame.eventType, size: frame.size },
        });
      if (frame.eventType === "tool_execution_update") return;
      if (isOversizedEventSourceFrame(data)) handlersRef.current.onOversized(source, data.length);
      else handlersRef.current.onPi(event, source);
    };
    source.addEventListener("ready", ready);
    source.addEventListener("pi", pi);
    source.onerror = () => {
      if (!active || errorHandled) return;
      errorHandled = true;
      recordBrowserStateDiagnostic("sse", "error", {
        details: { readyState: source.readyState },
      });
      handlersRef.current.onError(source);
    };
    return () => {
      active = false;
      source.removeEventListener("ready", ready);
      source.removeEventListener("pi", pi);
      source.onerror = null;
      source.close();
    };
  }, [enabled, generation, url]);
}
