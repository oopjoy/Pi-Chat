import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
import type { BootstrapData, ModelInfo } from "../../src/shared/types";
import { createBootstrapFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom as installDom } from "../helpers/app-dom";

let bootstrap: BootstrapData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
});

function model(id: string, name: string): ModelInfo {
  return {
    provider: "catalogue-test",
    id,
    name,
    api: "openai-completions",
    reasoning: true,
  };
}

function bootstrapWithModel(
  selected: ModelInfo,
  revision: number,
): BootstrapData {
  return {
    ...bootstrap,
    state: { ...bootstrap.state, model: selected },
    models: [selected],
    modelInventoryPending: false,
    modelRuntimeSyncPending: false,
    modelCatalogueRevision: revision,
  };
}

async function modelOptions(dom: ReturnType<typeof installDom>["dom"]) {
  await act(async () => {
    dom.window.document.querySelector<HTMLButtonElement>(
      ".composer-model-select .compact-select-trigger",
    )!.click();
  });
  return [...dom.window.document.querySelectorAll<HTMLElement>(
    ".composer-model-select .compact-select-option",
  )].map((option) => option.textContent || "");
}

test("same-revision model SSE refinement fences a held Bootstrap", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const initial = model("initial", "Initial model");
  const stale = model("stale", "Stale Bootstrap model");
  const refined = model("refined", "Refined SSE model");
  let bootstrapCalls = 0;
  let resolveHeld!: (value: BootstrapData) => void;
  const held = new Promise<BootstrapData>((resolve) => { resolveHeld = resolve; });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1
        ? bootstrapWithModel(initial, 1)
        : held;
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: bootstrap.sessions[0].id }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({ type: "pi_chat_sse_resync" });
      await Promise.resolve();
    });
    assert.equal(bootstrapCalls, 2);
    await act(async () => {
      source.emitPi({
        type: "pi_chat_models_updated",
        models: [refined],
        revision: 2,
        runtimeSync: "ready",
      });
      resolveHeld(bootstrapWithModel(stale, 2));
      await held;
      await Promise.resolve();
    });
    const options = await modelOptions(dom);
    assert.ok(
      options.some((text) => text.includes("Refined SSE model")),
      "the SSE catalogue survives; a separately projected selected model may remain visible",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an older model-catalogue SSE revision is ignored", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const current = model("current", "Current model");
  const stale = model("older", "Older SSE model");
  Object.assign(api, {
    bootstrap: async () => bootstrapWithModel(current, 4),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: bootstrap.sessions[0].id }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "pi_chat_models_updated",
        models: [stale],
        revision: 3,
        runtimeSync: "ready",
      });
      await Promise.resolve();
    });
    const options = await modelOptions(dom);
    assert.ok(options.some((text) => text.includes("Current model")));
    assert.equal(
      options.some((text) => text.includes("Older SSE model")),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("process replacement accepts the replacement catalogue's lower revision", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const oldProcess = model("old-process", "Old process model");
  const replacement = model("replacement", "Replacement model");
  let bootstrapCalls = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1
        ? {
            ...bootstrapWithModel(oldProcess, 9),
            workspaceEpoch: "epoch-a",
          }
        : {
            ...bootstrapWithModel(replacement, 1),
            workspaceEpoch: "epoch-b",
          };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: bootstrap.sessions[0].id }),
    invalidateHandshake: () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.dispatchEvent(new dom.window.MessageEvent("ready", {
        data: JSON.stringify({
          lifecycle: "idle",
          piChatRunEpoch: "epoch-b",
          workspaceEpoch: "epoch-b",
        }),
      }) as unknown as Event);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(bootstrapCalls, 2);
    const options = await modelOptions(dom);
    assert.ok(options.some((text) => text.includes("Replacement model")));
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
