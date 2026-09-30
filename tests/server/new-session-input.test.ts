import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNewSessionInput } from "../../src/server/routes/new-session-input";

test("New Session input accepts a valid first-turn snapshot and defaults to no initial turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-chat-new-input-"));
  try {
    const parsed = await parseNewSessionInput({ cwd }, cwd);
    assert.deepEqual(parsed, {
      kind: "valid",
      cwd,
      initial: null,
      message: "",
      images: [],
      gateMode: undefined,
      clientPromptOperationId: "",
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("New Session input rejects malformed settings before Runtime allocation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-chat-new-input-invalid-"));
  try {
    const result = await parseNewSessionInput({
      cwd,
      initial: { message: "hello", thinkingLevel: "invalid" },
    }, cwd);
    assert.deepEqual(result, { kind: "error", status: 400, error: "无效的 Thinking 强度" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
