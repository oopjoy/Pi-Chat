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
      { key: "subagent-1", label: "实施子代理 1", status: "running", elapsedMs: 65_000, updateAgeMs: 2_000, turnCount: 2, toolCount: 4, activity: "正在运行测试" },
      { key: "subagent-6", label: "实施子代理 6", status: "waiting", elapsedMs: 1_000, updateAgeMs: 500 },
      { key: "subagent-2", label: "审阅子代理 2", status: "attention", elapsedMs: 5_000, updateAgeMs: 1_000 },
      { key: "subagent-3", label: "子代理 3", status: "complete", elapsedMs: 3_000, updateAgeMs: 8_000 },
      { key: "subagent-4", label: "子代理 4", status: "failed", elapsedMs: 4_000, updateAgeMs: 9_000 },
      { key: "subagent-5", label: "子代理 5", status: "cancelled", elapsedMs: 2_000, updateAgeMs: 10_000 },
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

test("active, attention, and terminal steps render in an accessible read-only popover", async () => {
  const dom = installDom();
  const { api } = await import("../src/web/api");
  const original = api.backgroundSubagents;
  api.backgroundSubagents = async () => snapshot();
  const { SubagentStatusControl } = await import("../src/web/components/SubagentStatusControl");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(SubagentStatusControl, { sessionId: SESSION_A })));
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await act(async () => { await Promise.resolve(); });
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!;
    assert.equal(trigger.textContent?.replace(/\s+/g, " ").trim(), "6 个子代理");
    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
    assert.ok(dom.window.document.querySelector('[role="tooltip"]')?.textContent?.includes("Queue / Steer"));

    await act(async () => trigger.click());
    const popover = dom.window.document.querySelector<HTMLElement>('[role="dialog"][aria-label="后台子代理状态"]')!;
    assert.equal(dom.window.document.activeElement, popover);
    for (const label of ["运行中", "等待中", "需要关注", "已完成", "失败", "已取消"])
      assert.ok(popover.textContent?.includes(label), label);
    assert.ok(popover.textContent?.includes("正在运行测试"));
    assert.ok(popover.textContent?.includes("Queue / Steer 始终只控制主会话"));
    assert.equal(popover.querySelectorAll("button").length, 0, "the projection exposes no child controls");

    await act(async () => popover.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
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

test("terminal-only popovers still explain main-Session Queue and Steer authority", async () => {
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
    assert.match(trigger.getAttribute("aria-label") || "", /0 个需要关注/);
    await act(async () => trigger.click());
    const text = dom.window.document.querySelector(".subagent-status-popover")?.textContent || "";
    assert.match(text, /Queue \/ Steer 始终只控制主会话/);
    assert.match(text, /优先级最高的 24 个步骤/);
    assert.doesNotMatch(text, /最近的 24/);
  } finally {
    api.backgroundSubagents = original;
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("attention variables provide explicit light and dark theme colors", async () => {
  const css = await readFile(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(css, /:root\s*\{[^}]*--attention:\s*#704200;/s);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{[^}]*--attention:\s*#f2b33d;/s);
  assert.match(css, /\.subagent-status-row\.is-attention \.subagent-status-label \{ color: var\(--attention\)/);
  assert.match(css, /\.subagent-status-authority\.is-important \{ border-left: 3px solid var\(--attention\)/);

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
