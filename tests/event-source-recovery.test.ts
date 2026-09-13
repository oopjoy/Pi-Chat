import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { diagnosticFrame, isIgnoredEventSourceFrame, isOversizedEventSourceFrame, shouldReconnectEventSource, usePiEventSource } from "../src/web/hooks/use-pi-event-source";
import { installAppDom } from "./helpers/app-dom";

test("standalone PWA resume replaces a potentially half-open EventSource", () => {
  const now = 100_000;
  assert.equal(shouldReconnectEventSource("visibilitychange", "visible", now - 1_000, now), true);
  assert.equal(shouldReconnectEventSource("pageshow", "visible", now - 1_000, now), true);
  assert.equal(shouldReconnectEventSource("visibilitychange", "hidden", now - 100_000, now), false);
});

test("foreground watchdog reconnects only after a missed heartbeat window", () => {
  const now = 100_000;
  assert.equal(shouldReconnectEventSource(undefined, "visible", now - 44_999, now), false);
  assert.equal(shouldReconnectEventSource(undefined, "visible", now - 45_000, now), true);
  assert.equal(shouldReconnectEventSource("focus", "visible", now - 60_000, now), true);
  assert.equal(shouldReconnectEventSource("online", "hidden", now - 60_000, now), false);
});

test("cumulative tool snapshots are rejected before JSON parsing and huge unknown frames trigger recovery", () => {
  const toolUpdate = JSON.stringify({ type: "tool_execution_update", partialResult: { content: "x".repeat(100_000) } });
  assert.equal(isIgnoredEventSourceFrame(toolUpdate), true);
  assert.equal(isIgnoredEventSourceFrame(JSON.stringify({ type: "message_update", message: { role: "assistant", content: "mentions tool_execution_update" } })), false);
  assert.equal(isOversizedEventSourceFrame("x".repeat(1_000_001)), true);
  assert.equal(isOversizedEventSourceFrame("x".repeat(1_000_000)), false);
});

test("an EventSource from an earlier generation cannot deliver queued callbacks after replacement", async () => {
  const { dom } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  type Listener = (event: Event) => void;
  class LateEventSource {
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    static instances: LateEventSource[] = [];
    readonly readyState = LateEventSource.OPEN;
    onerror: ((event: Event) => void) | null = null;
    private readonly listeners = new Map<string, Set<Listener>>();

    constructor(readonly url: string) { LateEventSource.instances.push(this); }
    addEventListener(type: string, listener: Listener): void {
      const current = this.listeners.get(type) || new Set<Listener>();
      current.add(listener);
      this.listeners.set(type, current);
    }
    // Deliberately retain listeners: this models callbacks already queued by a
    // browser task when cleanup closes the old connection.
    removeEventListener(): void {}
    close(): void {}
    emit(type: string, data: unknown): void {
      const event = new dom.window.MessageEvent(type, { data: JSON.stringify(data) }) as unknown as Event;
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  }
  Object.assign(globalThis, { EventSource: LateEventSource });
  const readySources: unknown[] = [];
  const piSources: unknown[] = [];
  const errors: unknown[] = [];
  const oversized: unknown[] = [];
  const url = () => "/api/events";
  const onReady = (_event: Event, source: EventSource) => readySources.push(source);
  const onPi = (_event: Event, source: EventSource) => piSources.push(source);
  const onError = (source: EventSource) => errors.push(source);
  const onOversized = (source: EventSource) => oversized.push(source);
  function Probe({ generation }: { generation: number }) {
    usePiEventSource({
      enabled: true,
      generation,
      url,
      onReady,
      onPi,
      onError,
      onOversized,
    });
    return null;
  }
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(Probe, { generation: 1 })));
    const first = LateEventSource.instances[0];
    assert.ok(first);
    const firstError = first.onerror;
    await act(async () => root.render(createElement(Probe, { generation: 2 })));
    const second = LateEventSource.instances[1];
    assert.ok(second);

    first.emit("ready", { type: "ready" });
    first.emit("pi", { type: "agent_start" });
    firstError?.(new dom.window.Event("error") as unknown as Event);
    assert.deepEqual(readySources, []);
    assert.deepEqual(piSources, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(oversized, []);

    second.emit("ready", { type: "ready" });
    second.emit("pi", { type: "agent_start" });
    second.onerror?.(new dom.window.Event("error") as unknown as Event);
    second.onerror?.(new dom.window.Event("error") as unknown as Event);
    assert.equal(errors.length, 1, "one EventSource reports one recovery error");
    assert.equal(readySources.length, 1);
    assert.equal(piSources.length, 1);
  } finally {
    await act(async () => root.unmount());
  }
});

test("handler updates do not recreate EventSource or drop adjacent frames", async () => {
  const { dom, FakeEventSource } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const received: string[] = [];
  const url = () => "/api/events";
  function Probe({ version }: { version: number }) {
    usePiEventSource({
      enabled: true,
      generation: 1,
      url,
      onReady: () => undefined,
      onPi: () => received.push(`v${version}`),
      onError: () => undefined,
      onOversized: () => undefined,
    });
    return null;
  }
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(Probe, { version: 1 })));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => root.render(createElement(Probe, { version: 2 })));
    assert.equal(FakeEventSource.instances.length, 1);
    source.emitPi({ type: "message_update", message: { role: "assistant", content: "one" } });
    source.emitPi({ type: "message_update", message: { role: "assistant", content: "two" } });
    assert.deepEqual(received, ["v2", "v2"]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("large terminal frames retain appended Session diagnostic metadata", () => {
  const frame = diagnosticFrame(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: "x".repeat(8_000),
      piChatSessionId: "fedcba9876543210abcd",
      piChatRunGeneration: 999,
    },
    piChatSessionId: "0123456789abcdefabcd",
    piChatRunEpoch: "run",
    piChatRunGeneration: 17,
  }));
  assert.equal(frame.eventType, "message_end");
  assert.equal(frame.sessionId, "0123456789abcdefabcd");
  assert.equal(frame.runGeneration, 17);
});
