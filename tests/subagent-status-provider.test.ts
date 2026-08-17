import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { MAX_ROOT_ENTRIES, MAX_STATUS_BYTES, SubagentStatusProvider, SubagentStatusUnavailableError, collectBoundedDirectoryEntries, currentSubagentTempRoot, readBoundedStatusBytes, resolveSubagentTempScopeId } from "../src/server/subagent-status-provider";
import { idForPath } from "../src/server/session-index";

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

test("provider gives terminal steps precedence over stale attention activity", async () => {
  const target = await fixture();
  try {
    const runId = "12121212-1212-4121-8121-121212121212";
    const now = Date.now();
    await target.writeStatus(runId, status(runId, PARENT, {
      state: "complete",
      endedAt: now - 100,
      steps: [
        {
          agent: "reviewer",
          workflowKey: "completed-attention",
          status: "completed",
          activityState: "needs_attention",
          startedAt: now - 2_000,
          lastActivityAt: now - 200,
        },
        {
          agent: "worker",
          workflowKey: "waiting-attention",
          status: "running",
          activityState: "needs_attention",
          startedAt: now - 1_000,
          lastActivityAt: now - 100,
        },
      ],
    }));

    const snapshot = await new SubagentStatusProvider(target.root).listForParentSession(PARENT);
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.activeCount, 0);
    assert.equal(snapshot.attentionCount, 0);
    assert.deepEqual(snapshot.steps.map((step) => step.status), ["complete", "complete"]);
  } finally {
    await target.cleanup();
  }
});

test("provider exposes only a verified opaque child transcript address", async () => {
  const target = await fixture();
  const sessionRoot = await mkdtemp(join(tmpdir(), "pi-chat-subagent-parent-"));
  try {
    const parent = join(sessionRoot, "parent.jsonl");
    const childRoot = join(sessionRoot, "parent", "abc12345", "run-0");
    const child = join(childRoot, "session.jsonl");
    await mkdir(childRoot, { recursive: true });
    await writeFile(parent, JSON.stringify({ type: "session", id: "parent" }));
    await writeFile(child, `${JSON.stringify({ type: "session", id: "child", cwd: sessionRoot })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "inspect" } })}\n`);
    const runId = "abababab-abab-4bab-8bab-abababababab";
    await target.writeStatus(runId, status(runId, parent, {
      steps: [{
        agent: "reviewer",
        workflowKey: "review-child",
        status: "running",
        startedAt: Date.now() - 1_000,
        lastActivityAt: Date.now() - 100,
        sessionFile: child,
      }],
    }));
    const outside = join(sessionRoot, "outside.jsonl");
    await writeFile(outside, `${JSON.stringify({ type: "session", id: "outside" })}\n`);
    const outsideRunId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    await target.writeStatus(outsideRunId, status(outsideRunId, parent, {
      steps: [{
        agent: "reviewer",
        workflowKey: "outside-child",
        status: "running",
        startedAt: Date.now() - 1_000,
        lastActivityAt: Date.now() - 100,
        sessionFile: outside,
      }],
    }));

    const provider = new SubagentStatusProvider(target.root);
    const snapshot = await provider.listForParentSession(parent);
    const verified = snapshot.steps.find((step) => step.label === "review child");
    const rejected = snapshot.steps.find((step) => step.label === "outside child");
    assert.equal(verified?.childSessionId, idForPath(child));
    assert.equal(rejected?.childSessionId, undefined);
    assert.equal(verified?.label, "review child");
    assert.equal(JSON.stringify(snapshot).includes(child), false);
    const navigation = await provider.navigationTargetForParentSession(parent, idForPath(child));
    assert.equal(navigation?.path, process.platform === "win32" ? resolve(child).toLowerCase() : resolve(child));
    assert.equal(navigation?.label, "review child");
    assert.match(navigation?.content || "", /inspect/);
    assert.equal(await provider.navigationTargetForParentSession(OTHER_PARENT, idForPath(child)), null);
  } finally {
    await Promise.all([
      target.cleanup(),
      rm(sessionRoot, { recursive: true, force: true }),
    ]);
  }
});

test("provider revokes a child address when the producer removes it or it expires", async () => {
  const target = await fixture();
  const sessionRoot = await mkdtemp(join(tmpdir(), "pi-chat-subagent-revoke-"));
  let now = Date.now();
  try {
    const parent = join(sessionRoot, "parent.jsonl");
    const child = join(sessionRoot, "parent", "child", "run-0", "session.jsonl");
    await mkdir(resolve(child, ".."), { recursive: true });
    await writeFile(parent, `${JSON.stringify({ type: "session", id: "parent" })}\n`);
    await writeFile(child, `${JSON.stringify({ type: "session", id: "child", cwd: sessionRoot })}\n`);
    const runId = "adadadad-adad-4dad-8dad-adadadadadad";
    const directory = await target.writeStatus(runId, status(runId, parent, {
      startedAt: now - 1_000,
      lastUpdate: now,
      steps: [{
        agent: "reviewer",
        workflowKey: "revocable-child",
        status: "complete",
        startedAt: now - 1_000,
        endedAt: now,
        lastActivityAt: now,
        sessionFile: child,
      }],
    }));
    const provider = new SubagentStatusProvider(target.root, () => now);
    const childId = idForPath(child);
    assert.equal((await provider.listForParentSession(parent)).steps[0]?.childSessionId, childId);
    assert.ok(await provider.navigationTargetForParentSession(parent, childId));

    await writeFile(join(directory, "status.json"), JSON.stringify(status(runId, parent, {
      startedAt: now - 1_000,
      lastUpdate: now,
      steps: [{ agent: "reviewer", workflowKey: "revocable-child", status: "running", startedAt: now - 1_000, lastActivityAt: now }],
    })));
    await utimes(join(directory, "status.json"), new Date(now + 1_000), new Date(now + 1_000));
    assert.equal(await provider.navigationTargetForParentSession(parent, childId), null);
    assert.equal(await provider.knownChildSessionPath(childId), null);

    await writeFile(join(directory, "status.json"), JSON.stringify(status(runId, parent, {
      startedAt: now - 1_000,
      lastUpdate: now,
      steps: [{ agent: "reviewer", workflowKey: "revocable-child", status: "complete", startedAt: now - 1_000, endedAt: now, lastActivityAt: now, sessionFile: child }],
    })));
    await utimes(join(directory, "status.json"), new Date(now + 2_000), new Date(now + 2_000));
    assert.ok((await provider.listForParentSession(parent)).steps[0]?.childSessionId);
    now += 25 * 60 * 60 * 1_000;
    assert.equal(await provider.navigationTargetForParentSession(parent, childId), null);
  } finally {
    await Promise.all([target.cleanup(), rm(sessionRoot, { recursive: true, force: true })]);
  }
});

test("provider reads a verified child through one stable handle and rejects a swap", async () => {
  const target = await fixture();
  const sessionRoot = await mkdtemp(join(tmpdir(), "pi-chat-subagent-swap-"));
  try {
    const parent = join(sessionRoot, "parent.jsonl");
    const child = join(sessionRoot, "parent", "child", "run-0", "session.jsonl");
    const outside = join(sessionRoot, "outside.jsonl");
    await mkdir(resolve(child, ".."), { recursive: true });
    await writeFile(parent, `${JSON.stringify({ type: "session", id: "parent" })}\n`);
    await writeFile(child, `${JSON.stringify({ type: "session", id: "safe-child", cwd: sessionRoot })}\n`);
    await writeFile(outside, `${JSON.stringify({ type: "session", id: "outside", cwd: sessionRoot })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "private replacement" } })}\n`);
    const runId = "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae";
    await target.writeStatus(runId, status(runId, parent, {
      steps: [{ agent: "reviewer", workflowKey: "swap-child", status: "running", startedAt: Date.now() - 1_000, lastActivityAt: Date.now(), sessionFile: child }],
    }));
    let swapped = false;
    const provider = new SubagentStatusProvider(target.root, Date.now, {
      beforeChildSessionOpen: async () => {
        if (swapped) return;
        swapped = true;
        await rename(child, `${child}.verified`);
        await rename(outside, child);
      },
    });
    const childId = (await provider.listForParentSession(parent)).steps[0]?.childSessionId;
    assert.ok(childId);
    assert.equal(await provider.navigationTargetForParentSession(parent, childId!), null);
    assert.equal(swapped, true);
  } finally {
    await Promise.all([target.cleanup(), rm(sessionRoot, { recursive: true, force: true })]);
  }
});

test("provider validates child paths only for the bounded visible projection", async () => {
  const target = await fixture();
  const sessionRoot = await mkdtemp(join(tmpdir(), "pi-chat-subagent-cap-"));
  try {
    const parent = join(sessionRoot, "parent.jsonl");
    const child = join(sessionRoot, "parent", "child", "run-0", "session.jsonl");
    await mkdir(resolve(child, ".."), { recursive: true });
    await writeFile(parent, `${JSON.stringify({ type: "session", id: "parent" })}\n`);
    await writeFile(child, `${JSON.stringify({ type: "session", id: "child", cwd: sessionRoot })}\n`);
    const runId = "afafafaf-afaf-4faf-8faf-afafafafafaf";
    await target.writeStatus(runId, status(runId, parent, {
      steps: Array.from({ length: 40 }, (_, index) => ({
        agent: "reviewer",
        workflowKey: `child-${index}`,
        status: "running",
        startedAt: Date.now() - 1_000,
        lastActivityAt: Date.now() - index,
        sessionFile: child,
      })),
    }));
    let validations = 0;
    const snapshot = await new SubagentStatusProvider(target.root, Date.now, {
      onChildSessionValidation: () => { validations += 1; },
    }).listForParentSession(parent);
    assert.equal(snapshot.total, 40);
    assert.equal(snapshot.steps.length, 24);
    assert.equal(validations, 24);
  } finally {
    await Promise.all([target.cleanup(), rm(sessionRoot, { recursive: true, force: true })]);
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
    await assert.rejects(
      new SubagentStatusProvider(crowded.root).listForParentSession(PARENT),
      SubagentStatusUnavailableError,
    );
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

test("provider retains active steps, expires old terminal steps, and bounds process aliases", async () => {
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
    assert.equal((provider as unknown as { aliases: Map<string, unknown> }).aliases.size, 1, "aliases remain stable for bounded TTL retention");
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
    await assert.rejects(
      new SubagentStatusProvider(root).listForParentSession(PARENT),
      SubagentStatusUnavailableError,
    );
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
    await assert.rejects(
      new SubagentStatusProvider(alias).listForParentSession(PARENT),
      SubagentStatusUnavailableError,
    );
  } finally {
    await Promise.all([rm(parent, { recursive: true, force: true }), outside.cleanup()]);
  }
});

test("bounded filesystem helpers stop at the configured hard limits", async () => {
  let yielded = 0;
  async function* entries() {
    for (let index = 0; index < MAX_ROOT_ENTRIES + 10; index += 1) {
      yielded += 1;
      yield { name: `entry-${index}`, isDirectory: () => false };
    }
  }
  assert.equal(await collectBoundedDirectoryEntries(entries()), null);
  assert.equal(yielded, MAX_ROOT_ENTRIES + 1);

  const requested: number[] = [];
  const oversized = await readBoundedStatusBytes({
    read: async (_buffer, _offset, length) => {
      requested.push(length);
      return { bytesRead: length, buffer: Buffer.alloc(0) };
    },
  });
  assert.equal(oversized, null);
  assert.deepEqual(requested, [MAX_STATUS_BYTES + 1]);
});

test("shared fallback disables production scans", async () => {
  const options = { env: {}, getuid: undefined, userInfo: () => ({}), homedir: () => "", tempDir: () => tmpdir() };
  assert.equal(resolveSubagentTempScopeId(options), "shared");
  const root = currentSubagentTempRoot(options);
  assert.equal(root, null);
  let scans = 0;
  const snapshot = await new SubagentStatusProvider(root, Date.now, { onFilesystemAccess: () => { scans += 1; } })
    .listForParentSession(PARENT);
  assert.equal(snapshot.total, 0);
  assert.equal(scans, 0);
});

test("POSIX ownership and writable-mode checks fail closed", { skip: process.getuid === undefined }, async () => {
  const target = await fixture();
  try {
    const runId = "10101010-1010-4010-8010-101010101010";
    const run = await target.writeStatus(runId, status(runId));
    const statusPath = join(run, "status.json");
    const uid = process.getuid!();
    await assert.rejects(
      new SubagentStatusProvider(target.root, Date.now, { uid: uid + 1 }).listForParentSession(PARENT),
      SubagentStatusUnavailableError,
    );
    for (const [path, restore, rootAuthority] of [
      [target.root, 0o700, true],
      [target.runs, 0o755, true],
      [run, 0o755, false],
      [statusPath, 0o644, false],
    ] as const) {
      await chmod(path, 0o777);
      const request = new SubagentStatusProvider(target.root, Date.now, { uid }).listForParentSession(PARENT);
      if (rootAuthority) await assert.rejects(request, SubagentStatusUnavailableError);
      else assert.equal((await request).total, 0, path);
      await chmod(path, restore);
    }
  } finally {
    await target.cleanup();
  }
});

test("provider accepts producer-shaped empty args and long recent tool history", async () => {
  const target = await fixture();
  try {
    const runId = "20202020-2020-4020-8020-202020202020";
    const now = Date.now();
    await target.writeStatus(runId, status(runId, PARENT, {
      steps: [{
        agent: "worker", status: "running", startedAt: now - 1_000, lastActivityAt: now - 10,
        currentTool: "bash", currentToolArgs: "",
        recentTools: Array.from({ length: 100 }, () => ({ tool: "ls", args: "" })),
      }],
    }));
    const snapshot = await new SubagentStatusProvider(target.root).listForParentSession(PARENT);
    assert.equal(snapshot.total, 1);
    assert.equal(snapshot.steps[0]?.status, "running");
  } finally {
    await target.cleanup();
  }
});

test("provider excludes orchestration placeholders and projects pending children as waiting", async () => {
  const target = await fixture();
  try {
    const runId = "30303030-3030-4030-8030-303030303030";
    const now = Date.now();
    await target.writeStatus(runId, status(runId, PARENT, { steps: [
      { agent: "checkpoint:save", status: "paused", startedAt: now - 500, lastActivityAt: now - 10 },
      { agent: "expand:fanout", status: "pending", startedAt: now - 500, lastActivityAt: now - 10 },
      { agent: "worker", status: "pending", startedAt: now - 500, lastActivityAt: now - 10 },
      { agent: "reviewer", status: "running", startedAt: now - 500, lastActivityAt: now - 10 },
    ] }));
    const snapshot = await new SubagentStatusProvider(target.root).listForParentSession(PARENT);
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.activeCount, 1);
    assert.deepEqual(snapshot.steps.map((step) => step.status), ["running", "waiting"]);
  } finally {
    await target.cleanup();
  }
});

test("large child aggregates keep truthful counts and a bounded priority projection", async () => {
  const target = await fixture();
  try {
    const now = Date.now();
    const states = ["paused", "running", "pending", "failed", "stopped", "complete", ...Array(134).fill("complete")];
    const chunks = [states.slice(0, 50), states.slice(50, 100), states.slice(100)];
    for (const [runIndex, chunk] of chunks.entries()) {
      const runId = `${String(runIndex + 4).repeat(8)}-${String(runIndex + 4).repeat(4)}-4${String(runIndex + 4).repeat(3)}-8${String(runIndex + 4).repeat(3)}-${String(runIndex + 4).repeat(12)}`;
      await target.writeStatus(runId, status(runId, PARENT, { steps: chunk.map((stepStatus, index) => ({
        agent: index % 2 ? "worker" : "reviewer",
        status: stepStatus,
        startedAt: now - 2_000,
        lastActivityAt: now - 100 - index,
        ...(["failed", "stopped", "complete"].includes(stepStatus) ? { endedAt: now - 50 } : {}),
      })) }));
    }
    const snapshot = await new SubagentStatusProvider(target.root, () => now).listForParentSession(PARENT);
    assert.equal(snapshot.total, 140);
    assert.equal(snapshot.activeCount, 1);
    assert.equal(snapshot.attentionCount, 1);
    assert.equal(snapshot.steps.length, 24);
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.steps.slice(0, 6).map((step) => step.status), ["attention", "running", "waiting", "failed", "cancelled", "complete"]);
  } finally {
    await target.cleanup();
  }
});

test("aliases remain stable when parent Sessions are polled alternately", async () => {
  const target = await fixture();
  try {
    const a = "77777777-1111-4111-8111-777777777777";
    const b = "88888888-2222-4222-8222-888888888888";
    await target.writeStatus(a, status(a, PARENT, { steps: [status(a).steps[0]] }));
    await target.writeStatus(b, status(b, OTHER_PARENT, { steps: [status(b).steps[0]] }));
    const provider = new SubagentStatusProvider(target.root);
    const first = (await provider.listForParentSession(PARENT)).steps[0]?.key;
    await provider.listForParentSession(OTHER_PARENT);
    const second = (await provider.listForParentSession(PARENT)).steps[0]?.key;
    assert.equal(second, first);
  } finally {
    await target.cleanup();
  }
});
