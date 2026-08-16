import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ChatInput } from "../src/web/components/ChatInput";
import { installAppDom } from "./helpers/app-dom";

function chatInputProps(onError: (message: string) => void) {
  return {
    streaming: false,
    stopping: false,
    disabled: false,
    acceptsImages: true,
    submissionScope: "session:attachment-limit",
    commands: [],
    onSend: async () => {},
    onAbort: async () => {},
    onPickLocalFiles: async () => [],
    onReadClipboardFiles: async () => [],
    onError,
  };
}

test("ChatInput accepts ten images and rejects the eleventh without losing the first ten", async () => {
  const { dom } = installAppDom();
  Object.assign(globalThis, { FileReader: dom.window.FileReader });
  const errors: string[] = [];
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(
      ChatInput,
      chatInputProps((message) => errors.push(message)),
    )));
    const fileInput = dom.window.document.querySelector<HTMLInputElement>("input[type='file']")!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: Array.from({ length: 10 }, (_, index) => new dom.window.File(
        [`image-${index}`],
        `${index + 1}.png`,
        { type: "image/png" },
      )),
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 500;
      while (
        dom.window.document.querySelectorAll(".image-preview").length !== 10 &&
        Date.now() < deadline
      ) await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    assert.equal(dom.window.document.querySelectorAll(".image-preview").length, 10);
    assert.deepEqual(errors, []);

    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new dom.window.File(["eleventh"], "11.png", { type: "image/png" })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(dom.window.document.querySelectorAll(".image-preview").length, 10);
    assert.match(errors.at(-1) || "", /一次最多添加 10 张图片/);

    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.click();
    });
    const imageMenuItem = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".attachment-menu [role='menuitem']",
    )].find((item) => item.textContent?.includes("图片"))!;
    assert.equal(imageMenuItem.disabled, true);
    assert.match(imageMenuItem.textContent || "", /最多 10 张，单张 8 MB \/ 总计 40 MB/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("overlapping image additions recheck the latest attachment count before commit", async () => {
  const { dom } = installAppDom();
  Object.assign(globalThis, { FileReader: dom.window.FileReader });
  const errors: string[] = [];
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(
      ChatInput,
      chatInputProps((message) => errors.push(message)),
    )));
    const fileInput = dom.window.document.querySelector<HTMLInputElement>("input[type='file']")!;
    const batch = (prefix: string) => Array.from({ length: 6 }, (_, index) =>
      new dom.window.File([`${prefix}-${index}`], `${prefix}-${index}.png`, { type: "image/png" }));
    await act(async () => {
      Object.defineProperty(fileInput, "files", { configurable: true, value: batch("first") });
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      Object.defineProperty(fileInput, "files", { configurable: true, value: batch("second") });
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 500;
      while (
        dom.window.document.querySelectorAll(".image-preview").length < 6 &&
        Date.now() < deadline
      ) await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 20));
    });
    assert.equal(dom.window.document.querySelectorAll(".image-preview").length, 6);
    assert.match(errors.at(-1) || "", /一次最多添加 10 张图片/);
  } finally {
    await act(async () => root.unmount());
  }
});
