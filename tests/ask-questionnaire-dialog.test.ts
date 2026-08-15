import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { AskQuestionnaireDialog } from "../src/web/components/AskQuestionnaireDialog";
import { parseAskQuestionnaire } from "../src/web/lib/ask-questionnaire";
import type { ExtensionUiRequest } from "../src/shared/types";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    Event: dom.window.Event,
    InputEvent: dom.window.InputEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
  });
  return dom;
}

const plan = parseAskQuestionnaire("ask-tool", {
  questions: [
    {
      question: "Which scope?",
      header: "Scope",
      options: [
        { label: "Narrow", description: "Only this bug" },
        { label: "Broad", description: "Related cleanup" },
      ],
      multiSelect: false,
    },
    {
      question: "How should it look?",
      header: "UX",
      options: [
        { label: "Compact", description: "Use less space" },
        { label: "Detailed", description: "Show descriptions" },
      ],
      multiSelect: false,
    },
  ],
})!;

function request(id: string, method: "select" | "input", title: string, options?: string[]): ExtensionUiRequest {
  return { type: "extension_ui_request", id, method, title, options };
}

test("rich Ask dialog navigates questions and keeps custom input inside its option row", async () => {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const responses: Array<Record<string, unknown>> = [];
  const onRespond = async (body: Record<string, unknown>) => {
    responses.push(body);
    return true;
  };
  const render = (pending: ExtensionUiRequest | null, visible = true) => root.render(createElement(
    AskQuestionnaireDialog,
    { plan, request: pending, visible, onRespond, onFallback: () => undefined },
  ));

  await act(async () => render(request("q1", "select", "[Scope] Which scope?", [
    "1. Narrow — Only this bug",
    "2. Broad — Related cleanup",
    "3. Type something.",
  ])));
  const originalFrame = dom.window.document.querySelector("section.extension-dialog");
  assert.ok(originalFrame);
  assert.match(dom.window.document.body.textContent || "", /问题 1 \/ 2/);
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>(".extension-dialog-actions .primary")?.disabled, true);

  await act(async () => dom.window.document.querySelector<HTMLButtonElement>(
    ".ask-questionnaire-custom-trigger",
  )!.click());
  const input = dom.window.document.querySelector<HTMLInputElement>(
    ".ask-questionnaire-custom input",
  )!;
  assert.ok(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")
      ?.set?.call(input, "Keep it in the row");
    input.dispatchEvent(new dom.window.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: "Keep it in the row",
    }));
  });
  await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
  })));
  assert.match(dom.window.document.body.textContent || "", /问题 2 \/ 2/);
  assert.equal(dom.window.document.activeElement?.classList.contains("ask-questionnaire-progress"), true);
  assert.equal(dom.window.document.querySelector("section.extension-dialog"), originalFrame);

  await act(async () => [...dom.window.document.querySelectorAll<HTMLButtonElement>(
    ".extension-dialog-actions button",
  )].find((button) => button.textContent === "上一个")!.click());
  assert.equal(
    dom.window.document.querySelector<HTMLInputElement>(".ask-questionnaire-custom input")?.value,
    "Keep it in the row",
  );
  await act(async () => [...dom.window.document.querySelectorAll<HTMLButtonElement>(
    ".extension-dialog-actions button",
  )].find((button) => button.textContent === "下一个")!.click());

  await act(async () => dom.window.document.querySelector<HTMLButtonElement>(
    "button.ask-questionnaire-option",
  )!.click());
  assert.match(dom.window.document.body.textContent || "", /问题 2 \/ 2/);
  const submit = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
    ".extension-dialog-actions button",
  )].find((button) => button.textContent === "提交")!;
  assert.equal(submit.disabled, false);

  await act(async () => submit.click());
  assert.deepEqual(responses, [{ id: "q1", value: "3. Type something." }]);
  assert.equal(dom.window.document.querySelector("section.extension-dialog"), originalFrame);

  await act(async () => render(null, false));
  assert.equal(dom.window.document.querySelector("section.extension-dialog"), null);
  await act(async () => render(request("q1-input", "input", "[Scope] Which scope?\n\nType your answer:"), true));
  assert.deepEqual(responses.at(-1), { id: "q1-input", value: "Keep it in the row" });
  await act(async () => render(request("q2", "select", "[UX] How should it look?", [
    "1. Compact — Use less space",
    "2. Detailed — Show descriptions",
    "3. Type something.",
  ])));
  assert.deepEqual(responses.at(-1), { id: "q2", value: "1. Compact — Use less space" });
  assert.ok(dom.window.document.querySelector("section.extension-dialog"));
  assert.equal(dom.window.document.querySelectorAll(".dialog-backdrop").length, 1);
  await act(async () => root.unmount());
});

test("rich Ask multi-select toggles in place and submits the retained set", async () => {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const multiPlan = parseAskQuestionnaire("ask-multi", {
    questions: [{
      question: "Which checks?",
      header: "Checks",
      options: [
        { label: "Unit", description: "Run unit tests" },
        { label: "E2E", description: "Run browser tests" },
      ],
      multiSelect: true,
    }],
  })!;
  const responses: Array<Record<string, unknown>> = [];
  const pending = request(
    "multi-input",
    "input",
    "[Checks] Which checks?\n\n1. Unit — Run unit tests\n2. E2E — Run browser tests\n\nEnter the numbers of all that apply, comma-separated (e.g. \"1,3\"), or type a custom answer as plain text.",
  );
  await act(async () => root.render(createElement(AskQuestionnaireDialog, {
    plan: multiPlan,
    request: pending,
    onFallback: () => undefined,
    onRespond: async (body: Record<string, unknown>) => {
      responses.push(body);
      return true;
    },
  })));
  const options = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
    "button.ask-questionnaire-option",
  )];
  await act(async () => options[0].click());
  await act(async () => options[1].click());
  await act(async () => options[0].click());
  assert.equal(dom.window.document.querySelectorAll("button.ask-questionnaire-option.is-selected").length, 1);
  const submit = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
    ".extension-dialog-actions button",
  )].find((button) => button.textContent === "提交")!;
  await act(async () => submit.click());
  assert.deepEqual(responses, [{ id: "multi-input", value: "2" }]);
  await act(async () => root.unmount());
});

test("rich Ask falls back without answering when scalar request shape differs", async () => {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const responses: Array<Record<string, unknown>> = [];
  let fallbacks = 0;
  const mismatched = request("q1", "select", "[Scope] Which scope?", [
    "1. Broad — Related cleanup",
    "2. Narrow — Only this bug",
    "3. Type something.",
  ]);
  await act(async () => root.render(createElement(AskQuestionnaireDialog, {
    plan,
    request: mismatched,
    onFallback: () => { fallbacks += 1; },
    onRespond: async (body: Record<string, unknown>) => {
      responses.push(body);
      return true;
    },
  })));
  await act(async () => dom.window.document.querySelector<HTMLButtonElement>(
    "button.ask-questionnaire-option",
  )!.click());
  await act(async () => dom.window.document.querySelector<HTMLButtonElement>(
    "button.ask-questionnaire-option",
  )!.click());
  const submit = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
    ".extension-dialog-actions button",
  )].find((button) => button.textContent === "提交")!;
  await act(async () => submit.click());
  assert.equal(fallbacks, 1);
  assert.deepEqual(responses, []);
  assert.match(dom.window.document.body.textContent || "", /标准输入对话框/);
  await act(async () => root.unmount());
});

test("rich Ask Escape cancellation recovers when the authoritative request remains pending", async () => {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const responses: Array<Record<string, unknown>> = [];
  let outcome: "false" | "reject" | "true" = "false";
  const pending = request("q1", "select", "[Scope] Which scope?", [
    "1. Narrow — Only this bug",
    "2. Broad — Related cleanup",
    "3. Type something.",
  ]);
  await act(async () => root.render(createElement(AskQuestionnaireDialog, {
    plan,
    request: pending,
    onFallback: () => undefined,
    onRespond: async (body: Record<string, unknown>) => {
      responses.push(body);
      if (outcome === "reject") throw new Error("cancel failed");
      return outcome === "true";
    },
  })));

  await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
  })));
  assert.deepEqual(responses, [{ id: "q1", cancelled: true }]);
  assert.match(dom.window.document.body.textContent || "", /取消未成功发送/);
  assert.ok(dom.window.document.querySelector(".ask-questionnaire-options"));

  outcome = "reject";
  await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
  })));
  assert.equal(responses.length, 2);
  assert.match(dom.window.document.body.textContent || "", /取消未成功发送/);

  outcome = "true";
  await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
  })));
  assert.deepEqual(responses, [
    { id: "q1", cancelled: true },
    { id: "q1", cancelled: true },
    { id: "q1", cancelled: true },
  ]);
  assert.ok(dom.window.document.querySelector(".extension-dialog-continuation"));
  await act(async () => root.unmount());
});
