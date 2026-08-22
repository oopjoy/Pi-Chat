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

test("Files tab lazily expands workspace directories and previews text files", async () => {
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
  const requests: string[] = [];
  const listWorkspaceFiles = async (_sessionId: string, dir: string) => {
    requests.push(`dir=${dir}`);
    return dir === "src"
      ? { dir, entries: [{ name: "app.ts", type: "file" as const }], truncated: false }
      : { dir, entries: [{ name: "src", type: "directory" as const }, { name: "README.md", type: "file" as const }], truncated: false };
  };
  const readWorkspaceFile = async (_sessionId: string, path: string) => {
    requests.push(`path=${path}`);
    return { path, name: "app.ts", size: 24, text: "export const value = 1;\n", truncated: false, encodingLossy: false };
  };

  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  try {
    await act(async () => root.render(createElement(EditDiffSidebar, {
      open: true,
      width: 460,
      sessionId: "0123456789abcdefabcd",
      workspacePath: "C:/work/demo",
      listWorkspaceFiles,
      readWorkspaceFile,
      onOpenChange() {},
      onWidthChange() {},
    })));
    await settle(() => Boolean(dom.window.document.querySelector(".workspace-file-row.is-directory")));
    assert.match(dom.window.document.querySelector(".workspace-files-toolbar")?.textContent || "", /C:\/work\/demo/);
    const folder = dom.window.document.querySelector<HTMLButtonElement>(".workspace-file-row.is-directory")!;
    await act(async () => folder.click());
    await settle(() => Boolean(dom.window.document.querySelector(".workspace-file-row.is-file[title='src/app.ts']")));
    const file = dom.window.document.querySelector<HTMLButtonElement>(".workspace-file-row.is-file[title='src/app.ts']")!;
    await act(async () => file.click());
    await settle(() => (dom.window.document.querySelector(".workspace-file-preview pre")?.textContent || "").includes("export const value"));
    assert.ok(requests.includes("dir=src"));
    assert.ok(requests.includes("path=src/app.ts"));
    assert.equal(dom.window.document.querySelector(".workspace-inspector-header button.is-active")?.textContent, "Files");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a delayed directory response cannot overwrite a later revisit to the same Session", async () => {
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
  const sessionA = "aaaaaaaaaaaaaaaaaaaa";
  const sessionB = "bbbbbbbbbbbbbbbbbbbb";
  let aCalls = 0;
  let resolveOldA!: (value: { dir: string; entries: Array<{ name: string; type: "file" }>; truncated: boolean }) => void;
  const oldA = new Promise<{ dir: string; entries: Array<{ name: string; type: "file" }>; truncated: boolean }>((resolve) => { resolveOldA = resolve; });
  const listWorkspaceFiles = async (sessionId: string, dir: string) => {
    if (sessionId === sessionA && ++aCalls === 1) return oldA;
    return { dir, entries: [{ name: sessionId === sessionA ? "new-a.txt" : "b.txt", type: "file" as const }], truncated: false };
  };
  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  const render = (sessionId: string) => root.render(createElement(EditDiffSidebar, {
    open: true,
    width: 460,
    sessionId,
    workspacePath: `C:/work/${sessionId}`,
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
    await act(async () => resolveOldA({ dir: "", entries: [{ name: "old-a.txt", type: "file" }], truncated: false }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.ok(dom.window.document.querySelector("[title='new-a.txt']"));
    assert.equal(dom.window.document.querySelector("[title='old-a.txt']"), null);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a delayed file preview cannot return after navigating away and revisiting", async () => {
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
    listWorkspaceFiles: async (_sessionId: string, dir: string) => ({ dir, entries: [{ name: sessionId === sessionA ? "a.txt" : "b.txt", type: "file" }], truncated: false }),
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
