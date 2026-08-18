import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { describeGateRequest, ExtensionDialog, type ExtensionUiRequest } from "../src/web/components/ExtensionDialog";

test("Gate dialog foregrounds the requested file or command and keeps its response values", () => {
  assert.deepEqual(describeGateRequest({ type: "extension_ui_request", id: "1", method: "select", title: "📝 Write\n\nWrite to C:\\work\\report.md", options: ["✅ Allow", "❌ Block"] }), {
    action: "请求写入文件", target: "C:\\work\\report.md", tool: "write", allowValue: "✅ Allow", blockValue: "❌ Block",
  });
  assert.deepEqual(describeGateRequest({ type: "extension_ui_request", id: "2", method: "select", title: "⚠️ Destructive bash command:\n\n  rm -rf build\n\nAllow?", options: ["✅ Allow", "❌ Block"] }), {
    action: "请求执行高风险命令", target: "rm -rf build", tool: "bash", allowValue: "✅ Allow", blockValue: "❌ Block",
  });
});

test("Gate dialog recognizes the stable protocol and the current Tool permission format", () => {
  assert.deepEqual(describeGateRequest({ type: "extension_ui_request", id: "3", method: "select", title: "Pi Chat Gate · edit\n\nC:\\work\\app.ts", options: ["Allow", "Block"] }), {
    action: "请求修改文件", target: "C:\\work\\app.ts", tool: "edit", allowValue: "Allow", blockValue: "Block",
  });
  assert.deepEqual(describeGateRequest({ type: "extension_ui_request", id: "4", method: "select", title: "Tool requires permission: bash", message: "cd C:/work && rg -n test", options: ["Allow", "Block"] }), {
    action: "请求执行命令", target: "cd C:/work && rg -n test", tool: "bash", allowValue: "Allow", blockValue: "Block",
  });
  assert.equal(describeGateRequest({ type: "extension_ui_request", id: "ordinary", method: "select", title: "Pick one", options: ["First", "Second"] }), null);
});

test("Gate dialog preserves the dangerous suffix of long commands", () => {
  const command = `echo ${"safe ".repeat(60)}&& rm -rf important-data`;
  const details = describeGateRequest({
    type: "extension_ui_request",
    id: "long-command",
    method: "select",
    title: `Pi Chat Gate · bash\n\n${command}`,
    options: ["Allow", "Block"],
  });
  assert.equal(details?.target, command);
  assert.match(details?.target || "", /rm -rf important-data$/);
});

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // React's legacy input-event fallback probes these IE hooks when JSDOM
  // auto-focuses an input that replaces a button inside the same dialog frame.
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
  });
  return dom;
}

test("Gate dialog exposes only Block and Allow, with Escape safely choosing Block", async () => {
  const dom = installDom();
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const responses: Array<Record<string, unknown>> = [];
  await act(async () => root.render(createElement(ExtensionDialog, {
    request: { type: "extension_ui_request", id: "gate", method: "select", title: "⚠️ Destructive bash command:\n\nrm -rf build\n\nAllow?", options: ["✅ Allow", "❌ Block"] },
    onRespond: (body: Record<string, unknown>) => responses.push(body),
  })));
  const buttonElements = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")];
  assert.deepEqual(buttonElements.map((button) => button.textContent), ["Block", "Allow"]);
  assert.equal(dom.window.document.body.textContent?.includes("取消"), false);
  assert.equal(dom.window.document.body.textContent?.includes("Pi Chat Gate"), true);
  assert.equal(dom.window.document.activeElement?.textContent, "Block");
  assert.ok(dom.window.document.querySelector(".extension-dialog-header"));
  assert.ok(dom.window.document.querySelector(".extension-dialog-body"));
  assert.ok(dom.window.document.querySelector(".extension-dialog-actions"));

  await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.deepEqual(responses, [{ id: "gate", value: "❌ Block" }]);

  await act(async () => root.render(createElement(ExtensionDialog, {
    request: { type: "extension_ui_request", id: "gate-2", method: "select", title: "⚠️ Destructive bash command:\n\nrm -rf build\n\nAllow?", options: ["✅ Allow", "❌ Block"] },
    onRespond: (body: Record<string, unknown>) => responses.push(body),
  })));
  const replacementButtons = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")];
  await act(async () => replacementButtons[1].click());
  assert.deepEqual(responses, [
    { id: "gate", value: "❌ Block" },
    { id: "gate-2", value: "✅ Allow" },
  ]);
  await act(async () => root.unmount());
});

test("ordinary Extension requests use the same frame while retaining Cancel semantics", async () => {
  const dom = installDom();
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const responses: Array<Record<string, unknown>> = [];
  await act(async () => root.render(createElement(ExtensionDialog, {
    request: { type: "extension_ui_request", id: "extension", method: "select", title: "Choose a mode", message: "Select one option", options: ["First", "Second"] },
    onRespond: (body: Record<string, unknown>) => responses.push(body),
  })));
  assert.equal(dom.window.document.querySelector(".extension-dialog-header > div > span")?.textContent, "Pi Extension");
  assert.equal(dom.window.document.querySelector("#extension-dialog-title")?.textContent, "Choose a mode");
  assert.ok(dom.window.document.querySelector(".extension-dialog-icon.is-extension"));
  assert.ok(dom.window.document.querySelector(".extension-dialog-body"));
  assert.ok(dom.window.document.querySelector(".extension-dialog-actions"));
  assert.deepEqual([...dom.window.document.querySelectorAll("button")].map((button) => button.textContent), ["First", "Second", "取消"]);

  await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.deepEqual(responses, [{ id: "extension", cancelled: true }]);
  await act(async () => root.unmount());
});

test("ask_user_question RPC fallback keeps multiline prompts and exact option values", async () => {
  const dom = installDom();
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const responses: Array<Record<string, unknown>> = [];
  const title = "[Scope] Which implementation style?\n\n--- 1. Minimal preview ---\nOnly touch the failing path.";
  const options = [
    "1. Minimal change — Preserve the current architecture.",
    "2. Broader refactor — Simplify the surrounding ownership.",
    "3. Type something.",
  ];
  await act(async () => root.render(createElement(ExtensionDialog, {
    request: { type: "extension_ui_request", id: "ask-select", method: "select", title, options },
    onRespond: (body: Record<string, unknown>) => responses.push(body),
  })));

  assert.equal(dom.window.document.querySelector("#extension-dialog-title")?.textContent, title);
  const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")];
  assert.deepEqual(buttons.map((button) => button.textContent), [...options, "取消"]);
  await act(async () => buttons[1].click());
  assert.deepEqual(responses, [{ id: "ask-select", value: options[1] }]);
  await act(async () => root.unmount());
});

test("a restored Extension request becomes retryable after response failure", async () => {
  const dom = installDom();
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const responses: Array<Record<string, unknown>> = [];
  const request: ExtensionUiRequest = {
    type: "extension_ui_request",
    id: "retry-select",
    method: "select",
    title: "Choose again",
    options: ["First", "Second"],
  };
  const renderDialog = (nextRequest: ExtensionUiRequest) =>
    root.render(createElement(ExtensionDialog, {
      request: nextRequest,
      sessionId: "session-retry",
      continuationPending: true,
      onRespond: (body: Record<string, unknown>) => responses.push(body),
    }));

  await act(async () => renderDialog(request));
  await act(async () => dom.window.document.querySelector<HTMLButtonElement>(
    ".dialog-options button",
  )!.click());
  assert.ok(dom.window.document.querySelector(".extension-dialog-continuation"));

  await act(async () => renderDialog({ ...request, options: [...request.options!] }));
  assert.equal(dom.window.document.querySelector(".extension-dialog-continuation"), null);
  const restoredOptions = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
    ".dialog-options button",
  )];
  assert.equal(restoredOptions.length, 2);
  await act(async () => restoredOptions[1].click());
  assert.deepEqual(responses, [
    { id: request.id, value: "First" },
    { id: request.id, value: "Second" },
  ]);
  await act(async () => root.unmount());
});

test("sequential Extension requests reuse one dialog frame for custom answers", async () => {
  const dom = installDom();
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const responses: Array<Record<string, unknown>> = [];
  const options = [
    "1. Minimal change — Preserve the current architecture.",
    "2. Broader refactor — Simplify the surrounding ownership.",
    "3. Type something.",
  ];
  const renderDialog = (request: ExtensionUiRequest | null, continuationPending: boolean) =>
    root.render(createElement(ExtensionDialog, {
      request,
      sessionId: "session-ask",
      continuationPending,
      onRespond: (body: Record<string, unknown>) => responses.push(body),
    }));

  await act(async () => renderDialog({
    type: "extension_ui_request",
    id: "ask-select",
    method: "select",
    title: "[Scope] Which implementation style?",
    options,
  }, true));
  const originalFrame = dom.window.document.querySelector("section.extension-dialog");
  assert.ok(originalFrame);
  const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")];
  await act(async () => buttons[2].click());
  assert.deepEqual(responses, [{ id: "ask-select", value: options[2] }]);
  assert.ok(dom.window.document.querySelector("section.extension-dialog") === originalFrame);
  assert.match(dom.window.document.querySelector("[role=status]")?.textContent || "", /正在准备下一步/);

  await act(async () => renderDialog(null, true));
  assert.ok(dom.window.document.querySelector("section.extension-dialog") === originalFrame);
  assert.equal(dom.window.document.querySelectorAll(".dialog-backdrop").length, 1);

  await act(async () => renderDialog({
    type: "extension_ui_request",
    id: "ask-input",
    method: "input",
    title: "[Scope] Which implementation style?\n\nType your answer:",
    prefill: "A custom answer",
  }, true));
  assert.ok(dom.window.document.querySelector("section.extension-dialog") === originalFrame);
  assert.equal(dom.window.document.querySelector<HTMLInputElement>("input")?.value, "A custom answer");
  const inputButtons = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")];
  await act(async () => inputButtons.find((button) => button.textContent === "确定")?.click());
  assert.deepEqual(responses, [
    { id: "ask-select", value: options[2] },
    { id: "ask-input", value: "A custom answer" },
  ]);

  await act(async () => renderDialog(null, false));
  assert.ok(!dom.window.document.querySelector("section.extension-dialog"));
  await act(async () => root.unmount());
});
