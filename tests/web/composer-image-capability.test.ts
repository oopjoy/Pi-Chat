import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
import { type BootstrapData, type SessionViewData } from "../../src/shared/types";
import { activeSessionId as activeId, createBootstrapFixture, createSessionViewFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom as installDom } from "../helpers/app-dom";

let bootstrap: BootstrapData;
let draftView: SessionViewData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
  draftView = createSessionViewFixture();
});


test("Primary ready forwards a staged draft image without capability confirmation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const submittedInitialPrompts: Array<{ message: string; images: unknown[] }> = [];
  const runtimeModel = {
    provider: "test",
    id: "runtime-model",
    name: "Runtime model",
    input: ["text", "image"],
    reasoning: true,
  };
  const stagedModel = {
    provider: "test",
    id: "staged-model",
    name: "Staged model",
    input: ["text"],
    reasoning: true,
  };
  const createdSession = createSessionViewFixture();
  createdSession.session = {
    ...createdSession.session,
    id: "new-image-session-123456",
    sessionId: "new-image-session-123456",
    name: "New image",
    active: true,
    writable: true,
  };
  createdSession.state = {
    ...createdSession.state,
    sessionId: createdSession.session.id,
    sessionFile: "C:/sessions/new-image-session.jsonl",
    model: stagedModel,
    isStreaming: true,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      activeSessionId: "",
      activeSessionIds: [],
      sessions: [],
      state: { ...bootstrap.state, model: runtimeModel },
      models: [runtimeModel, stagedModel],
      primaryRuntime: {
        status: "ready" as const,
        generation: 11,
        model: runtimeModel,
        sessionId: activeId,
      },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: "" }),
    submitNewSession: async (input: { message: string; images: unknown[] }) => {
      submittedInitialPrompts.push(input);
      return {
        sessionId: createdSession.session.id,
        session: createdSession.session,
        state: createdSession.state,
        gateMode: "strict" as const,
        accepted: true as const,
        queued: false as const,
        isStreaming: true,
      };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer-model-select .compact-select-trigger",
    )!;
    await act(async () => trigger.click());
    const stagedOption = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".composer-model-select [role='option']",
    )].find((option) => option.textContent?.includes("Staged model"))!;
    await act(async () => stagedOption.click());
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            primaryRuntime: {
              status: "ready",
              generation: 12,
              model: runtimeModel,
              sessionId: activeId,
            },
          }),
        }),
      ),
    );
    assert.match(trigger.textContent || "", /Staged model/);
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!
        .disabled,
      false,
      "Runtime model A cannot confirm staged model B images, but text drafting remains available",
    );
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!
        .disabled,
      false,
      "a ready Composer may stage attachments before the upstream handles the prompt",
    );
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.click(),
    );
    const imageMenuItem = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".attachment-menu [role='menuitem']",
    )].find((item) => item.textContent?.includes("图片"))!;
    assert.match(
      imageMenuItem.textContent || "",
      /仍会直接发送给上游模型/,
      "a New draft explains that unknown image capability does not block forwarding",
    );
    Object.assign(globalThis, { FileReader: dom.window.FileReader });
    const fileInput = dom.window.document.querySelector<HTMLInputElement>(
      "input[type='file']",
    )!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [
        new dom.window.File(["image"], "pending-new.png", {
          type: "image/png",
        }),
      ],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 250;
      while (
        !dom.window.document.querySelector(".image-preview") &&
        Date.now() < deadline
      )
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      ".composer textarea",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "new draft image");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "new draft image",
        }),
      );
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
    });
    assert.equal(
      submittedInitialPrompts.length,
      1,
      "the New-draft transaction receives the image without a client capability gate",
    );
    assert.equal(submittedInitialPrompts[0]?.images.length, 1);
    assert.equal(
      dom.window.document.querySelector(".app-toast.error"),
      null,
      "unknown image capability is not surfaced as a client-side error",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Primary startup keeps editor and attachments available while capability is pending", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      primaryRuntime: { status: "starting" as const, generation: 1 },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(
      ".composer textarea",
    )!;
    assert.equal(input.disabled, false, "text remains editable while Runtime prepares");
    assert.doesNotMatch(input.placeholder, /Runtime ready 后才能输入/);
    const attachment = dom.window.document.querySelector<HTMLButtonElement>(
      ".attachment-button",
    )!;
    assert.equal(attachment.disabled, false, "attachments remain editable while Runtime prepares");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a legacy ready without adopted capability still forwards an image prompt", async () => {
  const { dom, FakeEventSource } = installDom();
  Object.assign(globalThis, { FileReader: dom.window.FileReader });
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let requests = 0;
  const promptCalls: unknown[][] = [];
  Object.assign(api, {
    bootstrap: async () => {
      requests += 1;
      if (requests === 1)
        return {
          ...bootstrap,
          state: { ...bootstrap.state, model: null },
          models: [],
          primaryRuntime: { status: "starting" as const, generation: 1 },
        };
      return { ...bootstrap, primaryRuntime: { status: "ready" as const, generation: 1 } };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const imageMenuItem = () =>
    [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".attachment-menu [role='menuitem']",
    )].find((item) => item.textContent?.includes("图片"))!;
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-ready-capability",
            workspaceEpoch: "epoch-ready-capability",
            primaryRuntime: { status: "ready", generation: 1 },
          }),
        }),
      ),
    );
    assert.equal(requests, 2, "a ready frame that missed the status SSE refreshes its capability snapshot");
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!.disabled,
      false,
      "ready Runtime authority unlocks ordinary text before image capability is confirmed",
    );
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.disabled,
      false,
      "attachments may be staged while their submit-time capability check remains pending",
    );
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.click(),
    );
    assert.match(imageMenuItem().textContent || "", /是否支持由上游模型返回结果/);
    const fileInput = dom.window.document.querySelector<HTMLInputElement>(
      "input[type='file']",
    )!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [
        new dom.window.File(["image"], "pending.png", {
          type: "image/png",
        }),
      ],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 250;
      while (
        !dom.window.document.querySelector(".image-preview") &&
        Date.now() < deadline
      )
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      ".composer textarea",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "send after capability confirmation");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "send after capability confirmation",
        }),
      );
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
    });
    assert.equal(promptCalls.length, 1, "unknown image capability does not block submission");
    assert.equal(
      dom.window.document.querySelector(".app-toast.error"),
      null,
      "unknown image capability is not surfaced as a client-side error",
    );
    assert.equal(
      (promptCalls[0]?.[1] as unknown[])?.length,
      1,
      "the image is forwarded with the prompt",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a new Primary generation keeps prior image capability pending until its refresh commits", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const imageModel = {
    provider: "test",
    id: "generation-image",
    name: "Generation image",
    input: ["text", "image"],
    reasoning: true,
  };
  let requests = 0;
  const resolveRefreshes: Array<(data: BootstrapData) => void> = [];
  Object.assign(api, {
    bootstrap: async () => {
      requests += 1;
      if (requests === 1)
        return {
          ...bootstrap,
          state: { ...bootstrap.state, model: imageModel },
          models: [imageModel],
          primaryRuntime: {
            status: "ready" as const,
            generation: 1,
            model: imageModel,
            sessionId: activeId,
          },
        };
      return new Promise<BootstrapData>((resolve) => {
        resolveRefreshes.push(resolve);
      });
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const imageMenuItem = () =>
    [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".attachment-menu [role='menuitem']",
    )].find((item) => item.textContent?.includes("图片"))!;
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    // Begin an old-generation refresh, then let Primary begin generation 2
    // before that response returns.
    await act(async () =>
      source.emitPi({
        type: "pi_chat_primary_runtime_status",
        primaryRuntime: { status: "ready", generation: 1 },
      }),
    );
    assert.equal(requests, 2);
    await act(async () =>
      source.emitPi({
        type: "pi_chat_primary_runtime_status",
        primaryRuntime: { status: "starting", generation: 2 },
      }),
    );
    await act(async () => {
      resolveRefreshes.shift()!({
        ...bootstrap,
        state: { ...bootstrap.state, model: imageModel },
        models: [imageModel],
        primaryRuntime: { status: "ready", generation: 1 },
      });
      await Promise.resolve();
    });
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            primaryRuntime: {
              status: "ready",
              generation: 2,
              model: imageModel,
              sessionId: activeId,
            },
          }),
        }),
      ),
    );
    assert.equal(
      requests,
      2,
      "an adopted ready snapshot needs no capability Bootstrap round trip",
    );
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!.disabled,
      false,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.disabled,
      false,
    );
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.click(),
    );
    assert.equal(imageMenuItem().disabled, false);
    assert.match(
      imageMenuItem().textContent || "",
      /图片将随消息交给上游模型处理/,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!.disabled,
      false,
    );
    assert.equal(imageMenuItem().disabled, false);
    assert.match(
      imageMenuItem().textContent || "",
      /图片将随消息交给上游模型处理/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Primary failure keeps cached image capability unconfirmed without locking the draft", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const imageModel = {
    provider: "test",
    id: "cached-image",
    name: "Cached image",
    input: ["text", "image"],
    reasoning: true,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: imageModel },
      models: [imageModel],
      primaryRuntime: {
        status: "failed" as const,
        generation: 2,
        error: "simulated failure",
      },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(
      ".composer textarea",
    )!;
    assert.equal(input.disabled, false);
    assert.doesNotMatch(input.placeholder, /Pi Runtime 当前不可用；恢复 ready 后才能输入/);
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.disabled,
      false,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("ChatInput forwards an image draft without a client model-capability gate", async () => {
  const { dom } = installDom();
  Object.assign(globalThis, { FileReader: dom.window.FileReader });
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const sent: unknown[][] = [];
  const errors: string[] = [];
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const render = (acceptsImages: boolean) =>
    createElement(ChatInput, {
      streaming: false,
      stopping: false,
      disabled: false,
      submissionScope: "session:image-capability",
      acceptsImages,
      commands: [],
      onSend: async (message: string, images: unknown[]) => { sent.push([message, images]); },
      onAbort: async () => undefined,
      onPickLocalFiles: async () => [],
      onError: (message: string) => { errors.push(message); },
    });
  try {
    await act(async () => root.render(render(false)));
    const fileInput = dom.window.document.querySelector<HTMLInputElement>(
      "input[type='file']",
    )!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new dom.window.File(["image"], "retained.png", { type: "image/png" })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 250;
      while (!dom.window.document.querySelector(".image-preview") && Date.now() < deadline)
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    assert.ok(
      dom.window.document.querySelector(".image-preview"),
      "a Composer accepts an image before upstream handling",
    );
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "send retained image");
      textarea.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "send retained image",
      }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
    });
    assert.equal(sent.length, 1, "an image is forwarded even when model metadata omits image input");
    assert.equal(sent[0]?.[0], "send retained image");
    assert.equal((sent[0]?.[1] as unknown[])?.length, 1);
    assert.deepEqual(errors, [], "model capability metadata does not create a client error");
    assert.equal(dom.window.document.querySelector(".image-preview"), null, "the forwarded image leaves the draft");
  } finally {
    await act(async () => root.unmount());
  }
});
