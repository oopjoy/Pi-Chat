import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SessionForkBanner } from "../src/web/components/SessionForkBanner";

function renderBanner(sourceAvailable: boolean, onOpenSource = () => undefined) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  return {
    dom,
    root,
    render: () => root.render(createElement(SessionForkBanner, {
      origin: {
        sourceSessionId: "aaaaaaaaaaaaaaaaaaaa",
        sourceName: "Original conversation",
        sourcePersistedMessageId: "user-1:0",
        createdAt: 1,
        sourceAvailable,
      },
      onOpenSource,
    })),
  };
}

test("Fork provenance links back to an available source", async () => {
  let opens = 0;
  const view = renderBanner(true, () => { opens += 1; });
  try {
    await act(async () => view.render());
    assert.match(view.dom.window.document.body.textContent || "", /Original conversation/);
    await act(async () => view.dom.window.document.querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(opens, 1);
  } finally {
    await act(async () => view.root.unmount());
  }
});

test("Fork provenance fails closed when its source no longer exists", async () => {
  const view = renderBanner(false);
  try {
    await act(async () => view.render());
    assert.match(view.dom.window.document.body.textContent || "", /原对话已不存在/);
    assert.equal(view.dom.window.document.querySelector("button"), null);
  } finally {
    await act(async () => view.root.unmount());
  }
});
