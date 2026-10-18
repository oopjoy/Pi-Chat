import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { installAppDom } from "../helpers/app-dom";
import type { SessionSummary } from "../../src/shared/types";

const session: SessionSummary = {
  id: "a13c9d8a978daa0efb0b",
  sessionId: "first",
  name: "Topbar session",
  preview: "",
  cwd: "C:/work",
  updatedAt: Date.now(),
  messageCount: 2,
  active: true,
};

async function mountTopBar(overrides: Record<string, unknown> = {}) {
  const fixture = installAppDom();
  const { dom } = fixture;
  const { createRoot } = await import("react-dom/client");
  const { TopBar } = await import("../../src/web/components/TopBar");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const events: string[] = [];
  await act(async () => root.render(createElement(TopBar, {
    sessionId: session.id,
    conversationName: session.name,
    workspacePath: session.cwd,
    buildIdentity: "build test",
    settingsOpen: false,
    onOpenSettings: () => events.push("settings"),
    diffSidebarOpen: false,
    onToggleDiffSidebar: () => events.push("sidebar"),
    onOpenSubagentSession: () => undefined,
    sessionMenu: {
      session,
      pinnedSessionIds: [],
      mutationBusy: false,
      onTogglePin: (id) => events.push(`pin:${id}`),
      onClone: (value) => events.push(`clone:${value.id}`),
      onCopyDeepLink: async (id) => events.push(`deep:${id}`),
      onRename: (value) => events.push(`rename:${value.id}`),
      onDelete: (value) => events.push(`delete:${value.id}`),
    },
    ...overrides,
  })));
  return {
    dom, root, events, fixture,
    async click(name: string) {
      const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find((item) => item.textContent === name);
      assert.ok(button, name);
      await act(async () => button.click());
    },
    async close() { await act(async () => root.unmount()); fixture.dispose(); },
  };
}

test("the TopBar three-dot menu exposes the same session operations", async () => {
  const f = await mountTopBar();
  try {
    assert.equal(f.dom.window.document.querySelector(".topbar-session-actions-menu"), null, "menu closed initially");
    await act(async () => f.dom.window.document.querySelector<HTMLButtonElement>(".topbar-session-actions-trigger")!.click());
    const entries = [...f.dom.window.document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].map((button) => button.textContent);
    assert.deepEqual(entries, ["置顶", "复制为新对话", "复制深度链接", "重命名", "删除"]);
    for (const [index, expected] of [["置顶", "pin:a13c9d8a978daa0efb0b"], ["复制为新对话", "clone:a13c9d8a978daa0efb0b"], ["复制深度链接", "deep:a13c9d8a978daa0efb0b"], ["重命名", "rename:a13c9d8a978daa0efb0b"], ["删除", "delete:a13c9d8a978daa0efb0b"]] as const) {
      await act(async () => f.dom.window.document.querySelector<HTMLButtonElement>(".topbar-session-actions-trigger")!.click());
      await f.click(index);
      assert.equal(f.events.at(-1), expected);
      assert.equal(f.dom.window.document.querySelector(".topbar-session-actions-menu"), null, "menu closes after an action");
    }
  } finally { await f.close(); }
});

test("the TopBar menu is absent for subagent views and disabled while another mutation is unconfirmed", async () => {
  const hidden = await mountTopBar({ subagentBreadcrumb: [{ sessionId: session.id, label: "child" }] });
  try { assert.equal(hidden.dom.window.document.querySelector(".topbar-session-actions-trigger"), null); }
  finally { await hidden.close(); }
  const busy = await mountTopBar({ sessionMenu: { session, pinnedSessionIds: [session.id], mutationBusy: true, onTogglePin: () => undefined, onClone: () => undefined, onCopyDeepLink: async () => undefined, onRename: () => undefined, onDelete: () => undefined } });
  try {
    assert.equal(busy.dom.window.document.querySelector<HTMLButtonElement>(".topbar-session-actions-trigger")!.getAttribute("aria-label"), "对话操作");
    await act(async () => busy.dom.window.document.querySelector<HTMLButtonElement>(".topbar-session-actions-trigger")!.click());
    const disabled = [...busy.dom.window.document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].filter((button) => button.disabled).map((button) => button.textContent);
    assert.deepEqual(disabled, ["复制为新对话", "重命名", "删除"]);
    assert.deepEqual(busy.dom.window.document.querySelector<HTMLButtonElement>(".topbar-session-actions-trigger")?.textContent?.includes("置顶"), false);
  } finally { await busy.close(); }
});
