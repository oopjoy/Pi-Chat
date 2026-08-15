import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SubagentStatusProvider } from "../src/server/subagent-status-provider";

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
