import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import type { useComposerController } from "../../src/web/hooks/use-composer-controller";
import { installAppDom } from "../helpers/app-dom";

type Options = Parameters<typeof useComposerController>[0];

async function fixture(
  updateAttachmentLeases: Options["updateAttachmentLeases"],
  prepareDom?: (dom: ReturnType<typeof installAppDom>["dom"]) => void,
) {
  const { dom } = installAppDom();
  prepareDom?.(dom);
  let heartbeat: () => void = () => { throw new Error("missing attachment heartbeat"); };
  let timerCleared = false;
  dom.window.setInterval = ((callback: () => void, delay: number) => {
    assert.equal(delay, 60_000);
    heartbeat = callback;
    return 11;
  }) as typeof dom.window.setInterval;
  dom.window.clearInterval = (id) => { if (id === 11) timerCleared = true; };
  const { useComposerController } = await import("../../src/web/hooks/use-composer-controller");
  const { createRoot } = await import("react-dom/client");
  let controller!: ReturnType<typeof useComposerController>;
  function Probe() {
    controller = useComposerController({
      draftKey: { kind: "session", sessionId: "attachment-test" }, disabled: false,
      paused: false, allowFollowupSubmissions: true, onSend: async () => {}, updateAttachmentLeases,
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(createElement(Probe)));
  return {
    dom, controller: () => controller,
    async renew() { await act(async () => heartbeat()); },
    async remount() {
      await act(async () => root.render(null));
      await act(async () => root.render(createElement(Probe)));
    },
    async close() { await act(async () => root.unmount()); assert.equal(timerCleared, true); },
  };
}

test("failed attachment leases retry on text edits and online without changing paths or looping", async () => {
  let failing = true;
  let calls = 0;
  const f = await fixture(async () => { calls++; if (failing) throw new Error("offline"); });
  try {
    await act(async () => f.controller().replace("draft", [], ["C:/staged/file.txt"]));
    assert.equal(calls, 1);
    assert.match(f.controller().storageWarning, /未能更新/);
    await act(async () => f.controller().edit("edited draft"));
    assert.equal(calls, 2, "unchanged paths must not suppress a retry after failure");
    assert.match(f.controller().storageWarning, /未能更新/);
    failing = false;
    await act(async () => f.dom.window.dispatchEvent(new f.dom.window.Event("online")));
    assert.equal(calls, 3);
    assert.equal(f.controller().storageWarning, "");
    await act(async () => f.controller().edit("another edit"));
    assert.equal(calls, 3, "healthy unchanged paths do not cause writes on each keystroke");
  } finally { await f.close(); }
});

test("attachment heartbeat renews unchanged live references and removal releases only those paths", async () => {
  const calls: Array<{ paths: string[]; active: boolean; owner: string }> = [];
  const f = await fixture(async (paths, active, owner) => { calls.push({ paths, active, owner }); });
  try {
    await act(async () => f.controller().replace("draft", [], ["C:/staged/file.txt"]));
    await f.renew();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0], "heartbeat uses the same page owner and active reference");
    await act(async () => f.controller().clear());
    assert.deepEqual(calls[2], { ...calls[0], active: false });
    await f.renew();
    assert.equal(calls.length, 3, "empty pages make no renewal calls");
  } finally { await f.close(); }
});

test("a failed lease release retries even when the current draft has no attachment", async () => {
  let failRelease = true;
  const releases: string[][] = [];
  const f = await fixture(async (paths, active) => {
    if (!active) { releases.push(paths); if (failRelease) throw new Error("offline"); }
  });
  try {
    await act(async () => f.controller().replace("draft", [], ["C:/staged/file.txt"]));
    await act(async () => f.controller().clear());
    assert.equal(releases.length, 1);
    failRelease = false;
    await f.renew();
    assert.deepEqual(releases, [["C:/staged/file.txt"], ["C:/staged/file.txt"]]);
    assert.equal(f.controller().storageWarning, "");
  } finally { await f.close(); }
});

test("composer remains memory-only and neither consumes nor erases legacy browser backups", async () => {
  const key = "pi-chat.draft-backup.v1.legacy";
  const saved = JSON.stringify({ privateDraft: "keep until explicitly removed" });
  let databaseReads = 0;
  const f = await fixture(async () => {}, (dom) => {
    // Install before the first mount, so startup discovery/cleanup is covered.
    dom.window.localStorage.setItem(key, saved);
    Object.defineProperty(dom.window, "indexedDB", { configurable: true, get() { databaseReads++; throw new Error("must not open legacy database"); } });
  });
  try {
    const before = { ...f.dom.window.localStorage };
    await act(async () => f.controller().edit("new unsent content"));
    await f.renew();
    assert.equal(f.controller().hasUnsentContent(), true);
    await f.remount();
    assert.equal(f.controller().hasUnsentContent(), false, "a fresh composer does not pretend to recover unsent content");
    assert.equal(f.controller().draft.message, "");
    assert.deepEqual({ ...f.dom.window.localStorage }, before);
    assert.equal(databaseReads, 0);
  } finally { await f.close(); }
  assert.equal(f.dom.window.localStorage.getItem(key), saved);
});
