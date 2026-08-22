import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PendingSteers } from "../src/web/components/PendingSteers";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return dom;
}

test("PendingSteers exposes one native Alt+Up-style dequeue action", async () => {
  const dom = installDom();
  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  let dequeues = 0;
  await act(async () => {
    root.render(createElement(PendingSteers, {
      items: [
        { id: "11111111-1111-4111-8111-111111111111", message: "first", imageCount: 0, createdAt: 1 },
        { id: "22222222-2222-4222-8222-222222222222", message: "second", imageCount: 0, createdAt: 2 },
      ],
      onDequeue: () => { dequeues += 1; },
    }));
  });
  const button = dom.window.document.querySelector<HTMLButtonElement>(".pending-steers header button")!;
  assert.equal(button.textContent, "撤回全部");
  await act(async () => button.click());
  assert.equal(dequeues, 1);

  await act(async () => {
    root.render(createElement(PendingSteers, {
      items: [{ id: "11111111-1111-4111-8111-111111111111", message: "first", imageCount: 0, createdAt: 1 }],
      dequeueing: true,
      onDequeue: () => { dequeues += 1; },
    }));
  });
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "撤回中…");
  await act(async () => root.unmount());
  dom.window.close();
});
