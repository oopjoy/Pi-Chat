import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { describeGateRequest, ExtensionDialog } from "../src/web/components/ExtensionDialog";

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

  await act(async () => buttonElements[1].click());
  await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.deepEqual(responses, [{ id: "gate", value: "✅ Allow" }, { id: "gate", value: "❌ Block" }]);
  await act(async () => root.unmount());
});
