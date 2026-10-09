import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimePool, type RuntimePoolOptions, type SecondaryRuntime } from "../src/server/runtime-pool";
import { OperationAdmission } from "../src/server/operation-admission";
import { PiChatApp } from "../src/server/app";
import type { PiRpcClient } from "../src/server/rpc-client";
import type { SessionIndex } from "../src/server/session-index";
import type { ResourceManager } from "../src/server/resource-manager";
import { FakeRpc } from "./helpers/server-app-fixture";

function runtime(id: string): SecondaryRuntime {
  return {
    id, cwd: process.cwd(), rpc: { stop: async () => {}, isRunning: () => true, isExitConfirmed: () => true } as unknown as PiRpcClient,
    running: false, queuePaused: false, dispatching: false, promptQueue: [], toolStatus: "", extensionUiPending: false,
    pendingTerminalMessages: [], operationLeases: 0, operationAdmission: new OperationAdmission(), abortGeneration: 0,
    lastUsedAt: 0, unsubscribe() {}, pendingTurnSettings: {},
  };
}
function pool(options: Partial<RuntimePoolOptions> = {}) {
  return new RuntimePool({ now: () => 100, cwd: () => process.cwd(), refreshSessions: async () => {}, pathForId: () => null,
    isClosed: () => false, canSweep: () => true, onSecondaryEvent() {}, activeSessionIds: () => [], broadcast() {},
    secondaryRuntimeIdleMs: 1, ...options });
}

for (const mode of ["orphan", "fenced", "idle"] as const) {
  test(`maintenance preserves a locked empty draft without abandoning lifecycle completion: ${mode}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "pi-chat-maintenance-"));
    const draft = join(root, "draft.jsonl");
    const contents = JSON.stringify({ type: "session", id: "draft", cwd: root }) + "\n";
    await writeFile(draft, contents);
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
    const reclaimed: string[] = [];
    const broadcasts: Record<string, unknown>[] = [];
    const targetPool = pool({
      unlinkDraftFile: async path => { assert.equal(path, draft); throw Object.assign(new Error("locked fixture"), { code: mode === "fenced" ? "EPERM" : "EBUSY" }); },
      onReclaimed: item => { reclaimed.push(item.id); }, broadcast: event => broadcasts.push(event),
    });
    const target = runtime("locked"); target.draftSessionPath = draft;
    const healthy = runtime("healthy");
    if (mode === "orphan") {
      (targetPool as unknown as { orphanedStarts: Set<SecondaryRuntime> }).orphanedStarts.add(target);
    } else {
      if (mode === "fenced") target.operationAdmission.fence();
      targetPool.runtimes.set(target.id, target);
    }
    targetPool.runtimes.set(healthy.id, healthy);
    try {
      await targetPool.sweep();
      assert.equal(await readFile(draft, "utf8"), contents);
      assert.equal(targetPool.size, 0);
      assert.equal(targetPool.transitioningCount, 0);
      assert.ok(reclaimed.includes("healthy"), "one cleanup error cannot skip unrelated maintenance");
      assert.equal(reclaimed.includes("locked"), mode !== "orphan");
      assert.equal(broadcasts.filter(event => event.sessionId === "locked").length, mode === "orphan" ? 0 : 1);
      assert.equal(warnings.length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("overlapping maintenance ticks share one sweep and do not duplicate detach notifications", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let stops = 0;
  let notifications = 0;
  const target = runtime("held");
  target.rpc.stop = async () => { stops++; await held; };
  const targetPool = pool({ onReclaimed: () => { notifications++; } });
  targetPool.runtimes.set(target.id, target);
  const first = targetPool.sweep();
  const second = targetPool.sweep();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(stops, 1);
  assert.equal(notifications, 1);
  await targetPool.sweep();
  assert.equal(notifications, 1);
});

test("maintenance never deletes a nonempty draft or abandons an unconfirmed orphan", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-maintenance-retain-"));
  const path = join(root, "draft.jsonl");
  await writeFile(path, JSON.stringify({ type: "message", id: "user", parentId: null, message: { role: "user", content: "keep" } }) + "\n");
  let deletions = 0;
  const targetPool = pool({ unlinkDraftFile: async () => { deletions++; } });
  const nonempty = runtime("nonempty"); nonempty.draftSessionPath = path;
  targetPool.runtimes.set(nonempty.id, nonempty);
  const orphan = runtime("unconfirmed"); orphan.draftSessionPath = path;
  orphan.rpc.isExitConfirmed = () => false;
  (targetPool as unknown as { orphanedStarts: Set<SecondaryRuntime> }).orphanedStarts.add(orphan);
  try {
    await targetPool.sweep();
    assert.equal(deletions, 0);
    assert.equal(targetPool.transitioningCount, 1);
    assert.match(await readFile(path, "utf8"), /keep/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed sweep releases its single-flight slot for the next maintenance tick", async () => {
  let fail = true;
  const targetPool = pool({ canSweep: () => { if (fail) throw new Error("fixture failure"); return true; } });
  await assert.rejects(targetPool.sweep(), /fixture failure/);
  fail = false;
  await targetPool.sweep();
});

test("a rejected draft probe clears its cache without a detached rejecting finally chain", async t => {
  const targetPool = pool();
  const internals = targetPool as unknown as {
    draftHasMessages(runtime: SecondaryRuntime): Promise<boolean | null>;
    probeDraftHasMessages(runtime: SecondaryRuntime): Promise<boolean | null>;
  };
  let calls = 0;
  t.mock.method(internals, "draftHasMessages", async () => {
    if (++calls === 1) throw new Error("probe fixture failure");
    return false;
  });
  const target = runtime("probe");
  await assert.rejects(internals.probeDraftHasMessages(target), /probe fixture failure/);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(target.draftProbe, undefined);
  assert.equal(await internals.probeDraftHasMessages(target), false);
});

test("the background maintenance timer contains rejected sweeps and continues ticking", async t => {
  let warnings = 0;
  let complete!: () => void;
  const observed = new Promise<void>(resolve => { complete = resolve; });
  t.mock.method(RuntimePool.prototype, "sweep", async () => { throw new Error("maintenance fixture failure"); });
  t.mock.method(console, "warn", () => { if (++warnings === 2) complete(); });
  const app = new PiChatApp({ rpc: new FakeRpc("fixture", "fixture") as unknown as PiRpcClient,
    sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), secondaryRuntimeSweepMs: 100 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([observed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("maintenance was not contained")), 2000); })]);
    assert.ok(warnings >= 2);
  } finally { if (timer) clearTimeout(timer); await app.close(); }
});
