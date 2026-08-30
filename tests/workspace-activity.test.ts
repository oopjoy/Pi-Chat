import assert from "node:assert/strict";
import test from "node:test";
import {
  workspaceFileActivityParts,
  workspaceFileActivityRevision,
  workspaceFileActivityRevisionFromParts,
} from "../src/web/lib/workspace-activity";

const editCall = (id: string) => ({
  role: "assistant" as const,
  content: [{ type: "toolCall" as const, id, name: "edit", arguments: {} }],
});

const result = (toolCallId: string, isError = false) => ({
  role: "toolResult" as const,
  toolCallId,
  content: "done",
  isError,
});

test("workspace activity revision retains the existing bounded token format", () => {
  assert.deepEqual(workspaceFileActivityParts([editCall("edit-1"), result("edit-1")]), [
    "call:edit-1",
    "result:edit-1:ok",
  ]);
  assert.equal(
    workspaceFileActivityRevision([editCall("edit-1"), result("edit-1")]),
    "call:edit-1|result:edit-1:ok",
  );
});

test("live activity composes with cached persisted parts without changing the revision", () => {
  const persisted = [editCall("edit-1"), result("edit-1")];
  const persistedParts = workspaceFileActivityParts(persisted);
  const liveParts = workspaceFileActivityParts([result("edit-1", true)]);
  assert.equal(
    workspaceFileActivityRevisionFromParts(persistedParts, liveParts),
    workspaceFileActivityRevision([...persisted, result("edit-1", true)]),
  );
});

test("workspace activity keeps only the latest one hundred tokens", () => {
  const parts = Array.from({ length: 101 }, (_, index) => `call:edit-${index}`);
  assert.equal(workspaceFileActivityRevisionFromParts(parts), parts.slice(1).join("|"));
});
