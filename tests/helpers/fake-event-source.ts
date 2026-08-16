import type { JSDOM } from "jsdom";

export function createFakeEventSource(dom: JSDOM) {
  return class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    static instances: FakeEventSource[] = [];

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = FakeEventSource.OPEN;
    onerror: ((event: Event) => void) | null = null;
    private listeners = new Map<string, Set<(event: Event) => void>>();

    constructor(readonly url: string | URL) {
      FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (event: Event) => void) {
      const listeners = this.listeners.get(type) || new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: Event) => void) {
      this.listeners.get(type)?.delete(listener);
    }

    close() {
      this.readyState = FakeEventSource.CLOSED;
      this.listeners.clear();
    }

    dispatchEvent(event: Event) {
      for (const listener of this.listeners.get(event.type) || []) listener(event);
      return true;
    }

    emitPi(payload: Record<string, unknown>) {
      const wirePayload = payload.type === "message_end"
        ? {
            piChatRunEpoch: "epoch-a",
            piChatRunGeneration: 1,
            ...payload,
          }
        : payload;
      this.dispatchEvent(
        new dom.window.MessageEvent("pi", { data: JSON.stringify(wirePayload) }) as unknown as Event,
      );
    }
  };
}
