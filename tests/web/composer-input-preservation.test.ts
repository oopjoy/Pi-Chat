import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { installAppDom } from "../helpers/app-dom";

async function mountedComposer(overrides: Record<string, unknown> = {}) {
  const fixture = installAppDom();
  const { dom } = fixture;
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  await act(async () => root.render(createElement(ChatInput, {
    streaming: false, stopping: false, disabled: false, acceptsImages: true,
    submissionScope: "session:input-preservation", commands: [],
    onSend: async () => undefined, onAbort: async () => undefined,
    onPickLocalFiles: async () => [], onError: () => undefined,
    ...overrides,
  })));
  const text = dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
  return {
    dom, root, text,
    async type(message: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(text, message);
        text.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
      });
    },
    async click(selector: string) {
      const button = dom.window.document.querySelector<HTMLButtonElement>(selector);
      assert.ok(button, selector);
      await act(async () => { button.click(); });
    },
    async close() { await act(async () => root.unmount()); fixture.dispose(); },
  };
}

test("two rejected sends preserve every interim draft and the recovery button sends nothing", async () => {
  const calls: string[] = [];
  const responses: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const f = await mountedComposer({
    onSend: (message: string) => {
      calls.push(message);
      const response = Promise.withResolvers<void>();
      responses.push(response);
      return response.promise;
    },
  });
  try {
    await f.type("A");
    await f.click(".send-button");
    await f.type("B");
    await act(async () => { responses[0].reject(new Error("first rejection")); });
    assert.equal(f.text.value, "A");
    await f.click(".send-button");
    await f.type("C");
    await act(async () => { responses[1].reject(new Error("second rejection")); });
    assert.equal(f.text.value, "A");
    assert.match(f.dom.window.document.querySelector(".composer-retained-drafts")?.textContent || "", /2 份未发送草稿/);
    await f.click(".send-button");
    await act(async () => { responses[2].resolve(); });
    assert.equal(f.text.value, "B", "the oldest interim draft is restored first");
    assert.deepEqual(calls, ["A", "A", "A"], "B and C have never been sent");
    await f.click(".composer-retained-drafts button");
    assert.equal(f.text.value, "C");
    await f.click(".composer-retained-drafts button");
    assert.equal(f.text.value, "B", "the editor is retained when switching to another draft");
    assert.deepEqual(calls, ["A", "A", "A"]);
  } finally { await f.close(); }
});

test("unsent input requests a native close warning without claiming a durable backup", async () => {
  const f = await mountedComposer();
  const closeRequested = () => {
    const event = new f.dom.window.Event("beforeunload", { cancelable: true });
    f.dom.window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    assert.equal(closeRequested(), false);
    await f.type("unsent text");
    assert.equal(closeRequested(), true);
    await f.type("");
    assert.equal(closeRequested(), false);
  } finally { await f.close(); }
});

async function checkMixedDrop(resolveDirectory: boolean) {
  const errors: string[] = [];
  const discarded: string[] = [];
  const f = await mountedComposer({
    onStageDroppedFile: async () => "C:/Temp/staged/note.log",
    onDiscardStagedFile: async (path: string) => { discarded.push(path); },
    onAttachmentKinds: async (paths: string[]) => paths.map((path) => ({ path, kind: path.endsWith("results") ? "directory" : "file" })),
    onError: (message: string) => { errors.push(message); },
  });
  const previousReader = globalThis.FileReader;
  class ImmediateReader {
    result = "data:text/plain;base64,bm90ZQ==";
    onload?: () => void;
    readAsDataURL() { this.onload?.(); }
  }
  globalThis.FileReader = ImmediateReader as unknown as typeof FileReader;
  try {
    const file = new f.dom.window.File(["note"], "note.log", { type: "text/plain" });
    const drop = new f.dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: {
      // Chromium need not include directories in files. The earlier handler
      // indexed files against items and could mistake note.log for a directory.
      files: [file],
      items: [
        { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true, name: "results" }), getAsFile: () => null },
        { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false, name: "note.log" }), getAsFile: () => file },
      ],
      types: ["Files", "text/uri-list"],
      getData: (type: string) => resolveDirectory && type === "text/uri-list" ? "file:///C:/work/results" : "",
    } });
    await act(async () => {
      f.dom.window.document.querySelector(".composer")!.dispatchEvent(drop);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(f.dom.window.document.querySelector('[title="C:/Temp/staged/note.log"]') !== null, true);
    assert.deepEqual(discarded, [], "a folder failure must not delete an adopted file card");
    if (resolveDirectory) {
      assert.ok(f.dom.window.document.querySelector(".composer-attachment.is-folder"));
      assert.equal(f.dom.window.document.querySelectorAll(".composer-attachment.is-file").length, 2);
      assert.deepEqual(errors, []);
    } else {
      assert.equal(f.dom.window.document.querySelectorAll(".composer-attachment.is-file").length, 1);
      assert.ok(errors.some((error) => error.includes("已添加 1 个文件") && error.includes("results")), JSON.stringify(errors));
    }
  } finally { globalThis.FileReader = previousReader; await f.close(); }
}

test("a bare folder name is rejected until the user explicitly chooses a path", async () => {
  let picks = 0;
  const errors: string[] = [];
  const f = await mountedComposer({
    onPickLocalFolder: async () => { picks += 1; return ["C:/chosen/results"]; },
    onAttachmentKinds: async (paths: string[]) => paths.map((path) => ({ path, kind: "directory" })),
    onError: (message: string) => errors.push(message),
  });
  try {
    const event = new f.dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: {
      files: [], items: [{ kind: "file", webkitGetAsEntry: () => ({ name: "results", isDirectory: true }) }],
      types: ["Files"], getData: () => "",
    } });
    await act(async () => {
      f.dom.window.document.querySelector(".composer")!.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(picks, 0, "a drag must not silently choose a directory or open a picker");
    assert.equal(f.dom.window.document.querySelectorAll(".composer-attachment").length, 0);
    assert.ok(errors.some((error) => error.includes("results") && error.includes("本地文件夹")));
    await f.click(".attachment-button");
    const folder = [...f.dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("本地文件夹"))!;
    await act(async () => { folder.click(); });
    assert.equal(picks, 1);
    assert.ok(f.dom.window.document.querySelector('[title="C:/chosen/results"]'));
    assert.ok(f.dom.window.document.querySelector(".is-folder"));
  } finally { await f.close(); }
});

test("mixed drop attaches both the staged file and a resolvable folder", async () => {
  await checkMixedDrop(true);
});

test("mixed drop keeps the staged file and names the folder that could not be attached", async () => {
  await checkMixedDrop(false);
});
