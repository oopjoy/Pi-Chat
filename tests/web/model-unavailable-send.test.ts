import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
import type { BootstrapData, ModelInfo } from "../../src/shared/types";
import { activeSessionId as activeId, createBootstrapFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom as installDom } from "../helpers/app-dom";

let bootstrap: BootstrapData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
});

/**
 * Deleting a Provider or model is always allowed, so a conversation that still
 * selects one of its models keeps a route that no longer exists. Sending must
 * say so next to the model selector instead of reusing Pi's cached upstream
 * configuration until the next restart.
 */
const gone = {
  provider: "cpafem",
  id: "glm-5.3-flash",
  name: "glm-5.3-flash",
  api: "openai-responses",
  reasoning: true,
} as ModelInfo;
const alive = {
  provider: "FEMAI",
  id: "deepseek-flash",
  name: "deepseek-flash",
  api: "openai-responses",
  reasoning: true,
} as ModelInfo;

async function renderAppWithStaleSelection() {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const prompts: string[] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: gone, isStreaming: false },
      models: [alive],
      modelInventoryPending: false,
      modelRuntimeSyncPending: false,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => {
      prompts.push("sent");
      return { accepted: true, queued: false };
    },
    setModel: async () => ({ model: alive, pending: false }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  await act(async () => root.render(createElement(App)));
  const send = async (message: string) => {
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")
        ?.set?.call(textarea, message);
      textarea.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: message,
      }));
      await Promise.resolve();
    });
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  return {
    dom,
    prompts,
    send,
    close: async () => {
      await act(async () => root.unmount());
      restoreApi();
    },
  };
}

const toastText = (dom: ReturnType<typeof installDom>["dom"]) =>
  dom.window.document.querySelector(".app-toast.error")?.textContent || "";

test("a send with a deleted Provider's model names the missing model", async () => {
  const app = await renderAppWithStaleSelection();
  try {
    await app.send("still there?");
    assert.deepEqual(app.prompts, [], "a vanished model must not reach Pi as a prompt");
    assert.match(toastText(app.dom), /当前模型不存在：cpafem\/glm-5\.3-flash/);
    assert.match(toastText(app.dom), /请重新选择模型/);
    assert.equal(
      app.dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!.value,
      "still there?",
      "the editor keeps the message so the user can re-send after switching models",
    );
    assert.equal(
      app.dom.window.document.querySelector(".message-local-failure"),
      null,
      "a catalogue rejection is a toast, not a transcript failure card",
    );
  } finally {
    await app.close();
  }
});

test("choosing a surviving model clears the error and sends", async () => {
  const app = await renderAppWithStaleSelection();
  try {
    await app.send("first");
    assert.match(toastText(app.dom), /当前模型不存在/);
    const trigger = app.dom.window.document.querySelector<HTMLButtonElement>(
      ".composer-model-select .compact-select-trigger",
    )!;
    await act(async () => trigger.click());
    const option = [...app.dom.window.document.querySelectorAll<HTMLElement>(
      ".composer-model-select .compact-select-option",
    )].find((candidate) => (candidate.textContent || "").includes("deepseek-flash"));
    assert.ok(option, "only the surviving catalogue is offered");
    await act(async () => {
      option!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await app.send("second");
    assert.equal(app.prompts.length, 1, "a valid selection is delivered normally");
    assert.doesNotMatch(toastText(app.dom), /当前模型不存在/);
  } finally {
    await app.close();
  }
});
