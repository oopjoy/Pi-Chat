import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadWorkspace, saveWorkspace } from "../src/server/workspace-state";

test("a fresh portable workspace fallback is the user's Desktop", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-default-"));
  const desktop = join(root, "Desktop");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await mkdir(desktop);
    assert.equal(await loadWorkspace(desktop), resolve(desktop));
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(join(root, "agent", "pi-chat-workspace.json"), JSON.stringify({ cwd: join(root, "missing") }), "utf8");
    assert.equal(await loadWorkspace(desktop), resolve(desktop));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace state persists an existing selected directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-state-"));
  const workspace = join(root, "project");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await mkdir(workspace);
    assert.equal(await loadWorkspace(workspace), resolve(workspace));
    await saveWorkspace(workspace);
    assert.equal(await loadWorkspace(root), resolve(workspace));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
