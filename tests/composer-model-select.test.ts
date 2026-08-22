import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ModelInfo } from "../src/shared/types";
import { ComposerModelSelect, groupComposerModels } from "../src/web/components/ComposerModelSelect";

const models: ModelInfo[] = [
  { provider: "cpa-proxy", id: "gpt-5.6-sol", name: "Sol", reasoning: true },
  { provider: "xwill", id: "gpt-5.6-terra", name: "Terra", reasoning: true },
  { provider: "cpa-proxy", id: "gpt-5.6-terra", name: "Terra CPA", reasoning: true },
];

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://127.0.0.1:30170/" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value() {},
  });
  return dom;
}

test("composer models are consolidated into stable provider groups", () => {
  assert.deepEqual(
    groupComposerModels(models).map((group) => [group.provider, group.models.map((model) => model.id)]),
    [
      ["cpa-proxy", ["gpt-5.6-sol", "gpt-5.6-terra"]],
      ["xwill", ["gpt-5.6-terra"]],
    ],
  );
});

test("composer model picker keeps provider rows outside option navigation and shows names only", async () => {
  const dom = installDom();
  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  const changes: Array<[string, string]> = [];
  try {
    await act(async () => {
      root.render(createElement(ComposerModelSelect, {
        value: models[0]!,
        models,
        onChange: (provider: string, id: string) => changes.push([provider, id]),
      }));
    });
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".composer-model-select .compact-select-trigger")!;
    await act(async () => trigger.click());

    const listbox = dom.window.document.querySelector<HTMLElement>(".composer-model-list[role='listbox']")!;
    assert.equal(dom.window.document.activeElement, listbox);
    assert.equal(dom.window.document.querySelector(".composer-model-search"), null);
    assert.equal(listbox.querySelectorAll("[role='group']").length, 2);
    assert.equal(listbox.querySelectorAll("[role='option']").length, 3);
    const providerRows = [...listbox.querySelectorAll<HTMLElement>(".composer-model-provider")];
    assert.deepEqual(providerRows.map((row) => row.dataset.provider), ["cpa-proxy", "xwill"]);
    assert.equal(listbox.querySelector(".composer-model-provider > i"), null);
    assert.equal(listbox.querySelector("small"), null);
    assert.deepEqual(
      [...listbox.querySelectorAll<HTMLElement>(".composer-model-option-name")].map((element) => element.textContent),
      ["Sol", "Terra CPA", "Terra"],
    );
    const modelOptions = [...listbox.querySelectorAll<HTMLElement>("[role='option']")];
    assert.deepEqual(modelOptions.map((option) => option.title), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-terra"]);
    assert.ok(modelOptions.every((option) => option.firstElementChild?.classList.contains("composer-model-option-name")));
    assert.ok(modelOptions.every((option) => option.lastElementChild?.classList.contains("compact-select-check")));
    assert.ok(modelOptions[0]!.lastElementChild?.querySelector("svg"));

    const xwillOption = listbox.querySelectorAll<HTMLElement>("[role='group']")[1]!.querySelector<HTMLElement>("[role='option']")!;
    await act(async () => xwillOption.click());
    assert.deepEqual(changes, [["xwill", "gpt-5.6-terra"]]);
    assert.equal(dom.window.document.querySelector(".composer-model-popover"), null);
    assert.equal(dom.window.document.activeElement, trigger);
  } finally {
    await act(async () => root.unmount());
  }
});

test("composer model picker CSS keeps a compact bounded list without search or provider decoration", () => {
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.composer-model-list\s*{[^}]*max-height:\s*min\(320px,\s*60dvh\)[^}]*overflow-y:\s*auto[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(css, /\.composer-model-list::-webkit-scrollbar\s*{/);
  assert.doesNotMatch(css, /\.composer-model-search/);
  assert.doesNotMatch(css, /\.composer-model-provider\[data-tone=/);
  assert.doesNotMatch(css, /\.composer-model-provider\s*>\s*i/);
  assert.match(css, /\.composer-controls \.composer-model-popover\s*{[^}]*width:\s*min\(192px,[^}]*max-width:\s*min\(192px,/s);
  assert.match(css, /\.composer-model-provider\s*{[^}]*background:\s*color-mix\(in srgb,\s*var\(--status-green\),\s*white 82%\)[^}]*color:\s*#16251b[^}]*font-weight:\s*750/s);
  assert.match(css, /\.composer-controls \.composer-model-option\s*{[^}]*min-height:\s*32px[^}]*padding:\s*5px 7px 5px 15px/s);
  assert.match(css, /\.composer-model-option-name\s*{[^}]*flex:\s*1[^}]*text-align:\s*left/s);
  assert.match(css, /\.composer-model-option \.compact-select-check\s*{[^}]*margin-left:\s*auto/s);
});
