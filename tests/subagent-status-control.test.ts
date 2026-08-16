import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { BackgroundSubagentSnapshot } from "../src/shared/types";

const SESSION_A = "aaaaaaaaaaaaaaaaaaaa";
const SESSION_B = "bbbbbbbbbbbbbbbbbbbb";
const EMPTY: BackgroundSubagentSnapshot = { total: 0, activeCount: 0, attentionCount: 0, truncated: false, steps: [] };

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div><button id='outside'>outside</button></body></html>", { url: "http://127.0.0.1" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return dom;
}

function snapshot(): BackgroundSubagentSnapshot {
  return {
    total: 6,
    activeCount: 1,
    attentionCount: 1,
    truncated: false,
    steps: [
      { key: "subagent-1", label: "运行测试", status: "running", elapsedMs: 65_000, updateAgeMs: 2_000, activity: "正在运行测试", childSessionId: "11111111111111111111" },
      { key: "subagent-6", label: "等待实施", status: "waiting", elapsedMs: 1_000, updateAgeMs: 500, childSessionId: "66666666666666666666" },
      { key: "subagent-2", label: "检查边界", status: "attention", elapsedMs: 5_000, updateAgeMs: 1_000, childSessionId: "22222222222222222222" },
      { key: "subagent-3", label: "完成审阅", status: "complete", elapsedMs: 3_000, updateAgeMs: 8_000, childSessionId: "33333333333333333333" },
      { key: "subagent-4", label: "失败任务", status: "failed", elapsedMs: 4_000, updateAgeMs: 9_000, childSessionId: "44444444444444444444" },
      { key: "subagent-5", label: "取消任务", status: "cancelled", elapsedMs: 2_000, updateAgeMs: 10_000 },
    ],
  };
}

test("zero background Subagents keep the top-bar control hidden", async () => {
  const dom = installDom();
  const { api } = await import("../src/web/api");
  const original = api.backgroundSubagents;
  api.backgroundSubagents = async () => EMPTY;
  const { SubagentStatusControl } = await import("../src/web/components/SubagentStatusControl");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(SubagentStatusControl, { sessionId: SESSION_A })));
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await act(async () => { await Promise.resolve(); });
    assert.equal(dom.window.document.querySelector(".subagent-status-trigger"), null);
  } finally {
    api.backgroundSubagents = original;
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("empty discovery retries quickly and active rows survive a transient failure", async () => {
  const dom = installDom();
  const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
  const delays: number[] = [];
  dom.window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    delays.push(Number(timeout || 0));
    return nativeSetTimeout(handler, timeout, ...args);
  }) as typeof dom.window.setTimeout;
  const { api } = await import("../src/web/api");
  const original = api.backgroundSubagents;
  let current: BackgroundSubagentSnapshot | Error = EMPTY;
  api.backgroundSubagents = async () => {
    if (current instanceof Error) throw current;
    return current;
  };
  const { SubagentStatusControl } = await import("../src/web/components/SubagentStatusControl");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(SubagentStatusControl, { sessionId: SESSION_A })));
    await act(async () => { await Promise.resolve(); });
    assert.ok(delays.includes(500), `expected fast discovery retry, saw ${delays.join(",")}`);

    current = snapshot();
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await act(async () => { await Promise.resolve(); });
    assert.ok(dom.window.document.querySelector(".subagent-status-trigger"));
    assert.ok(delays.includes(750), `expected active cadence, saw ${delays.join(",")}`);

    current = new Error("temporary read failure");
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await act(async () => { await Promise.resolve(); });
    assert.ok(dom.window.document.querySelector(".subagent-status-trigger"), "last rows remain visible through failure");
  } finally {
    api.backgroundSubagents = original;
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("Subagent rows stay compact, navigable, and free of low-value status copy", async () => {
  const dom = installDom();
  const { api } = await import("../src/web/api");
  const original = api.backgroundSubagents;
  api.backgroundSubagents = async () => snapshot();
  const opened: string[][] = [];
  const { SubagentStatusControl } = await import("../src/web/components/SubagentStatusControl");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(SubagentStatusControl, {
      sessionId: SESSION_A,
      onOpenSession: (parent, child, label) => opened.push([parent, child, label]),
    })));
    await act(async () => { await Promise.resolve(); });
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!;
    assert.equal(trigger.textContent?.replace(/\s+/g, " ").trim(), "6 个子代理");
    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
    assert.equal(dom.window.document.querySelector('[role="tooltip"]')?.textContent, "查看后台子代理对话");

    await act(async () => trigger.click());
    const popover = dom.window.document.querySelector<HTMLElement>('[role="dialog"][aria-label="后台子代理"]')!;
    const rows = [...popover.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    assert.equal(rows.length, 6);
    assert.equal(dom.window.document.activeElement, rows[0]);
    assert.ok(popover.textContent?.includes("正在运行测试"));
    for (const removed of ["需要关注", "只读状态", "Queue / Steer", "次工具", "轮"])
      assert.equal(popover.textContent?.includes(removed), false, removed);
    assert.equal(popover.querySelector(".subagent-status-authority"), null);

    await act(async () => rows[0]?.click());
    assert.deepEqual(opened, [[SESSION_A, "11111111111111111111", "运行测试"]]);
    assert.equal(dom.window.document.querySelector(".subagent-status-popover"), null);

    await act(async () => trigger.click());
    const first = dom.window.document.querySelector<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])')!;
    await act(async () => first.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(dom.window.document.querySelector(".subagent-status-popover"), null);
    assert.equal(dom.window.document.activeElement, trigger);

    await act(async () => trigger.click());
    await act(async () => dom.window.document.querySelector("#outside")!.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })));
    assert.equal(dom.window.document.querySelector(".subagent-status-popover"), null);
  } finally {
    api.backgroundSubagents = original;
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("an unhydrated child row receives focus and Escape restores the trigger", async () => {
  const dom = installDom();
  const { api } = await import("../src/web/api");
  const original = api.backgroundSubagents;
  api.backgroundSubagents = async () => ({
    total: 1,
    activeCount: 1,
    attentionCount: 0,
    truncated: false,
    steps: [{ key: "subagent-pending", label: "starting child", status: "running", elapsedMs: 100, updateAgeMs: 0, activity: "正在读取文件" }],
  });
  const { SubagentStatusControl } = await import("../src/web/components/SubagentStatusControl");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(SubagentStatusControl, { sessionId: SESSION_A })));
    await act(async () => { await Promise.resolve(); });
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!;
    await act(async () => trigger.click());
    const row = dom.window.document.querySelector<HTMLElement>('[role="treeitem"][aria-disabled="true"]')!;
    assert.equal(dom.window.document.activeElement, row);
    assert.match(row.textContent || "", /对话准备中/);
    assert.match(row.textContent || "", /正在读取文件/);
    assert.match(row.getAttribute("aria-label") || "", /对话准备中.*正在读取文件/);
    await act(async () => row.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(dom.window.document.querySelector(".subagent-status-popover"), null);
    assert.equal(dom.window.document.activeElement, trigger);
  } finally {
    api.backgroundSubagents = original;
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("polling aborts the old Session on navigation and cleans up on unmount", async () => {
  const dom = installDom();
  const { api } = await import("../src/web/api");
  const original = api.backgroundSubagents;
  const calls: Array<{ id: string; signal?: AbortSignal }> = [];
  api.backgroundSubagents = (id, signal) => {
    calls.push({ id, signal });
    if (id === SESSION_A) return new Promise(() => {});
    return Promise.resolve(EMPTY);
  };
  const { SubagentStatusControl } = await import("../src/web/components/SubagentStatusControl");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(SubagentStatusControl, { sessionId: SESSION_A })));
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    assert.equal(calls[0]?.id, SESSION_A);
    await act(async () => root.render(createElement(SubagentStatusControl, { sessionId: SESSION_B })));
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await act(async () => { await Promise.resolve(); });
    assert.equal(calls[0]?.signal?.aborted, true);
    assert.equal(calls.at(-1)?.id, SESSION_B);
    const lastSignal = calls.at(-1)?.signal;
    await act(async () => root.unmount());
    assert.equal(lastSignal?.aborted, true);
  } finally {
    api.backgroundSubagents = original;
    dom.window.close();
  }
});

test("an obsolete poll cannot overwrite a newer Subagent snapshot", async () => {
  const dom = installDom();
  const { api } = await import("../src/web/api");
  const original = api.backgroundSubagents;
  const resolvers: Array<(value: BackgroundSubagentSnapshot) => void> = [];
  api.backgroundSubagents = () => new Promise((resolve) => resolvers.push(resolve));
  const { SubagentStatusControl } = await import("../src/web/components/SubagentStatusControl");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(SubagentStatusControl, { sessionId: SESSION_A })));
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    assert.equal(resolvers.length, 2);
    await act(async () => { resolvers[1]?.(snapshot()); await Promise.resolve(); });
    assert.ok(dom.window.document.querySelector(".subagent-status-trigger"));
    await act(async () => { resolvers[0]?.(EMPTY); await Promise.resolve(); });
    assert.ok(dom.window.document.querySelector(".subagent-status-trigger"), "aborted older response stays fenced");
  } finally {
    api.backgroundSubagents = original;
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("desktop popover and tooltip are clamped inside the viewport", async () => {
  const dom = installDom();
  Object.defineProperty(dom.window, "innerWidth", { value: 800, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 600, configurable: true });
  const { api } = await import("../src/web/api");
  const original = api.backgroundSubagents;
  api.backgroundSubagents = async () => snapshot();
  const { SubagentStatusControl } = await import("../src/web/components/SubagentStatusControl");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(SubagentStatusControl, { sessionId: SESSION_A })));
    await act(async () => { await Promise.resolve(); });
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!;
    trigger.getBoundingClientRect = () => ({ x: 760, y: 10, left: 760, right: 800, top: 10, bottom: 38, width: 40, height: 28, toJSON: () => ({}) });
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("resize")));
    const tooltip = dom.window.document.querySelector<HTMLElement>(".subagent-status-tooltip")!;
    assert.ok(Number.parseFloat(tooltip.style.left) + Number.parseFloat(tooltip.style.width) <= 788);
    await act(async () => trigger.click());
    const popover = dom.window.document.querySelector<HTMLElement>(".subagent-status-popover")!;
    assert.ok(Number.parseFloat(popover.style.left) >= 12);
    assert.ok(Number.parseFloat(popover.style.left) + Number.parseFloat(popover.style.width) <= 788);
    assert.ok(Number.parseFloat(popover.style.maxHeight) <= 550);
  } finally {
    api.backgroundSubagents = original;
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("an open control retains stable focus when polling returns zero", async () => {
  const dom = installDom();
  const { api } = await import("../src/web/api");
  const original = api.backgroundSubagents;
  let current = snapshot();
  api.backgroundSubagents = async () => current;
  const { SubagentStatusControl } = await import("../src/web/components/SubagentStatusControl");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(SubagentStatusControl, { sessionId: SESSION_A })));
    await act(async () => { await Promise.resolve(); });
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!;
    await act(async () => trigger.click());
    assert.ok(dom.window.document.querySelector(".subagent-status-popover"));
    current = EMPTY;
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const retained = dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!;
    assert.ok(retained);
    assert.equal(retained.textContent?.includes("子代理已结束"), true);
    assert.equal(dom.window.document.querySelector(".subagent-status-popover"), null);
    assert.equal(dom.window.document.activeElement, retained);
  } finally {
    api.backgroundSubagents = original;
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("terminal-only popovers retain truncation without an authority warning row", async () => {
  const dom = installDom();
  const { api } = await import("../src/web/api");
  const original = api.backgroundSubagents;
  api.backgroundSubagents = async () => ({
    total: 25,
    activeCount: 0,
    attentionCount: 0,
    truncated: true,
    steps: snapshot().steps.filter((step) => step.status === "complete"),
  });
  const { SubagentStatusControl } = await import("../src/web/components/SubagentStatusControl");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(SubagentStatusControl, { sessionId: SESSION_A })));
    await act(async () => { await Promise.resolve(); });
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!;
    assert.doesNotMatch(trigger.getAttribute("aria-label") || "", /需要关注/);
    await act(async () => trigger.click());
    const text = dom.window.document.querySelector(".subagent-status-popover")?.textContent || "";
    assert.doesNotMatch(text, /Queue \/ Steer|只读投影|需要关注/);
    assert.match(text, /优先级最高的 24 个步骤/);
    assert.doesNotMatch(text, /最近的 24/);
  } finally {
    api.backgroundSubagents = original;
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("Subagent indicators reuse the sidebar red, yellow, green, and blue palette", async () => {
  const css = await readFile(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(css, /:root\s*\{[^}]*--attention:\s*#704200;/s);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{[^}]*--attention:\s*#f2b33d;/s);
  assert.match(css, /--status-red:\s*var\(--danger\);/);
  assert.match(css, /--status-yellow:\s*#d89318;/);
  assert.match(css, /--status-green:\s*#24a36a;/);
  assert.match(css, /--status-blue:\s*var\(--accent\);/);
  for (const status of ["unread", "pending", "error", "running"])
    assert.match(css, new RegExp(`\\.session-status\\.is-${status}[^\\n]*var\\(--status-`));
  assert.match(css, /\.subagent-status-row\.is-running \.subagent-status-dot \{ background: var\(--status-blue\)/);
  assert.match(css, /\.subagent-status-row\.is-waiting \.subagent-status-dot, \.subagent-status-row\.is-attention \.subagent-status-dot \{ background: var\(--status-yellow\)/);
  assert.match(css, /\.subagent-status-row\.is-complete \.subagent-status-dot \{ background: var\(--status-green\)/);
  assert.match(css, /\.subagent-status-row\.is-failed \.subagent-status-dot, \.subagent-status-row\.is-cancelled \.subagent-status-dot \{ background: var\(--status-red\)/);
  assert.doesNotMatch(css, /subagent-status-authority|subagent-status-label/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*\.subagent-status-row\.is-running \.subagent-status-dot \{[^}]*border: 2px solid Highlight/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*\.subagent-status-row\.is-waiting \.subagent-status-dot \{[^}]*border: 2px dashed CanvasText/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*\.subagent-status-row\.is-attention \.subagent-status-dot \{[^}]*transform: rotate\(45deg\)/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*\.subagent-status-row\.is-cancelled \.subagent-status-dot \{[^}]*height: 3px/);

  const dom = installDom();
  try {
    const style = dom.window.document.createElement("style");
    style.textContent = ":root { --attention: #704200; } :root[data-theme='dark'] { --attention: #f2b33d; }";
    dom.window.document.head.append(style);
    assert.equal(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue("--attention").trim(), "#704200");
    dom.window.document.documentElement.dataset.theme = "dark";
    assert.equal(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue("--attention").trim(), "#f2b33d");
  } finally {
    dom.window.close();
  }
});
