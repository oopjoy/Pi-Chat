import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { IDBFactory } from "fake-indexeddb";
import { installAppDom } from "../helpers/app-dom";
import { DraftRecoveryStore } from "../../src/web/lib/draft-recovery";
import { composerPartition, composerReducer, emptyComposerState } from "../../src/web/state/composer";

const key = { kind: "session" as const, sessionId: "recovery-ui" };
const picture = { type: "image" as const, data: "YQ==", mimeType: "image/png", fileName: "plot.png" };

async function seededFixture(files: string[] = []) {
  const f = installAppDom();
  Object.defineProperty(f.dom.window, "indexedDB", { value: new IDBFactory() });
  const saved = new DraftRecoveryStore();
  saved.persist(key, composerPartition(composerReducer(emptyComposerState(), {
    type: "replace", key, message: "saved scientific question", images: [picture], files,
  }), key));
  await saved.flush();
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(f.dom.window.document.querySelector("#root")!);
  const sent: string[] = [];
  const render = async (overrides: Record<string, unknown> = {}, waitForRecovery = true) => {
    await act(async () => {
      root.render(createElement(ChatInput, {
        streaming: false, stopping: false, disabled: false, acceptsImages: true,
        submissionScope: "session:recovery-ui", draftKey: key, commands: [],
        onAbort: async () => undefined, onPickLocalFiles: async () => [],
        onSend: async (message: string) => { sent.push(message); }, onError: () => undefined,
        ...overrides,
      }));
      await new Promise((done) => setTimeout(done, 10));
    });
    const deadline = Date.now() + 5000;
    while (waitForRecovery && !f.dom.window.document.querySelector(".composer-recovery") && Date.now() < deadline)
      await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
  };
  const button = (name: string) => [...f.dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent === name)!;
  return { ...f, root, sent, render, button, async close() { await act(async () => root.unmount()); f.dispose(); } };
}

test("explicit recovery preserves new typing, restores only valid attachments and never auto-sends", async () => {
  const f = await seededFixture(["C:/work/valid.pdf", "C:/work/missing.log"]);
  try {
    await f.render({ onValidateRecoveredFiles: async () => ["C:/work/missing.log"] });
    assert.ok(f.button("恢复草稿"));
    const input = f.dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(input, "new typing");
      input.dispatchEvent(new f.dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "new typing" }));
    });
    await act(async () => { f.button("恢复草稿").click(); await new Promise((done) => setTimeout(done, 40)); });
    assert.equal(input.value, "new typing", "recovery cannot overwrite text typed while it was loading");
    assert.match(f.dom.window.document.body.textContent || "", /missing\.log/);
    await act(async () => f.button("恢复下一份草稿").click());
    assert.equal(input.value, "saved scientific question");
    assert.ok(f.dom.window.document.querySelector(".composer-attachment.is-image img"));
    assert.ok(f.dom.window.document.querySelector('[title="C:/work/valid.pdf"]'));
    assert.equal(f.dom.window.document.querySelector('[title="C:/work/missing.log"]'), null);
    assert.deepEqual(f.sent, []);
  } finally { await f.close(); }
});

test("a late restore cannot import content after A-to-B-to-A navigation", async () => {
  const f = await seededFixture(["C:/work/managed.pdf"]);
  const validation = Promise.withResolvers<string[]>();
  const entered = Promise.withResolvers<void>();
  const validate = async () => { entered.resolve(); return validation.promise; };
  try {
    await f.render({ onValidateRecoveredFiles: validate });
    await act(async () => { f.button("恢复草稿").click(); await new Promise((done) => setTimeout(done, 20)); });
    await entered.promise;
    await f.render({ draftKey: { kind: "session", sessionId: "elsewhere" }, submissionScope: "session:elsewhere", onValidateRecoveredFiles: validate }, false);
    await f.render({ onValidateRecoveredFiles: validate });
    await act(async () => { validation.resolve([]); await new Promise((done) => setTimeout(done, 20)); });
    assert.equal(f.dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!.value, "");
    assert.equal(f.dom.window.document.querySelector(".composer-attachment"), null);
    assert.deepEqual(f.sent, []);
  } finally { validation.resolve([]); await f.close(); }
});

test("a failed retention preflight restores the draft without handing any message to Pi", async () => {
  const f = await seededFixture(["C:/work/managed.pdf"]);
  let prepared = 0;
  try {
    await f.render({
      onValidateRecoveredFiles: async () => [],
      onPrepareLocalFiles: async () => { prepared += 1; throw new Error("retention unavailable"); },
    });
    await act(async () => { f.button("恢复草稿").click(); await new Promise((done) => setTimeout(done, 40)); });
    await act(async () => {
      f.dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await new Promise((done) => setTimeout(done, 30));
    });
    assert.equal(prepared, 1);
    assert.deepEqual(f.sent, []);
    assert.equal(f.dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!.value, "saved scientific question");
    assert.match(f.dom.window.document.body.textContent || "", /retention unavailable/);
  } finally { await f.close(); }
});

test("retention must acknowledge before the existing send function is invoked", async () => {
  const f = await seededFixture(["C:/work/managed.pdf"]);
  const retain = Promise.withResolvers<void>();
  try {
    await f.render({ onValidateRecoveredFiles: async () => [], onPrepareLocalFiles: () => retain.promise });
    await act(async () => { f.button("恢复草稿").click(); await new Promise((done) => setTimeout(done, 40)); });
    await act(async () => f.dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click());
    assert.deepEqual(f.sent, []);
    await act(async () => { retain.resolve(); await new Promise((done) => setTimeout(done, 20)); });
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /managed\.pdf/);
  } finally { retain.resolve(); await f.close(); }
});
