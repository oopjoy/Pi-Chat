import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
import type { BootstrapData, SessionViewData } from "../../src/shared/types";
import { activeSessionId as activeId, createBootstrapFixture, createSessionViewFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom as installDom } from "../helpers/app-dom";

let bootstrap: BootstrapData;
let draftView: SessionViewData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
  draftView = createSessionViewFixture();
});


test("an observed epoch replacement clears a stale ask questionnaire", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, workspaceEpoch: "epoch-a" }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    invalidateHandshake: () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "tool_execution_start",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "ask_user_question",
        toolCallId: "ask-epoch-a",
        args: {
          questions: [{
            question: "Epoch A question?",
            header: "Epoch A",
            options: [
              { label: "One", description: "first" },
              { label: "Two", description: "second" },
            ],
          }],
        },
      }),
    );
    assert.match(dom.window.document.body.textContent || "", /Epoch A question\?/);

    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-b",
            workspaceEpoch: "epoch-b",
          }),
        }),
      ),
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /Epoch A question\?/,
      "B must not inherit A's extension-owned questionnaire",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a replacement clears the old Primary readiness generation before accepting its lower generation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let resolveReplacementBootstrap!: (value: BootstrapData) => void;
  const pendingReplacementBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveReplacementBootstrap = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1
        ? {
            ...bootstrap,
            workspaceEpoch: "epoch-a",
            primaryRuntime: { status: "ready" as const, generation: 7 },
          }
        : pendingReplacementBootstrap;
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    invalidateHandshake: () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const model = () =>
      dom.window.document.querySelector<HTMLButtonElement>(
        ".composer-model-select .compact-select-trigger",
      )!;
    assert.equal(
      model().disabled,
      false,
      "A's confirmed ready generation enables model settings",
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-b",
            workspaceEpoch: "epoch-b",
          }),
        }),
      ),
    );
    assert.equal(bootstrapCalls, 2);
    assert.equal(
      model().disabled,
      false,
      "B starts with no inherited ready capability but retains an editable staged selection",
    );
    assert.equal(
      dom.window.document
        .querySelector(".primary-runtime-status")
        ?.classList.contains("is-starting"),
      true,
    );
    await act(async () => {
      resolveReplacementBootstrap({
        ...bootstrap,
        workspaceEpoch: "epoch-b",
        primaryRuntime: { status: "starting", generation: 1 },
      });
      await Promise.resolve();
    });
    assert.equal(
      model().disabled,
      false,
      "B starting generation 1 keeps settings editable while capability remains pending",
    );
    await act(async () =>
      source.emitPi({
        type: "pi_chat_primary_runtime_status",
        primaryRuntime: { status: "ready", generation: 1 },
      }),
    );
    assert.equal(
      model().disabled,
      false,
      "B ready generation 1 is accepted after the replacement reset",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a replacement process workspace epoch accepts its fresh default after an older high revision", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1
        ? {
            ...bootstrap,
            workspaceCwd: "C:/old-default",
            workspaceEpoch: "workspace-old",
            workspaceRevision: 900,
          }
        : {
            ...bootstrap,
            workspaceCwd: "D:/replacement-default",
            workspaceEpoch: "workspace-new",
            workspaceRevision: 0,
          };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async () => ({ viewing: "" }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "workspace-new",
            workspaceEpoch: "workspace-new",
          }),
        }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const newButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton.click());
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "D:/replacement-default",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("resource reload clears Runtime overlays without discarding the New Composer draft", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async () => ({ viewing: "" }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const newButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "New");
    assert.ok(newButton);
    await act(async () => newButton.click());
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(textarea, "draft survives resource reload");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "draft survives resource reload" }));
    });
    assert.ok(dom.window.document.querySelector(".welcome"), "a local New draft keeps its welcome while text is being composed");
    assert.ok(dom.window.document.querySelector(".welcome-mark"), "a local New draft keeps the Pi mark while text is being composed");
    assert.ok(dom.window.document.querySelector(".draft-workspace"), "a local New draft keeps its workspace path while text is being composed");
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({ type: "pi_chat_application_lifecycle", lifecycle: "resources-reloading" }));
    assert.equal(textarea.value, "draft survives resource reload");
    assert.match(dom.window.document.body.textContent || "", /正在更新配置并重载 Runtime/);
    assert.equal(dom.window.document.querySelector(".welcome"), null, "maintenance status temporarily replaces the decorative welcome");
    await act(async () => source.emitPi({ type: "pi_chat_application_lifecycle", lifecycle: "idle" }));
    assert.equal(textarea.value, "draft survives resource reload");
    assert.ok(dom.window.document.querySelector(".welcome"), "the New welcome returns with the preserved draft after maintenance");
    assert.ok(dom.window.document.querySelector(".welcome-mark"));
    assert.ok(dom.window.document.querySelector(".draft-workspace"));
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("lifecycle idle consumes replacement bootstrap accounting before a later ready", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const { dom, FakeEventSource } = installDom();
    const { createRoot } = await import("react-dom/client");
    const { api } = await import("../../src/web/api");
    const { App } = await import("../../src/web/App");
    const restoreApi = captureApiSnapshot(api);
    let bootstrapCalls = 0;
    let rejectReplacementBootstrap!: (cause: Error) => void;
    const rejectedReplacementBootstrap = new Promise<BootstrapData>(
      (_resolve, reject) => {
        rejectReplacementBootstrap = reject;
      },
    );
    Object.assign(api, {
      bootstrap: async () => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) return bootstrap;
        if (bootstrapCalls === 2 && outcome === "failure")
          return rejectedReplacementBootstrap;
        return { ...bootstrap, workspaceEpoch: `epoch-lifecycle-${outcome}` };
      },
      eventsUrl: () => "/api/events",
      markSessionViewed: async () => ({ viewing: activeId }),
      invalidateHandshake: () => undefined,
    });
    const root = createRoot(dom.window.document.querySelector("#root")!);
    try {
      await act(async () => root.render(createElement(App)));
      const source = FakeEventSource.instances.at(-1)!;
      await act(async () =>
        source.dispatchEvent(
          new dom.window.MessageEvent("ready", {
            data: JSON.stringify({
              lifecycle: "workspace-changing",
              piChatRunEpoch: `epoch-lifecycle-${outcome}`,
              workspaceEpoch: `epoch-lifecycle-${outcome}`,
            }),
          }),
        ),
      );
      await act(async () =>
        source.emitPi({
          type: "pi_chat_application_lifecycle",
          lifecycle: "idle",
        }),
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      assert.equal(
        bootstrapCalls,
        2,
        "lifecycle idle starts B's first bootstrap exactly once",
      );
      const newButton = [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "New")!;
      assert.equal(
        newButton.disabled,
        false,
        "lifecycle idle immediately releases maintenance locks",
      );
      if (outcome === "failure") {
        await act(async () => {
          rejectReplacementBootstrap(
            new Error("B lifecycle bootstrap unavailable"),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      await act(async () => {
        source.dispatchEvent(
          new dom.window.MessageEvent("ready", {
            data: JSON.stringify({
              lifecycle: "idle",
              piChatRunEpoch: `epoch-lifecycle-${outcome}`,
              workspaceEpoch: `epoch-lifecycle-${outcome}`,
            }),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        bootstrapCalls,
        outcome === "failure" ? 3 : 2,
        "ready does not duplicate a successful lifecycle bootstrap and retries one failed B bootstrap",
      );
      await act(async () =>
        source.dispatchEvent(
          new dom.window.MessageEvent("ready", {
            data: JSON.stringify({
              lifecycle: "idle",
              piChatRunEpoch: `epoch-lifecycle-${outcome}`,
              workspaceEpoch: `epoch-lifecycle-${outcome}`,
            }),
          }),
        ),
      );
      assert.equal(
        bootstrapCalls,
        outcome === "failure" ? 3 : 2,
        "repeated ready remains bounded",
      );
    } finally {
      await act(async () => root.unmount());
      restoreApi();
    }
  }
});
