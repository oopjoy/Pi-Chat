import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { EditDiffSidebar } from "../src/web/components/EditToolDiff";

async function settle(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for inspector state");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://127.0.0.1:30170/" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "setPointerCapture", { value() {}, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "releasePointerCapture", { value() {}, configurable: true });
  return dom;
}

test("Files tab lists recent Session mutations, previews text, and resizes its split", async () => {
  const dom = installDom();
  const requests: string[] = [];
  const listWorkspaceFiles = async (sessionId: string) => {
    requests.push(`list=${sessionId}`);
    return {
      files: [
        { path: "src/app.ts", name: "app.ts", operation: "edit" as const, modifiedAt: 20 },
        { path: "docs/new.md", name: "new.md", operation: "write" as const, modifiedAt: 10 },
      ],
      truncated: false,
    };
  };
  const readWorkspaceFile = async (_sessionId: string, path: string) => {
    requests.push(`path=${path}`);
    return { path, name: "app.ts", size: 24, text: `export const value = "${"x".repeat(300)}";\n`, truncated: false, encodingLossy: false };
  };
  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  try {
    await act(async () => root.render(createElement(EditDiffSidebar, {
      open: true,
      width: 460,
      sessionId: "0123456789abcdefabcd",
      workspacePath: "C:/work/demo",
      workspaceActivityRevision: "edit-1",
      listWorkspaceFiles,
      readWorkspaceFile,
      onOpenChange() {},
      onWidthChange() {},
    })));
    await settle(() => Boolean(dom.window.document.querySelector("[title='src/app.ts']")));
    assert.match(dom.window.document.querySelector(".workspace-files-toolbar")?.textContent || "", /最近修改/);
    assert.equal(dom.window.document.querySelector(".workspace-file-row.is-directory"), null);
    assert.equal(dom.window.document.querySelector("[title='src/app.ts'] em")?.textContent, "Edit");
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>("[title='src/app.ts']")!.click());
    await settle(() => (dom.window.document.querySelector(".workspace-file-preview pre")?.textContent || "").includes("export const value"));
    assert.ok(requests.includes("path=src/app.ts"));
    const preview = dom.window.document.querySelector<HTMLPreElement>(".workspace-file-preview pre")!;
    assert.equal(preview.tabIndex, 0);
    const splitter = dom.window.document.querySelector<HTMLElement>(".workspace-files-splitter")!;
    assert.equal(splitter.getAttribute("aria-orientation"), "horizontal");
    await act(async () => splitter.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    assert.equal(dom.window.document.querySelector<HTMLElement>(".workspace-files-list")?.style.height, "200px");
    assert.equal(dom.window.document.querySelector(".workspace-inspector-header button.is-active")?.textContent, "Files");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a delayed recent-file response cannot overwrite a later revisit to the same Session", async () => {
  const dom = installDom();
  const sessionA = "aaaaaaaaaaaaaaaaaaaa";
  const sessionB = "bbbbbbbbbbbbbbbbbbbb";
  let aCalls = 0;
  let resolveOldA!: (value: { files: Array<{ path: string; name: string; operation: "edit" }>; truncated: boolean }) => void;
  const oldA = new Promise<{ files: Array<{ path: string; name: string; operation: "edit" }>; truncated: boolean }>((resolve) => { resolveOldA = resolve; });
  const listWorkspaceFiles = async (sessionId: string) => {
    if (sessionId === sessionA && ++aCalls === 1) return oldA;
    const name = sessionId === sessionA ? "new-a.txt" : "b.txt";
    return { files: [{ path: name, name, operation: "edit" as const }], truncated: false };
  };
  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  const render = (sessionId: string) => root.render(createElement(EditDiffSidebar, {
    open: true,
    width: 460,
    sessionId,
    workspacePath: `C:/work/${sessionId}`,
    workspaceActivityRevision: "revision",
    listWorkspaceFiles,
    readWorkspaceFile: async (_sessionId: string, path: string) => ({ path, name: path, size: 0, text: "", truncated: false, encodingLossy: false }),
    onOpenChange() {},
    onWidthChange() {},
  }));
  try {
    await act(async () => render(sessionA));
    await act(async () => render(sessionB));
    await settle(() => Boolean(dom.window.document.querySelector("[title='b.txt']")));
    await act(async () => render(sessionA));
    await settle(() => Boolean(dom.window.document.querySelector("[title='new-a.txt']")));
    await act(async () => resolveOldA({ files: [{ path: "old-a.txt", name: "old-a.txt", operation: "edit" }], truncated: false }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.ok(dom.window.document.querySelector("[title='new-a.txt']"));
    assert.equal(dom.window.document.querySelector("[title='old-a.txt']"), null);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a delayed file preview cannot return after navigating away and revisiting", async () => {
  const dom = installDom();
  const sessionA = "aaaaaaaaaaaaaaaaaaaa";
  const sessionB = "bbbbbbbbbbbbbbbbbbbb";
  let resolveOld!: (value: { path: string; name: string; size: number; text: string; truncated: boolean; encodingLossy: boolean }) => void;
  const oldPreview = new Promise<{ path: string; name: string; size: number; text: string; truncated: boolean; encodingLossy: boolean }>((resolve) => { resolveOld = resolve; });
  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  const render = (sessionId: string) => root.render(createElement(EditDiffSidebar, {
    open: true,
    width: 460,
    sessionId,
    workspacePath: `C:/work/${sessionId}`,
    workspaceActivityRevision: "revision",
    listWorkspaceFiles: async () => {
      const name = sessionId === sessionA ? "a.txt" : "b.txt";
      return { files: [{ path: name, name, operation: "edit" }], truncated: false };
    },
    readWorkspaceFile: async () => oldPreview,
    onOpenChange() {},
    onWidthChange() {},
  }));
  try {
    await act(async () => render(sessionA));
    await settle(() => Boolean(dom.window.document.querySelector("[title='a.txt']")));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>("[title='a.txt']")!.click());
    await act(async () => render(sessionB));
    await act(async () => render(sessionA));
    await settle(() => Boolean(dom.window.document.querySelector("[title='a.txt']")));
    await act(async () => resolveOld({ path: "a.txt", name: "a.txt", size: 3, text: "OLD", truncated: false, encodingLossy: false }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(dom.window.document.querySelector(".workspace-file-preview pre"), null);
    assert.equal(dom.window.document.querySelector(".workspace-file-row.is-selected"), null);
  } finally {
    await act(async () => root.unmount());
  }
});
