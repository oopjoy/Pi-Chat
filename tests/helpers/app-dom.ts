import { afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { createFakeEventSource } from "./fake-event-source";

const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "HTMLElement",
  "HTMLTextAreaElement",
  "Event",
  "MouseEvent",
  "InputEvent",
  "KeyboardEvent",
  "File",
  "FileReader",
  "sessionStorage",
  "localStorage",
  "history",
  "location",
  "navigator",
  "EventSource",
  "IS_REACT_ACT_ENVIRONMENT",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

type GlobalKey = (typeof GLOBAL_KEYS)[number];
type DescriptorSnapshot = Map<GlobalKey, PropertyDescriptor | undefined>;

type AppDomFixture = {
  dom: JSDOM;
  FakeEventSource: ReturnType<typeof createFakeEventSource>;
  dispose(): void;
};

const activeFixtures = new Set<AppDomFixture>();

afterEach(() => {
  for (const fixture of [...activeFixtures]) fixture.dispose();
});

function snapshotGlobals(): DescriptorSnapshot {
  return new Map(
    GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
}

function restoreGlobals(snapshot: DescriptorSnapshot): void {
  for (const key of GLOBAL_KEYS) {
    const descriptor = snapshot.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}

export function installAppDom(): AppDomFixture {
  const snapshot = snapshotGlobals();
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "http://127.0.0.1:30170/" },
  );
  const FakeEventSource = createFakeEventSource(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    sessionStorage: dom.window.sessionStorage,
    localStorage: dom.window.localStorage,
    history: dom.window.history,
    location: dom.window.location,
    EventSource: FakeEventSource,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => undefined,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    configurable: true,
  });
  Object.defineProperty(dom.window.document, "hasFocus", {
    value: () => true,
    configurable: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", {
    value() {},
    configurable: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    value() {},
    configurable: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    value() {},
    configurable: true,
  });

  let disposed = false;
  const fixture: AppDomFixture = {
    dom,
    FakeEventSource,
    dispose() {
      if (disposed) return;
      disposed = true;
      activeFixtures.delete(fixture);
      for (const source of FakeEventSource.instances) source.close();
      FakeEventSource.instances.length = 0;
      dom.window.sessionStorage.clear();
      dom.window.localStorage.clear();
      dom.window.close();
      restoreGlobals(snapshot);
    },
  };
  activeFixtures.add(fixture);
  return fixture;
}
