import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { rememberedSessionId, rememberSessionId } from "../src/web/lib/session-location";

function installDom(standalone: boolean, url = "http://127.0.0.1:30170/") {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: standalone && query === "(display-mode: standalone)", media: query }),
  });
  return dom;
}

test("standalone PWA remembers Session without mutating its navigation URL", () => {
  const dom = installDom(true);
  let replaced = false;
  dom.window.history.replaceState = () => { replaced = true; };
  rememberSessionId("session-a");
  assert.equal(rememberedSessionId(), "session-a");
  assert.equal(dom.window.location.search, "");
  assert.equal(replaced, false);
});

test("ordinary browser keeps Session deep links in the URL", () => {
  const dom = installDom(false);
  rememberSessionId("session-b");
  assert.equal(dom.window.location.search, "?session=session-b");
  assert.equal(rememberedSessionId(), "session-b");
});
