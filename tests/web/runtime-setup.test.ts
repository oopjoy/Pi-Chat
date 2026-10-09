import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import type { RuntimeSetupChange, RuntimeSetupStatus } from "../../src/shared/runtime-setup";
import { createBootstrapFixture, activeSessionId } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom } from "../helpers/app-dom";

const candidate = { entry: "C:\\Pi\\dist\\rpc-entry.js", version: "1.1.0" };
const status: RuntimeSetupStatus = { current: null, configured: candidate, automatic: candidate, source: "automatic", environmentOverride: false, configurationRevision: "a".repeat(64), pickerAvailable: true, restartAvailable: true };
async function mount(running = false) {
  const { dom, FakeEventSource } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => { const data = createBootstrapFixture(); return { ...data, sessions: data.sessions.map(session => ({ ...session, running })), primaryRuntime: { status: "failed" as const, generation: 1, error: "Pi not found" } }; },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeSessionId }),
    runtimeSetup: async () => status,
    pickRuntimeEntry: async () => ({ candidate }),
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(createElement(App)));
  const button = (text: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === text)!;
  return { dom, FakeEventSource, api, button, async close() { await act(async () => root.unmount()); restoreApi(); } };
}

test("failed Pi exposes setup without remounting the Composer and selection needs explicit confirmation", async () => {
  const f = await mount();
  const changes: RuntimeSetupChange[] = [];
  try {
    const input = f.dom.window.document.querySelector("textarea");
    f.api.restartRuntime = async change => { changes.push(change); throw new Error("fixture restart blocked"); };
    await act(async () => f.button("连接设置 / 重试").click());
    assert.match(f.dom.window.document.body.textContent || "", /当前服务入口/);
    assert.equal(f.dom.window.document.querySelector("textarea"), input);
    await act(async () => f.button("选择 rpc-entry.js").click());
    assert.deepEqual(changes, []);
    f.dom.window.confirm = () => false;
    await act(async () => f.button("保存入口并重启服务").click());
    assert.deepEqual(changes, []);
    f.dom.window.confirm = () => true;
    await act(async () => f.button("保存入口并重启服务").click());
    assert.deepEqual(changes, [{ mode: "select", entry: candidate.entry, configurationRevision: status.configurationRevision }]);
    assert.match(f.dom.window.document.querySelector('[role="alert"]')?.textContent || "", /fixture restart blocked/);
    assert.equal(f.button("保存入口并重启服务").disabled, false);
  } finally { await f.close(); }
});

test("runtime setup ignores a late detection result after close and reopen", async () => {
  const f = await mount();
  let resolveOld!: (value: RuntimeSetupStatus) => void;
  const held = new Promise<RuntimeSetupStatus>(resolve => { resolveOld = resolve; });
  try {
    f.api.runtimeSetup = () => held;
    await act(async () => { f.button("连接设置 / 重试").click(); });
    await act(async () => f.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="关闭 Pi 连接设置"]')!.click());
    f.api.runtimeSetup = async () => ({ ...status, configured: { ...candidate, entry: "C:\\New\\dist\\rpc-entry.js" } });
    await act(async () => f.button("连接设置 / 重试").click());
    await act(async () => resolveOld({ ...status, error: "STALE_ERROR" }));
    const dialog = f.dom.window.document.querySelector(".runtime-setup-dialog")!;
    assert.match(dialog.textContent || "", /New/);
    assert.doesNotMatch(dialog.textContent || "", /STALE_ERROR/);
  } finally { resolveOld(status); await f.close(); }
});

test("service replacement discards the old setup dialog and its delayed response", async () => {
  const f = await mount();
  let resolveOld!: (value: RuntimeSetupStatus) => void;
  try {
    f.api.runtimeSetup = () => new Promise(resolve => { resolveOld = resolve; });
    f.api.invalidateHandshake = () => undefined;
    await act(async () => f.button("连接设置 / 重试").click());
    f.api.bootstrap = async () => ({ ...createBootstrapFixture(), workspaceEpoch: "epoch-b" });
    await act(async () => f.FakeEventSource.instances.at(-1)!.dispatchEvent(new f.dom.window.MessageEvent("ready", { data: JSON.stringify({ lifecycle: "idle", piChatRunEpoch: "epoch-b", workspaceEpoch: "epoch-b" }) })));
    await act(async () => resolveOld({ ...status, error: "OLD_PROCESS_CONFIGURATION" }));
    assert.equal(f.dom.window.document.querySelector(".runtime-setup-dialog"), null);
    assert.doesNotMatch(f.dom.window.document.body.textContent || "", /OLD_PROCESS_CONFIGURATION/);
  } finally { resolveOld?.(status); await f.close(); }
});

test("environment override disables entry replacement but permits explicit retry", async () => {
  const f = await mount();
  try {
    f.api.runtimeSetup = async () => ({ ...status, source: "environment", environmentOverride: true });
    await act(async () => f.button("连接设置 / 重试").click());
    assert.equal(f.button("选择 rpc-entry.js").disabled, true);
    assert.equal(f.button("使用自动发现").disabled, true);
    assert.equal(f.button("重试连接（重启服务）").disabled, false);
    assert.match(f.dom.window.document.querySelector(".runtime-setup-dialog")?.textContent || "", /不会覆盖/);
  } finally { await f.close(); }
});

test("cancelled native selection does not clear the existing candidate", async () => {
  const f = await mount();
  try {
    f.api.pickRuntimeEntry = async () => ({ candidate: null });
    await act(async () => f.button("连接设置 / 重试").click());
    await act(async () => f.button("选择 rpc-entry.js").click());
    assert.equal(f.button("重试连接（重启服务）").disabled, false);
    assert.match(f.dom.window.document.querySelector(".runtime-setup-dialog")?.textContent || "", /C:\\Pi/);
  } finally { await f.close(); }
});

test("runtime setup restart admission disables applying when another Session is running", async () => {
  const f = await mount(true);
  try {
    f.api.restartRuntime = async () => { throw new Error("must stay blocked"); };
    await act(async () => f.button("连接设置 / 重试").click());
    assert.equal(f.button("重试连接（重启服务）").disabled, true);
    assert.equal(f.button("重新检测").disabled, false, "read-only detection remains available");
    assert.match(f.dom.window.document.querySelector(".runtime-setup-dialog")?.textContent || "", /最终以服务端空闲检查为准/);
  } finally { await f.close(); }
});
