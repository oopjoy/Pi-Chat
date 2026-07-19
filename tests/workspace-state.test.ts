import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadWorkspace, saveWorkspace } from "../src/server/workspace-state";

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
