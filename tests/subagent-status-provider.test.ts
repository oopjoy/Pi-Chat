import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SubagentStatusProvider, resolveSubagentTempScopeId } from "../src/server/subagent-status-provider";

const PARENT = resolve(tmpdir(), "pi-chat-parent-session.jsonl");
const OTHER_PARENT = resolve(tmpdir(), "pi-chat-other-session.jsonl");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-subagent-status-"));
  const runs = join(root, "async-subagent-runs");
  await mkdir(runs);
  const writeStatus = async (runId: string, value: Record<string, unknown>) => {
    const directory = join(runs, runId);
    await mkdir(directory);
    await writeFile(join(directory, "status.json"), JSON.stringify(value));
    return directory;
  };
  return { root, runs, writeStatus, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function status(runId: string, parent = PARENT, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    runId,
    toolCallId: "call_private_tool_id",
    sessionId: parent,
    mode: "workflow",
    state: "running",
    startedAt: now - 20_000,
    lastUpdate: now - 500,
    cwd: "C:\private\workspace",
    error: "raw private error",
    steps: [
      {
        agent: "worker",
        label: "secret user label",
        status: "running",
        startedAt: now - 18_000,
        lastActivityAt: now - 400,
        currentTool: "bash",
        currentToolArgs: "npm test -- --token secret",
        turnCount: 3,
        toolCount: 7,
        sessionFile: "C:\private\child.jsonl",
        recentOutput: ["private output"],
        error: "private child error",
      },
      {
        agent: "reviewer",
        status: "paused",
        startedAt: now - 12_000,
        lastActivityAt: now - 900,
      },
    ],
    ...overrides,
  };
}

test("provider scopes by exact parent Session path and exposes only closed safe fields", async () => {
  const target = await fixture();
  try {
    const matching = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    await target.writeStatus(matching, status(matching));
    await target.writeStatus(other, status(other, OTHER_PARENT, { cwd: "same cwd is not proof" }));

    const snapshot = await new SubagentStatusProvider(target.root).listForParentSession(PARENT);
    assert.equal(snapshot.total, 2, "actual workflow steps are counted without an outer run row");
    assert.equal(snapshot.activeCount, 1);
    assert.equal(snapshot.attentionCount, 1);
    assert.deepEqual(snapshot.steps.map((step) => step.status), ["attention", "running"]);
    assert.ok(snapshot.steps.every((step) => /^subagent-\d+$/.test(step.key)));
    assert.ok(snapshot.steps.some((step) => step.activity === "正在运行测试"));
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      matching,
      other,
      "call_private_tool_id",
      "private",
      "secret",
      PARENT,
      OTHER_PARENT,
      "npm test",
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  } finally {
    await target.cleanup();
  }
});

test("provider ignores malformed, unknown, oversized, stale-shape, and non-UUID run entries", async () => {
  const target = await fixture();
  try {
    const malformed = "33333333-3333-4333-8333-333333333333";
    const unknown = "44444444-4444-4444-8444-444444444444";
    const badSteps = "55555555-5555-4555-8555-555555555555";
    await target.writeStatus(malformed, { nope: true });
    await target.writeStatus(unknown, status(unknown, PARENT, { state: "mystery" }));
    await target.writeStatus(badSteps, status(badSteps, PARENT, { steps: [{ agent: "worker", status: "teleported" }] }));
    const shortDirectory = join(target.runs, "deadbeef");
    await mkdir(shortDirectory);
    await writeFile(join(shortDirectory, "status.json"), JSON.stringify(status("deadbeef")));
    const oversized = "66666666-6666-4666-8666-666666666666";
    const oversizedDirectory = join(target.runs, oversized);
    await mkdir(oversizedDirectory);
    await writeFile(join(oversizedDirectory, "status.json"), "x".repeat(256 * 1024 + 1));

    assert.deepEqual(await new SubagentStatusProvider(target.root).listForParentSession(PARENT), {
      total: 0,
      activeCount: 0,
      attentionCount: 0,
      truncated: false,
      steps: [],
    });
  } finally {
    await target.cleanup();
  }
});

test("provider rejects symlinked status files", async (context) => {
  const target = await fixture();
  try {
    const runId = "77777777-7777-4777-8777-777777777777";
    const directory = join(target.runs, runId);
    await mkdir(directory);
    const outside = join(target.root, "outside.json");
    await writeFile(outside, JSON.stringify(status(runId)));
    try {
      await symlink(outside, join(directory, "status.json"), "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOTSUP"].includes(code || "")) {
        context.skip(`file symlink creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    const snapshot = await new SubagentStatusProvider(target.root).listForParentSession(PARENT);
    assert.equal(snapshot.total, 0);
  } finally {
    await target.cleanup();
  }
});


test("provider rejects symlinked run directories", async (context) => {
  const target = await fixture();
  const outsideRoot = await mkdtemp(join(tmpdir(), "pi-chat-subagent-outside-"));
  try {
    const runId = "88888888-8888-4888-8888-888888888888";
    await writeFile(join(outsideRoot, "status.json"), JSON.stringify(status(runId)));
    try {
      await symlink(outsideRoot, join(target.runs, runId), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOTSUP"].includes(code || "")) {
        context.skip(`directory symlink creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    const snapshot = await new SubagentStatusProvider(target.root).listForParentSession(PARENT);
    assert.equal(snapshot.total, 0);
  } finally {
    await Promise.all([target.cleanup(), rm(outsideRoot, { recursive: true, force: true })]);
  }
});


test("provider enforces status age and root entry count bounds", async () => {
  const aged = await fixture();
  try {
    const runId = "99999999-9999-4999-8999-999999999999";
    const directory = await aged.writeStatus(runId, status(runId));
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await utimes(join(directory, "status.json"), old, old);
    assert.equal((await new SubagentStatusProvider(aged.root).listForParentSession(PARENT)).total, 0);
  } finally {
    await aged.cleanup();
  }

  const crowded = await fixture();
  try {
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await crowded.writeStatus(runId, status(runId));
    await Promise.all(Array.from({ length: 512 }, (_, index) =>
      writeFile(join(crowded.runs, `ignored-${index}`), "x")));
    assert.equal((await new SubagentStatusProvider(crowded.root).listForParentSession(PARENT)).total, 0);
  } finally {
    await crowded.cleanup();
  }
});


test("temp scope resolution mirrors pi-subagents fallbacks", () => {
  assert.equal(resolveSubagentTempScopeId({ env: {}, getuid: () => 42 }), "uid-42");
  assert.equal(resolveSubagentTempScopeId({ env: { USERNAME: "A User" }, getuid: undefined }), "user-A-User");
  assert.equal(resolveSubagentTempScopeId({ env: {}, getuid: undefined, userInfo: () => ({ username: "fallback" }) }), "user-fallback");
  assert.equal(resolveSubagentTempScopeId({ env: { USERPROFILE: String.raw`C:\Users\A B` }, getuid: undefined, userInfo: () => { throw new Error("no user"); } }), "home-C-Users-A-B");
  assert.equal(resolveSubagentTempScopeId({ env: {}, getuid: undefined, userInfo: () => ({}), homedir: () => "/home/fallback" }), "home-home-fallback");
  assert.equal(resolveSubagentTempScopeId({ env: {}, getuid: undefined, userInfo: () => ({}), homedir: () => "" }), "shared");
});

test("provider rejects unsafe timestamps and keeps serialized durations finite", async () => {
  const target = await fixture();
  const now = Date.now();
  try {
    const bad = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const good = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await target.writeStatus(bad, status(bad, PARENT, { startedAt: Number.MAX_VALUE }));
    await target.writeStatus(good, status(good, PARENT, {
      startedAt: now - 10_000,
      lastUpdate: now - 100,
      steps: [{ agent: "worker", status: "running", startedAt: now - 9_000, lastActivityAt: now - 50 }],
    }));
    const snapshot = await new SubagentStatusProvider(target.root, () => now).listForParentSession(PARENT);
    assert.equal(snapshot.total, 1);
    assert.ok(snapshot.steps.every((step) => Number.isSafeInteger(step.elapsedMs) && step.elapsedMs >= 0));
    assert.ok(snapshot.steps.every((step) => Number.isSafeInteger(step.updateAgeMs) && step.updateAgeMs >= 0));
    assert.equal(JSON.stringify(snapshot).includes("null"), false);
  } finally {
    await target.cleanup();
  }
});

test("provider retains active steps, expires old terminal steps, and prunes process aliases", async () => {
  const target = await fixture();
  const now = Date.now();
  try {
    const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const directory = await target.writeStatus(runId, status(runId, PARENT, {
      startedAt: now - 26 * 60 * 60 * 1_000,
      lastUpdate: now - 1_000,
      steps: [
        { agent: "worker", status: "running", startedAt: now - 26 * 60 * 60 * 1_000, lastActivityAt: now - 25 * 60 * 60 * 1_000 },
        { agent: "reviewer", status: "complete", startedAt: now - 26 * 60 * 60 * 1_000, endedAt: now - 25 * 60 * 60 * 1_000, lastActivityAt: now - 25 * 60 * 60 * 1_000 },
      ],
    }));
    const provider = new SubagentStatusProvider(target.root, () => now);
    const snapshot = await provider.listForParentSession(PARENT);
    assert.equal(snapshot.total, 1);
    assert.equal(snapshot.steps[0]?.status, "running");
    assert.equal((provider as unknown as { aliases: Map<string, number> }).aliases.size, 1);
    await rm(directory, { recursive: true, force: true });
    await provider.listForParentSession(PARENT);
    assert.equal((provider as unknown as { aliases: Map<string, number> }).aliases.size, 0);
    assert.equal((provider as unknown as { statusCache: Map<string, unknown> }).statusCache.size, 0);
  } finally {
    await target.cleanup();
  }
});

test("provider rejects a redirected async root", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-subagent-root-link-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-chat-subagent-root-outside-"));
  try {
    const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await mkdir(join(outside, runId));
    await writeFile(join(outside, runId, "status.json"), JSON.stringify(status(runId)));
    try {
      await symlink(outside, join(root, "async-subagent-runs"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOTSUP"].includes(code || "")) {
        context.skip(`directory symlink creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    assert.equal((await new SubagentStatusProvider(root).listForParentSession(PARENT)).total, 0);
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test("provider rejects a redirected approved temp root", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "pi-chat-subagent-root-parent-"));
  const outside = await fixture();
  const alias = join(parent, "root-alias");
  try {
    const runId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await outside.writeStatus(runId, status(runId));
    try {
      await symlink(outside.root, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOTSUP"].includes(code || "")) {
        context.skip(`directory symlink creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    assert.equal((await new SubagentStatusProvider(alias).listForParentSession(PARENT)).total, 0);
  } finally {
    await Promise.all([rm(parent, { recursive: true, force: true }), outside.cleanup()]);
  }
});
