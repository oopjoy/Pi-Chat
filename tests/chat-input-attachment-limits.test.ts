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

test("Escape closes the attachment menu and restores focus to its trigger", async () => {
  const { dom } = installAppDom();
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(
      ChatInput,
      chatInputProps(() => {}),
    )));
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!;
    await act(async () => trigger.click());
    assert.ok(dom.window.document.querySelector(".attachment-menu"));
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0));
    });
    assert.equal(dom.window.document.querySelector(".attachment-menu"), null);
    assert.equal(dom.window.document.activeElement, trigger);
  } finally {
    await act(async () => root.unmount());
  }
});

test("Explorer path paste inserts at the caret without blank lines or newlines", async () => {
  const { dom } = installAppDom();
  let fallbackReads = 0;
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    const draftKey = { kind: "session" as const, sessionId: "attachment-limit" };
    await act(async () => root.render(createElement(
      ChatInput,
      {
        ...chatInputProps(() => {}),
        draftKey,
        restoredDraft: {
          key: draftKey,
          revision: 1,
          expectedDraftRevision: 0,
          message: "前缀后缀",
          images: [],
        },
      },
    )));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => Promise.resolve());
    textarea.setSelectionRange(2, 2);
    const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [],
        types: ["text/uri-list", "text/plain"],
        getData: (type: string) => type === "text/uri-list"
          ? "# Windows URI list\r\nfile:///C:/Users/me/My%20Notes/paper.pdf"
          : "C:\\Users\\me\\My Notes\\paper.pdf",
      },
    });
    await act(async () => {
      textarea.dispatchEvent(event);
      await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0));
    });
    const reference = '"C:\\Users\\me\\My Notes\\paper.pdf"';
    assert.equal(textarea.value, `前缀${reference}后缀`);
    assert.equal(textarea.value.includes("\n"), false);
    assert.equal(textarea.selectionStart, 2 + reference.length);
    assert.equal(textarea.selectionEnd, 2 + reference.length);
    assert.equal(fallbackReads, 0);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a file-only clipboard paste does not read a mutable process clipboard", async () => {
  const { dom } = installAppDom();
  let fallbackReads = 0;
  const errors: string[] = [];
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const props = {
    ...chatInputProps((message) => errors.push(message)),
    draftKey: { kind: "session" as const, sessionId: "session-a" },
    submissionScope: "session:session-a",
  };
  try {
    await act(async () => root.render(createElement(ChatInput, props)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [{ kind: "file", getAsFile: () => new dom.window.File([""], "delayed.txt") }],
        types: ["Files"],
        getData: () => "",
      },
    });
    await act(async () => textarea.dispatchEvent(event));
    assert.equal(fallbackReads, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /无法取得文件的本地路径/);
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
