import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, StrictMode } from "react";
import { installAppDom } from "../helpers/app-dom";

test("ChatInput waits for in-flight dropped staging before sending the same draft", async () => {
  const { dom } = installAppDom();
  class ImmediateFileReader {
    result = "data:application/octet-stream;base64,bG9nLWJvZHk=";
    onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
    onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
    readAsDataURL() { this.onload?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>); }
  }
  Object.defineProperty(dom.window, "FileReader", { configurable: true, writable: true, value: ImmediateFileReader });
  Object.defineProperty(globalThis, "FileReader", { configurable: true, writable: true, value: ImmediateFileReader });
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const sent: string[] = [];
  let resolveStage: ((path: string) => void) | undefined;
  const stageStarted = Promise.withResolvers<void>();
  const discarded: string[] = [];
  const render = () => createElement(ChatInput, {
    streaming: false,
    stopping: false,
    disabled: false,
    submissionScope: "session:drop-wait",
    allowFollowupSubmissions: true,
    acceptsImages: true,
    commands: [],
    onSend: async (message: string) => { sent.push(message); },
    onAbort: async () => undefined,
    onPickLocalFiles: async () => [],
    onStageDroppedFile: async () => {
      stageStarted.resolve();
      return await new Promise<string>((resolve) => { resolveStage = resolve; });
    },
    onDiscardStagedFile: async (path: string) => { discarded.push(path); },
    onError: () => undefined,
  });
  try {
    await act(async () => root.render(createElement(StrictMode, null, render())));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    const composer = dom.window.document.querySelector<HTMLDivElement>(".composer")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "阅读这个文件");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "阅读这个文件" }));
    });
    const file = new dom.window.File(["log-body"], "note.log", { type: "text/plain" });
    const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        files: [file],
        items: [{ type: file.type, kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }) }],
        types: ["Files"],
        getData: () => "",
      },
    });
    await act(async () => {
      composer.dispatchEvent(drop);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await stageStarted.promise;
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
    });
    assert.deepEqual(sent, []);
    await act(async () => {
      resolveStage?.("C:\\Users\\me\\note.log");
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /阅读这个文件/);
    assert.match(sent[0], /C:\\Users\\me\\note\.log/);
    assert.deepEqual(discarded, []);
  } finally {
    await act(async () => root.unmount());
  }
});

test("ChatInput attaches a dropped Explorer folder from the current selection", async () => {
  const { dom } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const render = () => createElement(ChatInput, {
    streaming: false,
    stopping: false,
    disabled: false,
    submissionScope: "session:drop-folder",
    allowFollowupSubmissions: true,
    acceptsImages: true,
    commands: [],
    onSend: async () => undefined,
    onAbort: async () => undefined,
    onPickLocalFiles: async () => [],
    onReadExplorerSelection: async (names: string[]) => names[0] === "proj" ? ["C:\\Users\\me\\proj"] : [],
    onAttachmentKinds: async () => [{ path: "C:\\Users\\me\\proj", kind: "directory" as const }],
    onError: (message: string) => { throw new Error(message); },
  });
  try {
    await act(async () => root.render(createElement(StrictMode, null, render())));
    const composer = dom.window.document.querySelector<HTMLDivElement>(".composer")!;
    const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        files: [],
        items: [{ kind: "file", type: "", webkitGetAsEntry: () => ({ isDirectory: true, name: "proj" }), getAsString: (done: (value: string) => void) => done("") }],
        types: ["Files"],
        getData: () => "",
      },
    });
    await act(async () => {
      composer.dispatchEvent(drop);
      const deadline = Date.now() + 2_000;
      while (!dom.window.document.querySelector(".composer-attachment.is-folder") && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.ok(dom.window.document.querySelector(".composer-attachment.is-folder"), "the folder drop should render a folder card");
    assert.equal(dom.window.document.querySelector(".composer-attachment-kind")?.textContent, "文件夹");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a dropped file uses its own bytes instead of guessing a path from Explorer", async () => {
  const { dom } = installAppDom();
  class ImmediateFileReader {
    result = "data:application/octet-stream;base64,cmVwb3J0";
    onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
    onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
    readAsDataURL() { this.onload?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>); }
  }
  Object.defineProperty(dom.window, "FileReader", { configurable: true, writable: true, value: ImmediateFileReader });
  Object.defineProperty(globalThis, "FileReader", { configurable: true, writable: true, value: ImmediateFileReader });
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  let selectionLookups = 0;
  const staged: string[] = [];
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(ChatInput, {
      streaming: false,
      stopping: false,
      disabled: false,
      submissionScope: "session:drop-bytes",
      allowFollowupSubmissions: true,
      acceptsImages: true,
      commands: [],
      onSend: async () => undefined,
      onAbort: async () => undefined,
      onPickLocalFiles: async () => [],
      // A same-named file is selected in another Explorer window. Its path must
      // never be attached to bytes that came from somewhere else.
      onReadExplorerSelection: async () => { selectionLookups += 1; return ["D:\\elsewhere\\report.txt"]; },
      onStageDroppedFile: async (file: { name: string }) => {
        staged.push(file.name);
        return `C:\\Temp\\staged\\${file.name}`;
      },
      onAttachmentKinds: async () => [{ path: "D:\\elsewhere\\report.txt", kind: "file" as const }],
      onError: (message: string) => { throw new Error(message); },
    }))));
    const composer = dom.window.document.querySelector<HTMLDivElement>(".composer")!;
    const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        files: [new dom.window.File(["report"], "report.txt", { type: "text/plain" })],
        items: [{ kind: "file", type: "text/plain", webkitGetAsEntry: () => ({ isDirectory: false, name: "report.txt" }), getAsString: (done: (value: string) => void) => done("") }],
        types: ["Files"],
        getData: () => "",
      },
    });
    await act(async () => {
      composer.dispatchEvent(drop);
      const deadline = Date.now() + 2_000;
      while (!dom.window.document.querySelector(".composer-attachments") && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Counted indirectly: no Explorer lookup may precede the byte staging.
    assert.deepEqual(staged, ["report.txt"], "the dragged file is staged from its own bytes");
    const card = dom.window.document.querySelector<HTMLElement>(".composer-attachment.is-file");
    assert.ok(card);
    assert.equal(
      card.querySelector(".composer-attachment-face")?.getAttribute("title"),
      "C:\\Temp\\staged\\report.txt",
      "an unrelated same-named file is never substituted",
    );
    assert.equal(selectionLookups, 0);
  } finally {
    await act(async () => root.unmount());
  }
});

test("ImagePreviewDialog focuses the close control and restores the trigger on Escape", async () => {
  const { dom } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { ImagePreviewDialog } = await import("../../src/web/components/ImagePreviewDialog");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const trigger = dom.window.document.createElement("button");
  trigger.textContent = "open";
  dom.window.document.body.append(trigger);
  trigger.focus();
  try {
    await act(async () => root.render(createElement(ImagePreviewDialog, {
      src: "data:image/png;base64,aaaa",
      alt: "preview",
      label: "输入框图片预览",
      onClose: () => { void root.render(null); },
    })));
    const close = dom.window.document.querySelector<HTMLButtonElement>(".image-preview-close");
    assert.ok(close);
    assert.equal(dom.window.document.activeElement, close);
    await act(async () => {
      close!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    assert.equal(dom.window.document.activeElement, close);
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector(".image-preview-dialog"), null);
    assert.equal(dom.window.document.activeElement, trigger);
  } finally {
    await act(async () => root.unmount());
  }
});

test("removing a staged card deletes its temp file and a text drop is not silent", async () => {
  const { dom } = installAppDom();
  class ImmediateFileReader {
    result = "data:application/octet-stream;base64,bG9nLWJvZHk=";
    onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
    onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
    readAsDataURL() { this.onload?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>); }
  }
  Object.defineProperty(dom.window, "FileReader", { configurable: true, writable: true, value: ImmediateFileReader });
  Object.defineProperty(globalThis, "FileReader", { configurable: true, writable: true, value: ImmediateFileReader });
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const discarded: string[] = [];
  const errors: string[] = [];
  try {
    // No StrictMode here: a double-mount supersedes the staging epoch, which is
    // correct but would discard this immediately-resolved staging result.
    await act(async () => root.render(createElement(ChatInput, {
      streaming: false,
      stopping: false,
      disabled: false,
      submissionScope: "session:drop-cleanup",
      allowFollowupSubmissions: true,
      acceptsImages: true,
      commands: [],
      onSend: async () => undefined,
      onAbort: async () => undefined,
      onPickLocalFiles: async () => [],
      onStageDroppedFile: async (file: { name: string }) => `C:\\Temp\\staged\\${file.name}`,
      onDiscardStagedFile: async (path: string) => { discarded.push(path); },
      onError: (message: string) => errors.push(message),
    })));
    const composer = dom.window.document.querySelector<HTMLDivElement>(".composer")!;
    const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        files: [new dom.window.File(["x"], "note.log", { type: "text/plain" })],
        items: [{ kind: "file", type: "text/plain", webkitGetAsEntry: () => ({ isDirectory: false, name: "note.log" }), getAsString: (done: (value: string) => void) => done("") }],
        types: ["Files"],
        getData: () => "",
      },
    });
    await act(async () => {
      composer.dispatchEvent(drop);
      const deadline = Date.now() + 2_000;
      while (!dom.window.document.querySelector(".composer-attachment-remove") && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-attachment-remove")!.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.deepEqual(discarded, ["C:\\Temp\\staged\\note.log"], "the abandoned temp file is reclaimed");

    // A drag with no file, no directory and no path must explain itself instead
    // of swallowing the gesture.
    const textDrop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(textDrop, "dataTransfer", {
      value: {
        files: [],
        items: [{ kind: "string", type: "text/plain", getAsString: (done: (value: string) => void) => done("just some prose") }],
        types: ["text/plain"],
        getData: () => "just some prose",
      },
    });
    await act(async () => {
      composer.dispatchEvent(textDrop);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.ok(errors.some((message) => message.includes("拖入的内容不是本地文件")), JSON.stringify(errors));
  } finally {
    await act(async () => root.unmount());
  }
});
