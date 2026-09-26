import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import {
  isLocalFileMarkdownDestination,
  windowsPathFromMarkdownDestination,
  workspaceRelativePathFromMarkdownDestination,
} from "../src/shared/local-file-link";
import { installAppDom } from "./helpers/app-dom";

test("Windows Markdown destinations become bounded Workspace-relative paths", () => {
  const workspace = String.raw`C:\Users\opjoy`;
  const absolute = String.raw`C:\Users\opjoy\Desktop\奖学金调整\result.csv`;
  assert.equal(windowsPathFromMarkdownDestination(absolute), absolute);
  assert.equal(
    workspaceRelativePathFromMarkdownDestination(absolute, workspace),
    "Desktop/奖学金调整/result.csv",
  );
  assert.equal(
    workspaceRelativePathFromMarkdownDestination("file:///C:/Users/opjoy/Desktop/My%20Notes/result.csv", workspace),
    "Desktop/My Notes/result.csv",
  );
  assert.equal(workspaceRelativePathFromMarkdownDestination(String.raw`D:\outside\result.csv`, workspace), null);
  assert.equal(
    workspaceRelativePathFromMarkdownDestination(
      String.raw`\\server\share\project\out\result.csv`,
      String.raw`\\server\share\project`,
    ),
    "out/result.csv",
  );
  assert.equal(workspaceRelativePathFromMarkdownDestination("Desktop/%2e%2e/secret.txt", workspace), null);
  assert.equal(isLocalFileMarkdownDestination("https://example.com/result.csv"), false);
  assert.equal(isLocalFileMarkdownDestination("mailto:test@example.com"), false);
});

test("rendered local links open through Pi Chat while Web links keep normal navigation", async () => {
  const { dom } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { MarkdownBody, markdownLinkUrlTransform } = await import("../src/web/components/MarkdownBody");
  assert.equal(markdownLinkUrlTransform("https://example.com/a", "href", {}), "https://example.com/a");
  const opened: string[] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  const markdown = String.raw`[本地结果](C:\Users\opjoy\Desktop\奖学金调整\result.csv)

[外部网页](https://example.com/result)`;
  try {
    await act(async () => root.render(createElement(MarkdownBody, {
      workspacePath: String.raw`C:\Users\opjoy`,
      onOpenLocalPath: async (path: string) => { opened.push(path); },
      children: markdown,
    })));
    const links = [...dom.window.document.querySelectorAll<HTMLAnchorElement>(".markdown-body a")];
    assert.equal(links.length, 2);
    assert.match(links[0]!.className, /markdown-local-file-link/);
    assert.equal(links[0]!.getAttribute("href"), "#");
    assert.equal(links[0]!.getAttribute("target"), null);
    assert.equal(links[1]!.getAttribute("href"), "https://example.com/result");
    assert.equal(links[1]!.getAttribute("target"), "_blank");
    await act(async () => links[0]!.click());
    assert.deepEqual(opened, ["Desktop/奖学金调整/result.csv"]);
    assert.equal(dom.window.document.querySelector(".markdown-local-file-link")?.classList.contains("is-opened"), true);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a rejected local open stays on the page and shows an explicit error", async () => {
  const { dom } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { MarkdownBody } = await import("../src/web/components/MarkdownBody");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(MarkdownBody, {
      workspacePath: String.raw`C:\Users\opjoy`,
      onOpenLocalPath: async () => { throw new Error("文件链接不在当前对话的已保存回复中"); },
      children: String.raw`[结果](C:\Users\opjoy\Desktop\result.csv)`,
    })));
    await act(async () => dom.window.document.querySelector<HTMLAnchorElement>(".markdown-local-file-link")!.click());
    const error = dom.window.document.querySelector<HTMLElement>(".markdown-link-error")!;
    assert.ok(error);
    assert.equal(error.getAttribute("role"), "status");
    assert.match(error.textContent || "", /已保存回复/);
  } finally {
    await act(async () => root.unmount());
  }
});
