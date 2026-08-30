import { JSDOM } from "jsdom";

export function installDialogDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    Event: dom.window.Event,
    InputEvent: dom.window.InputEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // React's legacy input-event fallback probes these IE hooks when JSDOM
  // auto-focuses an input that replaces a button inside the same dialog frame.
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
  });
  return dom;
}
