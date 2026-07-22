import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { CompactSelect, findCompactSelectTypeaheadIndex, getCompactSelectNavigationIndex } from "../src/web/components/CompactSelect";

const options = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
  { value: "bravo", label: "Bravo" },
  { value: "charlie", label: "Charlie" },
] as const;

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div><button id='outside'>Outside</button></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  return dom;
}

async function renderSelect(disabled = false) {
  const dom = installDom();
  const container = dom.window.document.querySelector<HTMLElement>("#root")!;
  const root: Root = createRoot(container);
  const changes: string[] = [];
  await act(async () => {
    root.render(createElement(CompactSelect, {
      value: "beta",
      options: [...options],
      disabled,
      ariaLabel: "Test choice",
      onChange: (value: string) => changes.push(value),
    }));
  });
  return { dom, root, changes };
}

function key(dom: JSDOM, element: Element, value: string) {
  element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true }));
}

test("CompactSelect forced-colors styles keep focus and active option visible", async () => {
  const css = await readFile(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /\.compact-select-trigger:focus-visible[\s\S]*outline:/);
  assert.match(css, /\.compact-select-option\.is-active[\s\S]*outline:/);
});

test("CompactSelect navigation helpers handle boundaries and typeahead wrapping", () => {
  assert.equal(getCompactSelectNavigationIndex("ArrowDown", 1, 4), 2);
  assert.equal(getCompactSelectNavigationIndex("ArrowDown", 3, 4), 3);
  assert.equal(getCompactSelectNavigationIndex("ArrowUp", 0, 4), 0);
  assert.equal(getCompactSelectNavigationIndex("Home", 2, 4), 0);
  assert.equal(getCompactSelectNavigationIndex("End", 1, 4), 3);
  assert.equal(getCompactSelectNavigationIndex("Enter", 1, 4), null);
  assert.equal(getCompactSelectNavigationIndex("ArrowDown", 0, 0), null);
  assert.equal(findCompactSelectTypeaheadIndex(options.map((option) => option.label), 1, "br"), 2);
  assert.equal(findCompactSelectTypeaheadIndex(options.map((option) => option.label), 3, "b"), 1);
  assert.equal(findCompactSelectTypeaheadIndex(options.map((option) => option.label), 0, "missing"), null);
});

test("CompactSelect opens on the selected option and supports keyboard selection", async () => {
  const { dom, root, changes } = await renderSelect();
  const trigger = dom.window.document.querySelector<HTMLButtonElement>(".compact-select-trigger")!;

  await act(async () => key(dom, trigger, "ArrowDown"));
  const listbox = dom.window.document.querySelector<HTMLElement>("[role='listbox']")!;
  assert.equal(dom.window.document.activeElement, listbox);
  assert.equal(listbox.getAttribute("aria-activedescendant"), dom.window.document.querySelector("[aria-selected='true']")?.id);
  assert.equal(dom.window.document.querySelectorAll("button[role='option']").length, 0);
  assert.equal(dom.window.document.querySelectorAll("[role='option']").length, options.length);

  await act(async () => key(dom, listbox, "End"));
  assert.match(listbox.getAttribute("aria-activedescendant") || "", /option-3$/);
  await act(async () => key(dom, listbox, "Enter"));
  assert.deepEqual(changes, ["charlie"]);
  assert.equal(dom.window.document.querySelector("[role='listbox']"), null);
  assert.equal(dom.window.document.activeElement, trigger);

  await act(async () => root.unmount());
});

test("CompactSelect typeahead, Escape, outside click, and disabled state close coherently", async () => {
  const { dom, root } = await renderSelect();
  const trigger = dom.window.document.querySelector<HTMLButtonElement>(".compact-select-trigger")!;

  await act(async () => trigger.click());
  let listbox = dom.window.document.querySelector<HTMLElement>("[role='listbox']")!;
  await act(async () => key(dom, listbox, "c"));
  assert.match(listbox.getAttribute("aria-activedescendant") || "", /option-3$/);
  await act(async () => key(dom, listbox, "Escape"));
  assert.equal(dom.window.document.querySelector("[role='listbox']"), null);
  assert.equal(dom.window.document.activeElement, trigger);

  await act(async () => trigger.click());
  await act(async () => dom.window.document.querySelector("#outside")!.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true })));
  assert.equal(dom.window.document.querySelector("[role='listbox']"), null);

  await act(async () => trigger.click());
  await act(async () => {
    root.render(createElement(CompactSelect, {
      value: "beta",
      options: [...options],
      disabled: true,
      ariaLabel: "Test choice",
      onChange: () => undefined,
    }));
  });
  assert.equal(dom.window.document.querySelector("[role='listbox']"), null);
  assert.equal(trigger.disabled, true);

  await act(async () => root.unmount());
});
